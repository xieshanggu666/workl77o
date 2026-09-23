<script setup>
import { ref, computed } from 'vue'
import { useAccessStore } from '@/stores/access'
import { useAuthStore } from '@/stores/auth'
import {
  ACCESS, ACCESS_PERM, ACCESS_DURATIONS, accessStatusLabel, accessPermLabel,
  accessStatusCls, canDecideAccess, canRevokeAccess, grantExpireText, accessTimelineLabel
} from '@/utils/access'
import { formatDate, formatFull, avatarColor } from '@/utils/format'

const props = defineProps({
  doc: { type: Object, required: true }
})

const accessStore = useAccessStore()
const auth = useAuthStore()

const noteMap = ref({})
const durationMap = ref({})
const busyId = ref('')
const justDone = ref('')

const all = computed(() => accessStore.requestsOfDoc(props.doc.id))
const pendingList = computed(() => all.value.filter((r) => r.status === ACCESS.PENDING))
// 生效中的授权（含已到期但记录仍为 approved 的，按统一时钟区分提示）
const grants = computed(() => {
  return all.value
    .filter((r) => r.status === ACCESS.APPROVED)
    .sort((a, b) => new Date(b.decidedAt || b.grant?.grantedAt) - new Date(a.decidedAt || a.grant?.grantedAt))
})
const history = computed(() => all.value.filter((r) => [ACCESS.REJECTED, ACCESS.CANCELLED, ACCESS.REVOKED].includes(r.status)))

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

function durationOf(r) {
  return durationMap.value[r.id] || ACCESS_DURATIONS[1].value
}
// 到期判定接入 access store 统一时钟：到期调度推进后「已到期」标记即时刷新
function isExpired(r) {
  return !!r.grant?.expiresAt && new Date(r.grant.expiresAt) <= accessStore.now
}

async function decide(r, decision) {
  if (busyId.value) return
  busyId.value = r.id
  try {
    const res = await accessStore.decideRequest(
      r.id, decision, (noteMap.value[r.id] || '').trim(), durationOf(r), auth.user
    )
    if (res.status === 'ok') {
      justDone.value = decision === 'approve' ? '已通过，授权记录已生成' : '已驳回申请'
      noteMap.value[r.id] = ''
      setTimeout(() => { justDone.value = '' }, 2500)
    } else {
      alert('操作失败：申请状态已变化，请刷新后重试')
    }
  } finally {
    busyId.value = ''
  }
}

async function revoke(r) {
  if (busyId.value) return
  if (!confirm('确定撤销该成员的访问授权？撤销后其详情、搜索、问答与编辑权限将立即收回（记录保留）。')) return
  busyId.value = r.id
  try {
    const res = await accessStore.revokeGrant(r.id, '', auth.user)
    if (res.status === 'ok') justDone.value = '授权已撤销'
    else alert('操作失败：授权状态已变化')
    setTimeout(() => { justDone.value = '' }, 2500)
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <div class="access card">
    <div class="ac-head">
      <span class="ac-title">🔑 访问授权</span>
      <span v-if="pendingList.length" class="st st-pending">{{ pendingList.length }} 条待审批</span>
      <span v-else-if="grants.length" class="st st-ok">{{ grants.length }} 条授权记录</span>
    </div>

    <div v-if="justDone" class="ok-line">✅ {{ justDone }}</div>

    <!-- 待审批申请 -->
    <div v-if="pendingList.length" class="block">
      <div class="b-title">待审批申请</div>
      <div v-for="r in pendingList" :key="r.id" class="item req-item">
        <div class="i-main">
          <div class="i-line">
            <span class="ava" :style="{ background: avatarColor(r.applicantId) }">{{ userById[r.applicantId]?.avatar || '?' }}</span>
            <b>{{ userById[r.applicantId]?.name || r.applicantId }}</b>
            <span class="perm-tag" :class="r.requestedPermission === ACCESS_PERM.COLLAB ? 'pt-collab' : 'pt-read'">
              {{ accessPermLabel(r.requestedPermission) }}
            </span>
            <span class="tm">{{ formatDate(r.createdAt) }} 申请</span>
          </div>
          <p v-if="r.reason" class="reason">“{{ r.reason }}”</p>
          <div v-if="canDecideAccess(r, doc, auth.user?.id, auth.user?.role)" class="decide">
            <select v-model.number="durationMap[r.id]" class="dur">
              <option v-for="o in ACCESS_DURATIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input v-model="noteMap[r.id]" class="note-in" placeholder="审批备注（可选，将留痕）" />
            <button class="btn sm" :disabled="busyId === r.id" @click="decide(r, 'reject')">✕ 驳回</button>
            <button class="btn sm ok-solid" :disabled="busyId === r.id" @click="decide(r, 'approve')">✓ 通过授权</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 已生成的授权 -->
    <div v-if="grants.length" class="block">
      <div class="b-title">授权记录</div>
      <div v-for="r in grants" :key="r.id" class="item grant-item">
        <div class="i-line">
          <span class="ava" :style="{ background: avatarColor(r.applicantId) }">{{ userById[r.applicantId]?.avatar || '?' }}</span>
          <b>{{ userById[r.applicantId]?.name || r.applicantId }}</b>
          <span class="perm-tag" :class="r.grant.permission === ACCESS_PERM.COLLAB ? 'pt-collab' : 'pt-read'">
            {{ accessPermLabel(r.grant.permission) }}
          </span>
          <span v-if="isExpired(r)" class="st st-off">已到期</span>
          <span v-else class="st st-ok">生效中</span>
          <span class="tm">{{ grantExpireText(r) }}</span>
          <button
            v-if="canRevokeAccess(r, doc, auth.user?.id, auth.user?.role)"
            class="btn sm danger ms-auto" :disabled="busyId === r.id" @click="revoke(r)"
          >撤销授权</button>
        </div>
        <details class="tl-box">
          <summary>变更记录（{{ (r.timeline || []).length }}）</summary>
          <div v-for="(t, i) in r.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ accessTimelineLabel(t.action) }}</span>
            <span class="tl-who">{{ userById[t.by]?.name || t.by }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <!-- 历史：驳回 / 取消 / 已撤销 -->
    <div v-if="history.length" class="block">
      <div class="b-title">历史记录</div>
      <div v-for="r in history" :key="r.id" class="item hist-item">
        <div class="i-line">
          <span class="ava sm" :style="{ background: avatarColor(r.applicantId) }">{{ userById[r.applicantId]?.avatar || '?' }}</span>
          <b>{{ userById[r.applicantId]?.name || r.applicantId }}</b>
          <span class="perm-tag" :class="r.requestedPermission === ACCESS_PERM.COLLAB ? 'pt-collab' : 'pt-read'">
            {{ accessPermLabel(r.requestedPermission) }}
          </span>
          <span class="st" :class="accessStatusCls(r.status)">{{ accessStatusLabel(r.status) }}</span>
          <span class="tm">{{ formatFull(r.decidedAt || r.createdAt) }}</span>
        </div>
        <p v-if="r.decisionNote" class="reason small">备注：“{{ r.decisionNote }}”</p>
      </div>
    </div>

    <div v-if="!all.length" class="empty">暂无访问申请与授权记录</div>
  </div>
</template>

<style scoped>
.access { margin-top: 14px; padding: 18px 24px; }
.ac-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.ac-title { font-weight: 700; font-size: 15px; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.ok-line { color: #15803d; font-size: 13px; margin-bottom: 10px; }
.block { margin-bottom: 14px; }
.block:last-child { margin-bottom: 0; }
.b-title { font-size: 12px; color: var(--text-3); margin-bottom: 8px; }
.item { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; }
.i-line { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.i-main { display: flex; flex-direction: column; gap: 8px; }
.ava { width: 24px; height: 24px; border-radius: 50%; color: #fff; font-size: 11px; display: inline-grid; place-items: center; }
.ava.sm { width: 20px; height: 20px; font-size: 10px; }
.tm { color: var(--text-3); font-size: 12px; }
.ms-auto { margin-left: auto; }
.perm-tag { font-size: 11px; padding: 1px 9px; border-radius: 999px; }
.pt-read { background: var(--primary-weak); color: var(--primary); }
.pt-collab { background: #f3e8ff; color: #9333ea; }
.reason { margin: 4px 0 0; font-size: 13px; color: var(--text-2); }
.reason.small { font-size: 12px; color: var(--text-3); }
.decide { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dur, .note-in { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.note-in { flex: 1; min-width: 180px; outline: none; }
.note-in:focus { border-color: var(--primary); }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.tl-box { margin-top: 8px; }
.tl-box summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 110px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.empty { color: var(--text-3); font-size: 13px; text-align: center; padding: 8px 0; }
</style>
