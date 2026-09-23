<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useAccessStore } from '@/stores/access'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  ACCESS, ACCESS_PERM, ACCESS_DURATIONS, accessStatusLabel, accessPermLabel,
  accessStatusCls, canDecideAccess, canRevokeAccess, canCancelAccess,
  isGrantActive, grantExpireText, accessTimelineLabel
} from '@/utils/access'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const accessStore = useAccessStore()

const tab = ref('pending') // pending | mine | all
const noteMap = ref({})
const durationMap = ref({})
const busyId = ref('')

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

const sorted = computed(() =>
  [...accessStore.requests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
)

// 待我审批：我拥有的文档（管理员可见全部待审批）
const pendingList = computed(() =>
  accessStore.pendingForApprover(auth.user?.id, auth.user?.role, kb.docs)
)
const mineList = computed(() => accessStore.requestsByUser(auth.user?.id))

const list = computed(() => {
  if (tab.value === 'pending') return pendingList.value
  if (tab.value === 'mine') return mineList.value
  // 全部记录：管理员可见全部；普通成员仅见本人申请 + 自己拥有文档上的申请
  if (auth.user?.role === 'admin') return sorted.value
  const myDocs = new Set(kb.docs.filter((d) => d.ownerId === auth.user?.id).map((d) => d.id))
  return sorted.value.filter((r) => r.applicantId === auth.user?.id || myDocs.has(r.docId))
})

const counts = computed(() => ({
  pending: pendingList.value.length,
  mine: mineList.value.length,
  all: list.value.length
}))

// 与 access store 统一时钟：授权到期调度推进后，本页「生效中/已到期」展示同步刷新
const now = computed(() => accessStore.now)
function active(r) { return isGrantActive(r, now.value) }

function durationOf(r) { return durationMap.value[r.id] || ACCESS_DURATIONS[1].value }

async function decide(r, decision) {
  if (busyId.value) return
  busyId.value = r.id
  try {
    const res = await accessStore.decideRequest(
      r.id, decision, (noteMap.value[r.id] || '').trim(), durationOf(r), auth.user
    )
    if (res.status !== 'ok') alert('操作失败：申请状态已变化')
    else noteMap.value[r.id] = ''
  } finally {
    busyId.value = ''
  }
}

async function revoke(r) {
  if (busyId.value) return
  if (!confirm('确定撤销该授权？撤销后其详情、搜索、问答与编辑权限立即收回（记录保留）。')) return
  busyId.value = r.id
  try {
    const res = await accessStore.revokeGrant(r.id, '', auth.user)
    if (res.status !== 'ok') alert('操作失败：授权状态已变化')
  } finally {
    busyId.value = ''
  }
}

async function cancel(r) {
  if (!confirm('确定取消本次访问申请？')) return
  await accessStore.cancelRequest(r.id, auth.user)
}

onMounted(async () => {
  await Promise.all([kb.loadAll(), accessStore.loadAll()])
})
</script>

<template>
  <div class="ac-page">
    <header class="head">
      <h2>🔑 访问授权</h2>
      <p class="sub">成员访问受限文档时申请限时阅读 / 协作权限，由文档拥有者审批并生成授权记录；撤销或到期后自动收回详情、搜索、问答与编辑权限。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'pending' }" @click="tab = 'pending'">待我审批 <em>{{ counts.pending }}</em></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我的申请 <em>{{ counts.mine }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部记录 <em>{{ counts.all }}</em></button>
      </div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">📭</div>
      {{ tab === 'pending' ? '暂无待你审批的访问申请' : tab === 'mine' ? '你还没有提交过访问申请' : '暂无访问申请记录' }}
    </div>

    <div v-else class="ac-list">
      <div v-for="r in list" :key="r.id" class="ac card">
        <div class="ac-top" @click="docById[r.docId] && router.push('/docs/' + r.docId)">
          <div class="ac-main">
            <span class="ac-doc-title">{{ docById[r.docId]?.title || '已删除文档' }}</span>
            <DocPill v-if="docById[r.docId]" :doc="docById[r.docId]" />
          </div>
          <div class="ac-side">
            <span class="st" :class="accessStatusCls(r.status)">{{ accessStatusLabel(r.status) }}</span>
            <span v-if="r.status === ACCESS.APPROVED && !active(r)" class="st st-off">已到期</span>
            <span class="ac-time">{{ formatDate(r.createdAt) }}</span>
          </div>
        </div>

        <div class="ac-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(r.applicantId) }">{{ userById[r.applicantId]?.avatar || '?' }}</span>
            {{ userById[r.applicantId]?.name || r.applicantId }} 申请
          </span>
          <span class="perm-tag" :class="r.requestedPermission === ACCESS_PERM.COLLAB ? 'pt-collab' : 'pt-read'">
            {{ accessPermLabel(r.requestedPermission) }}
          </span>
          <span v-if="r.status === ACCESS.APPROVED" class="expire">{{ grantExpireText(r, now) }}</span>
          <span v-if="r.decidedAt" class="decided">
            {{ userById[r.decidedBy]?.name || r.decidedBy }} 于 {{ formatDate(r.decidedAt) }} 审批
          </span>
        </div>

        <p v-if="r.reason" class="reason">申请说明：“{{ r.reason }}”</p>
        <p v-if="r.decisionNote" class="dnote">审批备注：“{{ r.decisionNote }}”</p>

        <!-- 审批操作（拥有者/管理员） -->
        <div v-if="canDecideAccess(r, docById[r.docId], auth.user?.id, auth.user?.role)" class="decide-box">
          <select v-model.number="durationMap[r.id]" class="dur">
            <option v-for="o in ACCESS_DURATIONS" :key="o.value" :value="o.value">授权 {{ o.label }}</option>
          </select>
          <input v-model="noteMap[r.id]" class="note-in" placeholder="审批备注（可选，将写入授权变更记录）" />
          <div class="decide-actions">
            <button class="btn sm" :disabled="busyId === r.id" @click="decide(r, 'reject')">✕ 驳回</button>
            <button class="btn sm ok-solid" :disabled="busyId === r.id" @click="decide(r, 'approve')">✓ 通过并授权</button>
          </div>
        </div>

        <!-- 生效中授权：撤销（拥有者/管理员） -->
        <div v-if="canRevokeAccess(r, docById[r.docId], auth.user?.id, auth.user?.role, now)" class="row-actions">
          <button class="btn sm danger" :disabled="busyId === r.id" @click="revoke(r)">撤销授权</button>
        </div>

        <!-- 申请人取消待审批申请 -->
        <div v-if="canCancelAccess(r, auth.user?.id)" class="row-actions">
          <button class="btn sm ghost" @click="cancel(r)">取消申请</button>
        </div>

        <details class="timeline">
          <summary>查看申请与授权变更记录（{{ (r.timeline || []).length }}）</summary>
          <div v-for="(t, i) in r.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ accessTimelineLabel(t.action) }}</span>
            <span class="tl-who">{{ userById[t.by]?.name || (t.by === 'system' ? '系统' : t.by) }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ac-page { max-width: 900px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.ac-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.ac { padding: 16px 20px; }
.ac-top { display: flex; justify-content: space-between; gap: 14px; cursor: pointer; }
.ac-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.ac-doc-title { font-weight: 700; font-size: 15px; }
.ac-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-revoked { background: #ffe9ea; color: var(--danger); }
.ac-time { color: var(--text-3); font-size: 12px; }
.ac-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.perm-tag { font-size: 11px; padding: 1px 9px; border-radius: 999px; }
.pt-read { background: var(--primary-weak); color: var(--primary); }
.pt-collab { background: #f3e8ff; color: #9333ea; }
.expire, .decided { font-size: 12px; color: var(--text-3); }
.reason { margin: 8px 0 0; font-size: 13px; color: var(--text-2); }
.dnote { margin: 6px 0 0; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.decide-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dur, .note-in { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.note-in { flex: 1; min-width: 200px; outline: none; }
.note-in:focus { border-color: var(--primary); }
.decide-actions { display: flex; gap: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.row-actions { margin-top: 10px; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 130px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
