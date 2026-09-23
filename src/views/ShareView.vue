<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useRetirementStore } from '@/stores/retirement'
import DocPill from '@/components/common/DocPill.vue'
import RichEditor from '@/components/doc/RichEditor.vue'
import { formatFull } from '@/utils/format'
import { shareStatus } from '@/utils/share'
import { canEditDoc, GUEST_ID } from '@/utils/permission'
import { docVersion } from '@/utils/version'

const route = useRoute()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const retirementStore = useRetirementStore()

const share = ref(null)
const doc = ref(null)
const status = ref('loading')

const editing = ref(false)
const editBody = ref('')
const saving = ref(false)
// 乐观锁基线：开始编辑时的版本号与正文快照
const baseVersion = ref(null)
const baseDoc = ref(null)
// 保存冲突信息；冲突时未提交内容保留在编辑器并写入本地备份
const conflict = ref(null)
const backup = ref(null)
const savedToast = ref('')

const token = computed(() => route.params.token)
const backupKey = computed(() => 'kb:share-backup:' + (doc.value?.id || ''))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
// 编辑入口与链接状态、评审锁定统一走 canEditDoc：撤销/过期/评审锁定立即失去编辑权限
const editable = computed(() => canEditDoc(doc.value, {
  userId: GUEST_ID,
  role: null,
  share: share.value,
  pendingReview: reviewStore.pendingReviewOf(doc.value?.id)
}))
const reviewLockedShare = computed(() => !!reviewStore.pendingReviewOf(doc.value?.id))
// 共享文档在分享后被退役：链接（若仍有效）只能查看只读归档，编辑入口随退役关闭，
// 并提示访客通过知识库登录后查看替代文档（无权限时走访问申请）
const retiredShare = computed(() => (doc.value ? retirementStore.activeRetirementOfDoc(doc.value.id) : null))
const replacementOfShare = computed(() =>
  retiredShare.value ? kb.docs.find((d) => d.id === retiredShare.value.replacementDocId) || null : null
)

async function resolve(tokenVal) {
  status.value = 'loading'
  share.value = null
  doc.value = null
  editing.value = false
  conflict.value = null
  await Promise.all([reviewStore.loadAll(), retirementStore.loadAll()])
  const s = await db.shares.where('token').equals(tokenVal).first()
  if (!s) { status.value = 'notfound'; return }
  const st = shareStatus(s)
  if (st === 'revoked') { status.value = 'revoked'; return }
  if (st === 'expired') { status.value = 'expired'; return }
  // 直接读库，保证展示与编辑基线都是最新版本
  const d = await kb.getDocFresh(s.docId)
  if (!d) { status.value = 'notfound'; return }
  share.value = s
  doc.value = d
  status.value = 'ok'
  const b = localStorage.getItem(backupKey.value)
  if (b) { try { backup.value = JSON.parse(b) } catch { localStorage.removeItem(backupKey.value) } }
}

async function startEdit() {
  // 开始编辑前取一次最新文档作为合并基线
  const fresh = await kb.getDocFresh(doc.value.id)
  if (fresh) doc.value = fresh
  editBody.value = doc.value.body
  baseVersion.value = docVersion(doc.value)
  baseDoc.value = { body: doc.value.body }
  conflict.value = null
  editing.value = true
}

function saveBackup() {
  const b = { body: editBody.value, ts: Date.now() }
  localStorage.setItem(backupKey.value, JSON.stringify(b))
  backup.value = b
}
async function restoreBackup() {
  if (!backup.value) return
  if (!editing.value) await startEdit()
  editBody.value = backup.value.body
  dismissBackup()
}
function dismissBackup() {
  backup.value = null
  localStorage.removeItem(backupKey.value)
}

async function saveEdit(force = false) {
  if (saving.value) return
  saving.value = true
  try {
    // 携带共享 token：store 事务内复核链接仍有效且可编辑，未携带/失效一律拒绝
    const res = await kb.updateDoc(doc.value.id, { body: editBody.value }, auth.user, '通过共享链接编辑', {
      baseVersion: baseVersion.value, base: baseDoc.value, force, shareToken: token.value
    })
    if (!res || res.status === 'missing') { status.value = 'notfound'; return }
    if (res.status === 'guest' || res.status === 'access-denied' || res.status === 'review-locked') {
      conflict.value = null
      editing.value = false
      savedToast.value = res.status === 'review-locked'
        ? '文档正在评审中，暂无法通过共享链接保存'
        : '共享链接已失效或无编辑权限，无法保存'
      setTimeout(() => { savedToast.value = '' }, 3000)
      await resolve(token.value)
      return
    }
    if (res.status === 'conflict') {
      // 保留未提交内容：正文留在编辑器中，同时写入本地备份
      conflict.value = res
      saveBackup()
      return
    }
    doc.value = res.doc
    conflict.value = null
    editing.value = false
    dismissBackup()
    savedToast.value = res.autoMerged?.length ? '已保存，并自动合并了其他窗口的修改' : '已保存'
    setTimeout(() => { savedToast.value = '' }, 3000)
  } finally {
    saving.value = false
  }
}

// 载入库中最新版本继续编辑；未提交内容已备份，可随时恢复
async function loadLatest() {
  const d = await kb.getDocFresh(doc.value.id)
  if (!d) { status.value = 'notfound'; return }
  doc.value = d
  editBody.value = d.body
  baseVersion.value = docVersion(d)
  baseDoc.value = { body: d.body }
  conflict.value = null
  savedToast.value = '已载入最新版本，你未提交的内容已保留在备份中'
  setTimeout(() => { savedToast.value = '' }, 3000)
}

onMounted(() => resolve(token.value))
watch(token, () => resolve(token.value))
</script>

<template>
  <div class="share">
    <div v-if="status === 'loading'" class="empty card"><div class="ico">⏳</div>正在加载共享文档…</div>
    <div v-else-if="status === 'notfound'" class="empty card"><div class="ico">🚫</div>共享链接无效或文档不存在</div>
    <div v-else-if="status === 'revoked'" class="empty card"><div class="ico">⛔</div>该共享链接已被撤销，如需访问请联系分享者重新生成</div>
    <div v-else-if="status === 'expired'" class="empty card"><div class="ico">⏰</div>该共享链接已过期，如需访问请联系分享者重新生成</div>

    <template v-else-if="doc">
      <div class="share-banner card">
        <span>🔗 您正在通过共享链接查看「{{ share.permission === 'edit' ? '可编辑' : '只读' }}」副本</span>
        <span class="owner">由 {{ userById[share.createdBy]?.name || share.createdBy }} 分享</span>
      </div>

      <div v-if="reviewLockedShare" class="card review-lock-banner">
        ⏳ 该文档正在评审中，正文暂不可通过共享链接修改；审批通过后将发布新版本。
      </div>

      <div v-if="retiredShare" class="card retired-banner">
        <div class="rb-line">🗄 该文档已知识退役：已停止搜索与问答引用，当前为只读归档，不可通过共享链接编辑。</div>
        <div class="rb-sub">
          替代文档为《{{ retiredShare.replacementTitle }}》。
          <a v-if="replacementOfShare" :href="'#/docs/' + retiredShare.replacementDocId">登录知识库查看替代文档 →</a>
          <span v-else>如无访问权限，可登录后在替代文档页申请权限。</span>
        </div>
      </div>

      <div class="page-head card">
        <div class="title-row">
          <h1 class="title">{{ doc.title }}</h1>
          <button v-if="editable && !editing && !retiredShare" class="btn primary sm" @click="startEdit">✎ 编辑文档</button>
          <span v-else-if="retiredShare" class="retired-tag">🗄 已退役 · 只读</span>
        </div>
        <div class="sub">
          <DocPill :doc="doc" />
          <span>更新于 {{ formatFull(doc.updatedAt) }}</span>
          <span v-if="savedToast" class="ok-toast">{{ savedToast }}</span>
        </div>
      </div>

      <div v-if="backup && !editing" class="card backup-bar">
        <span>检测到你有一份未提交的修改（{{ new Date(backup.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}）</span>
        <div class="b-actions">
          <button class="btn sm primary" @click="restoreBackup">恢复并继续编辑</button>
          <button class="btn sm ghost" @click="dismissBackup">忽略</button>
        </div>
      </div>

      <template v-if="editing">
        <div v-if="conflict" class="card conflict-bar">
          <div class="c-head">⚠️ 保存冲突：这篇文档刚在其他窗口被修改并保存</div>
          <div class="c-desc">你当前未提交的内容已自动备份，不会丢失。可选择覆盖保存，或载入最新版本后继续编辑。</div>
          <div class="c-actions">
            <button class="btn sm danger-solid" :disabled="saving" @click="saveEdit(true)">以我的内容覆盖保存</button>
            <button class="btn sm" @click="loadLatest">载入最新版本</button>
            <button class="btn sm ghost" @click="conflict = null">继续编辑</button>
          </div>
        </div>
        <div class="card editor-wrap">
          <RichEditor v-model="editBody" />
        </div>
        <div class="edit-bar card">
          <span class="hint">修改将直接保存到原文档，并记录为新版本；若与他人同时保存会自动检测冲突</span>
          <div class="edit-actions">
            <button class="btn" :disabled="saving" @click="editing = false">取消</button>
            <button class="btn primary" :disabled="saving" @click="saveEdit()">{{ saving ? '保存中…' : '保存修改' }}</button>
          </div>
        </div>
      </template>
      <article v-else class="render card" v-html="doc.body"></article>

      <div class="foot card">
        <span class="link-label">以访客身份阅读</span>
        <a class="btn" href="#/">前往知识库首页 →</a>
      </div>
    </template>
  </div>
</template>

<style scoped>
.share { padding: 20px 0; }
.share-banner { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; background: var(--primary-weak); border-color: var(--primary); color: var(--primary); font-weight: 500; }
.owner { font-weight: 400; font-size: 12px; opacity: 0.8; }
.review-lock-banner { padding: 10px 16px; margin-bottom: 14px; font-size: 13px; color: #b45309; background: #fffbeb; border-color: #f59e0b; }
.retired-banner { padding: 12px 16px; margin-bottom: 14px; font-size: 13px; color: #475569; background: #f8fafc; border-color: #cbd5e1; }
.rb-line { font-weight: 600; }
.rb-sub { margin-top: 4px; color: var(--text-2); font-size: 12.5px; }
.rb-sub a { color: var(--primary); font-weight: 600; }
.retired-tag { font-size: 12px; color: #475569; background: #e2e8f0; border-radius: 999px; padding: 3px 12px; }
.page-head { padding: 20px 24px; margin-bottom: 14px; }
.title-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.title { margin: 0 0 10px; }
.title-row .title { margin: 0; }
.sub { display: flex; align-items: center; gap: 12px; color: var(--text-3); font-size: 12px; margin-top: 10px; }
.render { padding: 28px 32px; line-height: 1.8; margin-bottom: 14px; }
.render :deep(h1) { font-size: 26px; } .render :deep(h2) { font-size: 21px; }
.render :deep(pre) { background: #1f2733; color: #dff2ff; padding: 12px 14px; border-radius: 8px; overflow: auto; }
.render :deep(blockquote) { border-left: 3px solid var(--primary); margin: 8px 0; padding: 4px 12px; color: var(--text-2); background: var(--primary-weak); }
.render :deep(img) { max-width: 100%; }
.editor-wrap { padding: 0; overflow: hidden; margin-bottom: 14px; }
.edit-bar { padding: 12px 16px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.hint { color: var(--text-3); font-size: 12px; }
.edit-actions { display: flex; gap: 8px; }
.foot { padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
.link-label { color: var(--text-3); font-size: 13px; }
.ok-toast { color: var(--accent); font-size: 12px; }
.conflict-bar { padding: 14px 20px; margin-bottom: 14px; border-color: var(--warn); background: #fff7ed; }
.conflict-bar .c-head { font-weight: 600; color: #b45309; margin-bottom: 6px; }
.conflict-bar .c-desc { font-size: 13px; color: var(--text-2); margin-bottom: 10px; }
.conflict-bar .c-actions { display: flex; gap: 8px; }
.btn.danger-solid { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn.danger-solid:hover { background: #d9444b; color: #fff; }
.backup-bar { padding: 10px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: var(--text-2); border-color: var(--primary); background: var(--primary-weak); }
.backup-bar .b-actions { display: flex; gap: 8px; }
</style>
