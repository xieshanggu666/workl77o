<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useRetirementStore } from '@/stores/retirement'
import RichEditor from '@/components/doc/RichEditor.vue'
import { docVersion, fieldLabels } from '@/utils/version'
import { canEditDoc, ROLE, GUEST_ID } from '@/utils/permission'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const accessStore = useAccessStore()
const freshnessStore = useFreshnessStore()
const retirementStore = useRetirementStore()

const isEdit = computed(() => route.params.id && route.params.id !== 'new')
const editingDoc = ref(null)

const title = ref('')
const categoryId = ref('')
const tagIds = ref([])
const visibility = ref('public')
const body = ref('')
const stats = ref({ chars: 0, words: 0, imgs: 0 })
const draftKey = 'kb:draft:' + route.params.id
const backupKey = 'kb:conflict-backup:' + route.params.id
const savedToast = ref('')
const saving = ref(false)
// 提交模式：save 直接保存为新版本（原行为）；review 保存即发起评审，审批通过后才发布；
// fresh 知识保鲜整改：修订后送当轮复核，管理员复核通过恢复引用并重算周期
const submitMode = ref(route.query.freshReview ? 'fresh' : route.query.submitReview ? 'review' : 'save')
const reviewNote = ref('')
// 知识保鲜当前流转复核单（fresh 模式下送审目标）
const freshTicket = ref(null)
// 文档当前是否处于评审中（非管理员进入时只读锁定）
const lockedByReview = ref(false)
const activeReview = ref(null)
// 无编辑权限（非拥有者/协作成员，且无有效限时协作授权，或授权已撤销/到期）
const accessDenied = ref(false)
// 当前用户的有效限时授权（限时协作成员可编辑，但不能发起评审）
const activeGrant = ref(null)
// 乐观锁基线：打开编辑器时的版本号与字段快照，保存时据此检测并合并并发修改
const baseVersion = ref(null)
const baseDoc = ref(null)
// 保存冲突信息（含冲突字段与自动合并字段），非空时展示冲突处理条
const conflict = ref(null)
// 冲突时自动备份的未提交内容，保证任何情况下都不丢失
const backup = ref(null)

const tagChecked = (id) => tagIds.value.includes(id)
function toggleTag(id) {
  tagIds.value = tagIds.value.includes(id) ? tagIds.value.filter((x) => x !== id) : [...tagIds.value, id]
}
async function addNewTag() {
  const name = prompt('新标签名称：')
  if (!name) return
  const t = await kb.addTag(name.trim())
  toggleTag(t.id)
}
async function addNewCat() {
  const name = prompt('新分类名称：')
  if (!name) return
  const c = await kb.addCategory(name.trim())
  categoryId.value = c.id
}

function saveDraft() {
  localStorage.setItem(draftKey, JSON.stringify({ title: title.value, categoryId: categoryId.value, tagIds: tagIds.value, visibility: visibility.value, body: body.value, ts: Date.now() }))
}

// 记录基线快照（版本号 + 字段），保存时用于三方合并
function snapshotBase(d) {
  baseVersion.value = docVersion(d)
  baseDoc.value = { title: d.title, categoryId: d.categoryId, tagIds: [...(d.tagIds || [])], visibility: d.visibility, body: d.body }
}

function applyDoc(d) {
  editingDoc.value = d
  title.value = d.title; categoryId.value = d.categoryId; tagIds.value = [...(d.tagIds || [])]
  visibility.value = d.visibility; body.value = d.body
  snapshotBase(d)
}

// 冲突时把当前未提交内容备份到 localStorage，任何后续操作都不会将其覆盖
function saveBackup() {
  const b = { title: title.value, categoryId: categoryId.value, tagIds: [...tagIds.value], visibility: visibility.value, body: body.value, ts: Date.now() }
  localStorage.setItem(backupKey, JSON.stringify(b))
  backup.value = b
}
function restoreBackup() {
  const b = backup.value
  if (!b) return
  title.value = b.title; categoryId.value = b.categoryId; tagIds.value = [...(b.tagIds || [])]
  visibility.value = b.visibility; body.value = b.body
  dismissBackup()
  savedToast.value = '已恢复你未提交的内容'
  setTimeout(() => { savedToast.value = '' }, 2500)
}
function dismissBackup() {
  backup.value = null
  localStorage.removeItem(backupKey)
}

async function submit(force = false) {
  if (!title.value.trim()) { alert('请填写标题'); return }
  if (saving.value) return
  saving.value = true
  try {
    const payload = { title: title.value.trim(), categoryId: categoryId.value, tagIds: [...tagIds.value], visibility: visibility.value, body: body.value }
    if (isEdit.value) {
      // 知识保鲜整改：修订内容作为当轮复核快照送审，管理员复核通过后恢复引用并重算周期
      if (submitMode.value === 'fresh') {
        const res = await freshnessStore.submitFreshReview(route.params.id, payload, reviewNote.value.trim(), false, auth.user)
        if (res.status === 'ok') {
          dismissBackup()
          localStorage.removeItem(draftKey)
          router.push({ path: '/docs/' + route.params.id, query: { freshSubmitted: '1' } })
        } else if (res.status === 'duplicate') {
          alert('该文档已有流转中的评审单，请等待管理员处理。')
        } else if (res.status === 'no-ticket') {
          alert('该文档当前没有待整改的保鲜复核单，无需送审。')
        } else if (res.status === 'missing') {
          alert('文档不存在或已被删除')
        } else if (res.status === 'guest') {
          alert('访客不能发起保鲜复核，请先登录。')
        } else {
          alert('你没有该文档的复核送审权限：仅拥有者、协作成员或管理员可送审。')
        }
        return
      }
      // 评审模式：不直接写正文，而是把当前编辑内容作为快照发起评审，通过后才发布
      if (submitMode.value === 'review') {
        const res = await reviewStore.submitReview(route.params.id, payload, reviewNote.value.trim(), auth.user)
        if (res.status === 'ok') {
          dismissBackup()
          localStorage.removeItem(draftKey)
          router.push({ path: '/docs/' + route.params.id, query: { reviewSubmitted: '1' } })
        } else if (res.status === 'duplicate') {
          alert('该文档已有流转中的评审单，请等待管理员审批后再发起。')
        } else if (res.status === 'missing') {
          alert('文档不存在或已被删除')
        } else if (res.status === 'guest') {
          alert('访客不能发起评审，请先登录。')
        } else {
          alert('你没有该文档的评审发起权限：仅拥有者、协作成员或管理员可发起。')
        }
        return
      }
      const res = await kb.updateDoc(route.params.id, payload, auth.user, '编辑文档', { baseVersion: baseVersion.value, base: baseDoc.value, force })
      if (!res || res.status === 'missing') { alert('文档不存在或已被删除'); return }
      if (res.status === 'guest') { alert('访客不能编辑文档，请通过有效的可编辑共享链接访问或登录。'); return }
      if (res.status === 'access-denied') { alert('你没有该文档的编辑权限：限时协作授权已被撤销或到期，编辑权限已收回。'); await load(); return }
      if (res.status === 'review-locked') { alert('该文档正在评审中，审批完成前无法保存修改。'); await load(); return }
      if (res.status === 'conflict') {
        // 保留未提交内容：内容留在编辑器中，同时写入备份
        conflict.value = res
        saveBackup()
        return
      }
      conflict.value = null
      dismissBackup()
      localStorage.removeItem(draftKey)
      const query = res.autoMerged?.length ? { merged: fieldLabels(res.autoMerged).join('、') } : {}
      router.push({ path: '/docs/' + route.params.id, query })
    } else {
      const d = await kb.createDoc(payload, auth.user)
      if (d.status === 'forbidden') { alert('访客或只读成员不能新建文档。'); return }
      localStorage.removeItem(draftKey)
      // 从缺口工单「新建文档补写」进入：发布文档后回到工单中心继续关联送审
      if (route.query.gap) {
        router.push({ path: '/gaps', query: { pick: route.query.gap, doc: d.id } })
      } else {
        router.push('/docs/' + d.id)
      }
    }
  } finally {
    saving.value = false
  }
}

// 载入库中最新版本继续编辑；未提交内容已备份，可随时恢复
async function loadLatest() {
  const d = await kb.getDocFresh(route.params.id)
  if (!d) { alert('文档不存在或已被删除'); return }
  applyDoc(d)
  conflict.value = null
  savedToast.value = '已载入最新版本，你未提交的内容已保留在备份中'
  setTimeout(() => { savedToast.value = '' }, 3000)
}

function doCancel() {
  if (isEdit.value) router.push('/docs/' + route.params.id)
  else router.push('/docs')
}

function manualSave() {
  saveDraft()
  savedToast.value = '已保存草稿 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  setTimeout(() => { savedToast.value = '' }, 2000)
}

async function load() {
  if (isEdit.value) {
    // 直接读库取最新文档作为编辑基线，避免基于内存缓存的旧快照保存
    const d = await kb.getDocFresh(route.params.id)
    if (d) applyDoc(d)
    // 评审中：非管理员进入编辑器只读锁定，引导前往详情查看评审
    await reviewStore.loadAll()
    const active = reviewStore.pendingReviewOf(route.params.id)
    activeReview.value = active
    lockedByReview.value = !!active && auth.user?.role !== ROLE.ADMIN
    // 知识保鲜：取当前流转复核单，fresh 模式失效（已送审/无单）时回退直接保存模式
    await freshnessStore.loadAll()
    freshTicket.value = d ? freshnessStore.activeTicketOf(d.id) : null
    if (route.query.freshReview && (!freshTicket.value || freshTicket.value.status === 'submitted')) {
      submitMode.value = 'save'
    }
    // 编辑权限：拥有者/固定协作成员/持有效限时协作授权；授权撤销或到期后进入即被收回；
    // 已退役文档为只读归档，任何身份都不可再编辑（需先撤销退役）
    await retirementStore.loadAll()
    const activeRetirement = d ? retirementStore.activeRetirementOfDoc(d.id) : null
    activeGrant.value = d ? accessStore.grantOf(d.id, auth.user?.id) : null
    accessDenied.value = d
      ? !canEditDoc(d, { userId: auth.user?.id || GUEST_ID, role: auth.user?.role, grant: activeGrant.value, pendingReview: active, activeRetirement })
      : false
    // 限时协作授权的只读成员没有「发起评审」通道，强制直接保存模式
    if (activeGrant.value && auth.user?.role !== ROLE.ADMIN && auth.user?.role !== ROLE.EDITOR) {
      submitMode.value = 'save'
    }
    // 上次冲突时备份的未提交内容，重新进入编辑器时提示可恢复
    const b = localStorage.getItem(backupKey)
    if (b) { try { backup.value = JSON.parse(b) } catch { localStorage.removeItem(backupKey) } }
  } else {
    const draft = localStorage.getItem(draftKey)
    if (draft) {
      const p = JSON.parse(draft)
      title.value = p.title || ''
      categoryId.value = p.categoryId || kb.categories[0]?.id || ''
      tagIds.value = p.tagIds || []
      visibility.value = p.visibility || 'public'
      body.value = p.body || ''
    } else {
      // 缺口工单「新建文档补写」：以工单问题作为初始标题
      if (route.query.title) title.value = String(route.query.title).slice(0, 80)
      if (kb.categories[0]) categoryId.value = kb.categories[0].id
    }
  }
}

const saveTimer = ref(null)
function scheduleAutoSave() {
  clearTimeout(saveTimer.value)
  saveTimer.value = setTimeout(() => {
    saveDraft()
    savedToast.value = '草稿已自动保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    setTimeout(() => { savedToast.value = '' }, 2000)
  }, 1200)
}
watch([title, categoryId, tagIds, visibility, body], scheduleAutoSave, { deep: true })

onMounted(load)
onBeforeUnmount(() => { clearTimeout(saveTimer.value); if (!isEdit.value) saveDraft() })

const canPublish = computed(() => title.value.trim() && categoryId.value)
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u.name])))
// 仅靠限时协作授权获得编辑资格的只读成员：可直接保存，不走角色专属的「发起评审」通道
const isGrantOnly = computed(() => {
  if (!editingDoc.value || !activeGrant.value) return false
  if (auth.user?.role === ROLE.ADMIN || auth.user?.role === ROLE.EDITOR) return false
  return editingDoc.value.ownerId !== auth.user?.id && !(editingDoc.value.editors || []).includes(auth.user?.id)
})
// 可编辑：未被评审锁定、未被授权收回
const editableNow = computed(() => !lockedByReview.value && !accessDenied.value)
</script>

<template>
  <div class="editor-page">
    <div class="toolbar row">
      <button class="btn" @click="doCancel">← 返回</button>
      <span class="mode-badge">{{ isEdit ? '编辑文档' : '新建文档' }}</span>
      <span class="toast">{{ savedToast }}</span>
      <div class="spacer"></div>
      <template v-if="isEdit && !lockedByReview && !accessDenied">
        <div class="mode-seg" v-if="!isGrantOnly" title="直接保存立即生效；发起评审/保鲜复核则由管理员审批通过后发布">
          <button :class="{ on: submitMode === 'save' }" @click="submitMode = 'save'">直接保存</button>
          <button :class="{ on: submitMode === 'review' }" @click="submitMode = 'review'">发起评审</button>
          <button v-if="freshTicket && freshTicket.status !== 'submitted'" :class="{ on: submitMode === 'fresh' }" @click="submitMode = 'fresh'">🧊 保鲜整改</button>
        </div>
        <span v-else class="grant-hint" title="限时协作授权：可直接编辑保存，审批发布由文档编辑者发起">🔑 限时协作授权中</span>
        <button class="btn" @click="manualSave">保存草稿</button>
        <button class="btn primary" :disabled="!canPublish || saving" @click="submit()">
          {{ saving ? '提交中…' : (submitMode === 'fresh' ? '提交保鲜复核' : submitMode === 'review' ? '提交评审' : isEdit ? '保存变更' : '发布文档') }}
        </button>
      </template>
    </div>

    <div v-if="accessDenied" class="card deny-bar">
      <div class="lock-head">⛔ 你没有编辑该文档的权限</div>
      <div class="lock-desc">
        仅文档拥有者、协作成员或持有效「限时协作」授权的成员可编辑。
        若授权已到期或被撤销，请前往文档详情页重新申请访问。
      </div>
      <div class="lock-actions">
        <button class="btn sm primary" @click="router.push('/docs/' + route.params.id)">前往文档详情申请</button>
      </div>
    </div>

    <div v-if="lockedByReview" class="card lock-bar">
      <div class="lock-head">🔒 文档评审中，暂不可编辑</div>
      <div class="lock-desc">
        该文档有一条待管理员审批的评审单（由 {{ activeReview ? userById[activeReview.submittedBy] : '' }} 发起），
        正文已锁定；审批通过后将发布新版本，驳回则保持当前内容。
      </div>
      <div class="lock-actions">
        <button class="btn sm primary" @click="router.push('/docs/' + route.params.id)">查看评审详情</button>
      </div>
    </div>

    <div v-if="conflict" class="card conflict-bar">
      <div class="c-head">⚠️ 保存冲突：这篇文档已在其他窗口被修改并保存</div>
      <div class="c-desc">
        冲突字段：{{ fieldLabels(conflict.conflictFields).join('、') }}<template v-if="conflict.autoMerged?.length">；已自动合并：{{ fieldLabels(conflict.autoMerged).join('、') }}</template>。
        你当前未提交的内容已自动备份，不会丢失。
      </div>
      <div class="c-actions">
        <button class="btn sm danger-solid" :disabled="saving" @click="submit(true)">以我的内容覆盖保存</button>
        <button class="btn sm" @click="loadLatest">载入最新版本</button>
        <button class="btn sm ghost" @click="conflict = null">继续编辑</button>
      </div>
    </div>

    <div v-if="backup && !conflict" class="card backup-bar">
      <span>检测到你有一份未提交的修改（{{ new Date(backup.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}）</span>
      <div class="c-actions">
        <button class="btn sm primary" @click="restoreBackup">恢复</button>
        <button class="btn sm ghost" @click="dismissBackup">忽略</button>
      </div>
    </div>

    <div class="form card" :class="{ locked: lockedByReview || accessDenied }">
      <div class="field title-field">
        <input class="big-title" v-model="title" placeholder="文档标题…" maxlength="80" />
      </div>

      <div class="field row-auto">
        <label>分类</label>
        <div class="chips">
          <span v-for="c in kb.categories" :key="c.id" class="chip" :class="{ on: categoryId === c.id }" @click="categoryId = c.id">{{ c.name }}</span>
          <button class="chip add" @click="addNewCat">＋ 新建分类</button>
        </div>
      </div>

      <div class="field row-auto">
        <label>标签</label>
        <div class="chips">
          <span v-for="t in kb.tags" :key="t.id" class="chip" :class="{ on: tagChecked(t.id) }" :style="tagChecked(t.id) ? { background: t.color, borderColor: t.color, color: '#fff' } : {}" @click="toggleTag(t.id)">#{{ t.name }}</span>
          <button class="chip add" @click="addNewTag">＋ 新建标签</button>
        </div>
      </div>

      <div class="field row-auto">
        <label>可见性</label>
        <div class="chips">
          <span class="chip" :class="{ on: visibility === 'public' }" @click="visibility = 'public'">🌐 公开</span>
          <span class="chip" :class="{ on: visibility === 'team' }" @click="visibility = 'team'">👥 团队</span>
          <span class="chip" :class="{ on: visibility === 'private' }" @click="visibility = 'private'">🔒 私有</span>
        </div>
      </div>

      <div v-if="isEdit && (submitMode === 'review' || submitMode === 'fresh') && !lockedByReview && !isGrantOnly" class="field">
        <label class="rv-label">{{ submitMode === 'fresh' ? '保鲜复核说明' : '评审说明' }}</label>
        <textarea v-model="reviewNote" rows="2" :placeholder="submitMode === 'fresh' ? '向管理员说明本次保鲜修订要点（会作为复核意见留痕，可选）' : '向管理员说明本次修改要点（会作为首条评审意见留痕，可选）'"></textarea>
        <div class="rv-hint" v-if="submitMode === 'fresh'">提交后进入「保鲜复核中」并锁定正文，管理员复核通过后修订生效、问答引用恢复并按周期重新计时；驳回则继续整改。</div>
        <div class="rv-hint" v-else>提交后文档进入「评审中」并锁定当前正文，审批通过后以上内容与可见性才会生效。</div>
      </div>
    </div>

    <div class="card editor-wrap" :class="{ locked: lockedByReview || accessDenied }">
      <RichEditor v-model="body" :disabled="lockedByReview || accessDenied" @stats="stats = $event" />
    </div>
    <div class="statline">正文 {{ stats.chars }} 字 · {{ stats.words }} 词 · 图片 {{ stats.imgs }} 张</div>
  </div>
</template>

<style scoped>
.editor-page { max-width: 860px; margin: 0 auto; }
.toolbar.row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.mode-badge { font-weight: 600; color: var(--text-2); }
.toast { color: var(--accent); font-size: 12px; }
.spacer { flex: 1; }
.form { padding: 20px 24px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.field.row-auto { flex-direction: row; align-items: center; gap: 14px; }
.field label { font-size: 13px; color: var(--text-2); width: 60px; }
.big-title { width: 100%; border: none; outline: none; font-size: 26px; font-weight: 700; color: var(--text); padding: 6px 0; border-bottom: 2px solid var(--border); }
.big-title:focus { border-color: var(--primary); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; font-size: 13px; transition: all 0.15s; }
.chip.on { background: var(--primary); border-color: var(--primary); color: #fff; }
.chip.add { border-style: dashed; color: var(--text-3); background: transparent; }
.editor-wrap { padding: 0; overflow: hidden; }
.statline { color: var(--text-3); font-size: 12px; margin-top: 8px; padding-left: 4px; }
.conflict-bar { padding: 14px 20px; margin-bottom: 14px; border-color: var(--warn); background: #fff7ed; }
.conflict-bar .c-head { font-weight: 600; color: #b45309; margin-bottom: 6px; }
.conflict-bar .c-desc { font-size: 13px; color: var(--text-2); margin-bottom: 10px; }
.conflict-bar .c-actions { display: flex; gap: 8px; }
.btn.danger-solid { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn.danger-solid:hover { background: #d9444b; color: #fff; }
.backup-bar { padding: 10px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: var(--text-2); border-color: var(--primary); background: var(--primary-weak); }
.backup-bar .c-actions { display: flex; gap: 8px; }
.mode-seg { display: flex; background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.mode-seg button { border: none; background: transparent; padding: 6px 12px; cursor: pointer; color: var(--text-3); font-size: 13px; }
.mode-seg button.on { background: var(--panel); color: var(--primary); font-weight: 600; box-shadow: inset 0 -2px 0 var(--primary); }
.rv-label { width: auto !important; font-weight: 600; color: var(--text); }
.field textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
.field textarea:focus { border-color: var(--primary); }
.rv-hint { font-size: 12px; color: var(--warn); }
.lock-bar { padding: 16px 22px; margin-bottom: 14px; border-color: #f59e0b; background: #fffbeb; }
.lock-head { font-weight: 600; color: #b45309; margin-bottom: 6px; }
.lock-desc { font-size: 13px; color: var(--text-2); margin-bottom: 10px; }
.lock-actions { display: flex; gap: 8px; }
.deny-bar { border-color: var(--danger); background: #fff5f5; margin-bottom: 14px; }
.deny-bar .lock-head { color: var(--danger); }
.grant-hint { color: #9333ea; font-size: 12px; white-space: nowrap; }
.form.locked, .editor-wrap.locked { opacity: 0.7; pointer-events: none; }
</style>