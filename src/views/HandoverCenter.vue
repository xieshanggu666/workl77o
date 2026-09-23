<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useHandoverStore } from '@/stores/handover'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  HANDOVER, REVOKE_MODE, handoverStatusLabel, handoverStatusCls, handoverItemLabel, handoverItemCls,
  revokeModeLabel, pendingItemsFor, confirmedItemsOf,
  canConfirmItem, canDecideItem, canDecideHandover, canCancelHandover, handoverTimelineLabel
} from '@/utils/handover'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const handoverStore = useHandoverStore()

const tab = ref('confirm') // confirm | approve | mine | all
const busyId = ref('')
const noteMap = ref({})

// ---- 发起批量交接（同一批逐篇指定接任者） ----
const creating = ref(false)
const picked = ref([]) // 选中的文档 id
const targetMap = ref({}) // docId → 接任者 id（逐篇指定）
const bulkTarget = ref('') // 「统一指定」下拉，便于一次设全部
const revokeMode = ref(REVOKE_MODE.KEEP)
const note = ref('')
const initiateBusy = ref(false)

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

// 我负责的文档（可交接）；已有流转中交接单的文档不可重复发起
const ownDocs = computed(() =>
  kb.docs
    .filter((d) => d.ownerId === auth.user?.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)
const successors = computed(() => auth.users.filter((u) => u.id !== auth.user?.id))
// 每篇都已指定接任者才可提交
const allTargeted = computed(() => picked.value.length > 0 && picked.value.every((id) => !!targetMap.value[id]))

const confirmList = computed(() => handoverStore.pendingConfirmFor(auth.user?.id))
const approveList = computed(() => handoverStore.pendingApprovalFor(auth.user?.role))
const mineList = computed(() => handoverStore.initiatedBy(auth.user?.id))
const allList = computed(() =>
  auth.user?.role === 'admin' ? handoverStore.sorted : handoverStore.involvedIn(auth.user?.id)
)
const list = computed(() => {
  if (tab.value === 'confirm') return confirmList.value
  if (tab.value === 'approve') return approveList.value
  if (tab.value === 'mine') return mineList.value
  return allList.value
})
const counts = computed(() => ({
  confirm: confirmList.value.length,
  approve: approveList.value.length,
  mine: mineList.value.length,
  all: allList.value.length
}))

// 批次内的接任者去重（头部展示）
const successorIds = (h) => [...new Set((h.items || []).map((i) => i.toUserId).filter(Boolean))]
// 我在该批次中待确认的篇 / 该批次已确认待批准的篇
const myPending = (h) => pendingItemsFor(h, auth.user?.id)
const confirmedItems = (h) => confirmedItemsOf(h)

function togglePick(id) {
  const i = picked.value.indexOf(id)
  if (i >= 0) picked.value.splice(i, 1)
  else {
    picked.value.push(id)
    // 新勾选的篇默认沿用「统一指定」或第一位可选接任者，可再逐篇调整
    if (!targetMap.value[id]) targetMap.value[id] = bulkTarget.value || successors.value[0]?.id || ''
  }
}

function setTarget(id, uid) {
  targetMap.value = { ...targetMap.value, [id]: uid }
}

function applyBulk() {
  if (!bulkTarget.value) return
  const m = { ...targetMap.value }
  for (const id of picked.value) m[id] = bulkTarget.value
  targetMap.value = m
}

function openCreate() {
  creating.value = true
  picked.value = []
  targetMap.value = {}
  bulkTarget.value = successors.value[0]?.id || ''
  revokeMode.value = REVOKE_MODE.KEEP
  note.value = ''
}

async function submitInitiate() {
  if (initiateBusy.value) return
  if (!picked.value.length) { alert('请至少选择一篇要交接的文档'); return }
  if (!allTargeted.value) { alert('请为每一篇文档指定接任者'); return }
  initiateBusy.value = true
  try {
    const res = await handoverStore.initiateHandover(
      {
        items: picked.value.map((id) => ({ docId: id, toUserId: targetMap.value[id] })),
        revokeMode: revokeMode.value,
        note: note.value.trim()
      },
      auth.user
    )
    if (res.status === 'ok') {
      creating.value = false
      tab.value = 'mine'
    } else if (res.status === 'denied') {
      alert('发起失败：《' + (res.title || res.docId) + '》的负责人不是你，无法交接。')
    } else if (res.status === 'in-handover') {
      alert('发起失败：《' + (res.title || res.docId) + '》已有流转中的交接单，请先完成或取消。')
    } else if (res.status === 'retired') {
      alert('发起失败：《' + (res.title || res.docId) + '》已退役，不再参与责任交接。')
    } else if (res.status === 'in-retirement') {
      alert('发起失败：《' + (res.title || res.docId) + '》有流转中的退役申请，请先完成或取消。')
    } else if (res.status === 'bad-target') {
      alert('发起失败：存在未指定或无效的接任者。')
    } else if (res.status === 'guest') {
      alert('请先登录后再发起交接。')
    } else {
      alert('发起失败，请稍后重试。')
    }
  } finally {
    initiateBusy.value = false
  }
}

// 接任者确认（docIds 可一次多篇：逐篇确认或「全部确认」）
async function confirm(h, docIds) {
  if (busyId.value) return
  busyId.value = h.id
  try {
    const res = await handoverStore.confirmHandover(h.id, docIds, auth.user)
    if (res.status !== 'ok') alert('操作失败：交接单状态已变化')
  } finally {
    busyId.value = ''
  }
}

async function decline(h, item) {
  if (busyId.value) return
  busyId.value = h.id
  try {
    const res = await handoverStore.declineHandover(h.id, item.docId, (noteMap.value[h.id] || '').trim(), auth.user)
    if (res.status !== 'ok') alert('操作失败：交接单状态已变化')
  } finally {
    busyId.value = ''
  }
}

// 管理员分批批准/驳回（docIds 为本批范围：逐篇或「全部已确认」）
async function decide(h, docIds, decision) {
  if (busyId.value) return
  busyId.value = h.id
  try {
    const res = await handoverStore.decideHandover(h.id, docIds, decision, (noteMap.value[h.id] || '').trim(), auth.user)
    if (res.status === 'ok' && res.failures?.length) {
      alert('部分篇目未执行转移：' + res.failures.map((f) => '《' + f.title + '》' + f.fields.join('、')).join('；'))
    } else if (res.status !== 'ok') {
      alert('操作失败：交接单状态已变化')
    }
  } finally {
    busyId.value = ''
  }
}

async function cancel(h) {
  if (!confirm('确定取消本次交接？流转中的篇目将一并取消，文档保持原状。')) return
  const res = await handoverStore.cancelHandover(h.id, auth.user)
  if (res.status !== 'ok') alert('操作失败：交接单状态已变化')
}

// 逐篇转移结果摘要（已完成篇）
function itemResultText(item) {
  const r = item.result
  if (!r) return ''
  const parts = []
  parts.push('所有权已转移')
  if (r.reviewIds?.length) parts.push('评审待办 ' + r.reviewIds.length + ' 项已改挂')
  if (r.freshTicketId) parts.push('保鲜复核单已留痕')
  if (r.accessPending) parts.push('待审批访问申请 ' + r.accessPending + ' 项随负责人转移')
  if (r.revokedGrants) parts.push('收回原负责人授权 ' + r.revokedGrants + ' 项')
  return parts.join(' · ')
}

onMounted(async () => {
  await Promise.all([kb.loadAll(), auth.loadUsers(), handoverStore.loadAll()])
  // 有待确认/待批准事项时直接落在对应页签
  if (confirmList.value.length) tab.value = 'confirm'
  else if (approveList.value.length) tab.value = 'approve'
  else tab.value = 'mine'
})
</script>

<template>
  <div class="ho-page">
    <header class="head">
      <h2>🤝 责任交接</h2>
      <p class="sub">
        负责人勾选名下文档批量发起交接，同一批中可逐篇指定不同接任者；各接任者独立确认或谢绝，
        管理员按确认结果分批批准——已确认篇先批先转，文档所有权、待办审批与保鲜责任随批准一并转移；
        交接期间校验并发变更，不一致的篇目失败回退，历史归属全程保留，原负责人权限按交接决定保留或收回。
      </p>
      <div class="head-row">
        <div class="tabs">
          <button :class="{ on: tab === 'confirm' }" @click="tab = 'confirm'">待我确认 <em>{{ counts.confirm }}</em></button>
          <button v-if="auth.user?.role === 'admin'" :class="{ on: tab === 'approve' }" @click="tab = 'approve'">待批准 <em>{{ counts.approve }}</em></button>
          <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我发起的 <em>{{ counts.mine }}</em></button>
          <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部记录 <em>{{ counts.all }}</em></button>
        </div>
        <button class="btn primary" @click="openCreate">＋ 发起批量交接</button>
      </div>
    </header>

    <!-- 发起批量交接 -->
    <div v-if="creating" class="create card">
      <div class="c-title">📦 发起批量交接</div>
      <div class="c-hint">仅可勾选你负责的文档；同一批可逐篇指定不同接任者，各接任者独立确认后由管理员分批批准。交接流转期间请避免修改这些文档，否则批准时将因并发变更校验失败而回退该篇。</div>
      <div v-if="!ownDocs.length" class="c-empty">你名下暂无可交接的文档</div>
      <template v-else>
        <div class="doc-pick">
          <label v-for="d in ownDocs" :key="d.id" class="dp" :class="{ disabled: handoverStore.activeHandoverOfDoc(d.id) }">
            <input
              type="checkbox"
              :checked="picked.includes(d.id)"
              :disabled="!!handoverStore.activeHandoverOfDoc(d.id)"
              @change="togglePick(d.id)"
            />
            <span class="dp-title">{{ d.title }}</span>
            <span v-if="handoverStore.activeHandoverOfDoc(d.id)" class="dp-tag">交接流转中</span>
            <select
              v-else-if="picked.includes(d.id)"
              class="dp-sel"
              :value="targetMap[d.id]"
              @click.stop
              @change="setTarget(d.id, $event.target.value)"
            >
              <option value="" disabled>选择接任者</option>
              <option v-for="u in successors" :key="u.id" :value="u.id">{{ u.name }}（{{ u.title || u.role }}）</option>
            </select>
          </label>
        </div>
        <div class="c-form">
          <label class="f-item">
            <span class="f-k">统一指定</span>
            <select v-model="bulkTarget" class="f-sel">
              <option v-for="u in successors" :key="u.id" :value="u.id">{{ u.name }}（{{ u.title || u.role }}）</option>
            </select>
            <button class="btn sm ghost" :disabled="!picked.length" @click="applyBulk">全部设为该成员</button>
          </label>
          <label class="f-item">
            <span class="f-k">原负责人权限</span>
            <span class="f-radios">
              <label><input type="radio" value="keep" v-model="revokeMode" /> 保留协作权限</label>
              <label><input type="radio" value="revoke" v-model="revokeMode" /> 收回全部权限</label>
            </span>
          </label>
          <input v-model="note" class="f-note" placeholder="交接说明（可选，将写入交接记录）" />
        </div>
        <div class="c-acts">
          <button class="btn ghost" @click="creating = false">取消</button>
          <button class="btn primary" :disabled="initiateBusy || !allTargeted" @click="submitInitiate">
            {{ initiateBusy ? '提交中…' : '提交交接（已选 ' + picked.length + ' 篇）' }}
          </button>
        </div>
      </template>
    </div>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🤝</div>
      {{ tab === 'confirm' ? '暂无待你确认的交接' : tab === 'approve' ? '暂无待批准的交接' : tab === 'mine' ? '你还没有发起过交接' : '暂无交接记录' }}
    </div>

    <div v-else class="ho-list">
      <div v-for="h in list" :key="h.id" class="ho card">
        <div class="ho-top">
          <div class="ho-main">
            <span class="ho-users">
              <span class="ava" :style="{ background: avatarColor(h.fromUserId) }">{{ userById[h.fromUserId]?.avatar || '?' }}</span>
              {{ userName(h.fromUserId) }}
              <span class="arrow">→</span>
              <span v-for="(uid, i) in successorIds(h)" :key="uid" class="ho-succ">
                <span class="ava" :style="{ background: avatarColor(uid) }">{{ userById[uid]?.avatar || '?' }}</span>
                {{ userName(uid) }}<span v-if="i < successorIds(h).length - 1">、</span>
              </span>
            </span>
            <span class="ho-count">{{ h.docIds.length }} 篇文档</span>
          </div>
          <div class="ho-side">
            <span class="st" :class="handoverStatusCls(h.status)">{{ handoverStatusLabel(h.status) }}</span>
            <span class="ho-time">{{ formatDate(h.createdAt) }}</span>
          </div>
        </div>

        <div class="ho-docs">
          <div v-for="item in h.items" :key="item.docId" class="hd">
            <div class="hd-line">
              <span class="hd-title" @click="docById[item.docId] && router.push('/docs/' + item.docId)">
                {{ docById[item.docId]?.title || item.title }}
              </span>
              <span class="hd-to">
                →
                <span class="ava" :style="{ background: avatarColor(item.toUserId) }">{{ userById[item.toUserId]?.avatar || '?' }}</span>
                {{ userName(item.toUserId) }}
              </span>
              <span class="st" :class="handoverItemCls(item.status)">{{ handoverItemLabel(item.status) }}</span>
              <DocPill v-if="docById[item.docId]" :doc="docById[item.docId]" />
            </div>
            <div v-if="item.result" class="hd-result">✅ {{ itemResultText(item) }}</div>
            <div v-if="item.status === HANDOVER.FAILED && item.failReason" class="hd-fail">⚠ {{ item.failReason }}</div>
            <div v-else-if="item.decideNote" class="hd-note">“{{ item.decideNote }}”</div>
            <!-- 接任者：按篇确认 / 谢绝 -->
            <div v-if="canConfirmItem(item, auth.user?.id)" class="hd-acts">
              <button class="btn sm" :disabled="busyId === h.id" @click="decline(h, item)">✕ 谢绝</button>
              <button class="btn sm ok-solid" :disabled="busyId === h.id" @click="confirm(h, [item.docId])">✓ 确认接收</button>
            </div>
            <!-- 管理员：按篇批准 / 驳回 -->
            <div v-if="canDecideItem(item, auth.user?.id, auth.user?.role)" class="hd-acts">
              <button class="btn sm" :disabled="busyId === h.id" @click="decide(h, [item.docId], 'reject')">✕ 驳回</button>
              <button class="btn sm ok-solid" :disabled="busyId === h.id" @click="decide(h, [item.docId], 'approve')">✓ 批准转移</button>
            </div>
          </div>
        </div>

        <div class="ho-info">
          <span class="dim">{{ revokeModeLabel(h.revokeMode) }}</span>
          <span v-if="h.note" class="dim">交接说明：“{{ h.note }}”</span>
        </div>

        <!-- 批量操作：接任者全部确认 / 管理员按确认结果分批批准 -->
        <div v-if="myPending(h).length || canDecideHandover(h, auth.user?.id, auth.user?.role)" class="decide-box">
          <input v-model="noteMap[h.id]" class="note-in" placeholder="备注（可选，谢绝/审批时写入交接记录）" />
          <div class="decide-actions">
            <button v-if="myPending(h).length > 1" class="btn sm ok-solid" :disabled="busyId === h.id" @click="confirm(h, myPending(h).map((i) => i.docId))">
              ✓ 全部确认接收（{{ myPending(h).length }} 篇）
            </button>
            <button
              v-if="canDecideHandover(h, auth.user?.id, auth.user?.role)"
              class="btn sm ok-solid"
              :disabled="busyId === h.id"
              @click="decide(h, confirmedItems(h).map((i) => i.docId), 'approve')"
            >
              ✓ 批准全部已确认（{{ confirmedItems(h).length }} 篇）
            </button>
          </div>
        </div>

        <!-- 发起人 / 管理员取消 -->
        <div v-if="canCancelHandover(h, auth.user?.id, auth.user?.role)" class="row-actions">
          <button class="btn sm ghost" @click="cancel(h)">取消交接</button>
        </div>

        <details class="timeline">
          <summary>查看交接记录（{{ (h.timeline || []).length }}）</summary>
          <div v-for="(t, i) in h.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ handoverTimelineLabel(t.action) }}</span>
            <span class="tl-who">{{ userName(t.by) }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ho-page { max-width: 900px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.head-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }

.create { margin-top: 16px; padding: 16px 20px; }
.c-title { font-weight: 700; font-size: 14px; }
.c-hint { color: var(--text-3); font-size: 12px; margin: 6px 0 12px; }
.c-empty { color: var(--text-3); font-size: 13px; padding: 12px 0; }
.doc-pick { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
.dp { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.dp:hover { background: var(--primary-weak); }
.dp.disabled { opacity: 0.55; cursor: not-allowed; }
.dp-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dp-tag { font-size: 11px; color: #b45309; background: #fef3c7; border-radius: 999px; padding: 1px 8px; }
.dp-sel { border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; font-size: 12px; background: #fff; max-width: 180px; }
.c-form { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; }
.f-item { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
.f-k { color: var(--text-2); }
.f-sel { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.f-radios { display: inline-flex; gap: 12px; font-size: 13px; color: var(--text-2); }
.f-note { flex: 1; min-width: 220px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; outline: none; }
.f-note:focus { border-color: var(--primary); }
.c-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }

.ho-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.ho { padding: 16px 20px; }
.ho-top { display: flex; justify-content: space-between; gap: 14px; }
.ho-main { min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ho-users { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; font-size: 15px; flex-wrap: wrap; }
.ho-users .arrow { color: var(--text-3); font-weight: 400; }
.ho-succ { display: inline-flex; align-items: center; gap: 4px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.ho-count { font-size: 12px; color: var(--primary); background: var(--primary-weak); border-radius: 999px; padding: 1px 9px; }
.ho-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-wait { background: var(--primary-weak); color: var(--primary); }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-fail { background: #ffe9ea; color: var(--danger); }
.ho-time { color: var(--text-3); font-size: 12px; }

.ho-docs { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.hd { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: var(--panel-2); }
.hd-line { display: flex; align-items: center; gap: 10px; }
.hd-title { font-weight: 600; font-size: 13px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.hd-title:hover { color: var(--primary); }
.hd-to { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); white-space: nowrap; }
.hd-result { margin-top: 4px; font-size: 12px; color: #15803d; }
.hd-fail { margin-top: 4px; font-size: 12px; color: #b91c1c; }
.hd-note { margin-top: 4px; font-size: 12px; color: var(--text-3); }
.hd-acts { margin-top: 8px; display: flex; justify-content: flex-end; gap: 8px; }

.ho-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; }
.dim { color: var(--text-3); font-size: 12px; }

.decide-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.note-in { flex: 1; min-width: 200px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; outline: none; }
.note-in:focus { border-color: var(--primary); }
.decide-actions { display: flex; gap: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.row-actions { margin-top: 10px; }

.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 170px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
