<script setup>
// 单张退役单卡片：展示旧文档 ⇒ 替代文档、状态/联动结果/时间线，
// 承载管理员逐篇批准/驳回、发起人撤销申请、撤销已生效退役。单篇与批次内逐篇共用。
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useRetirementStore } from '@/stores/retirement'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  RETIRE, retireStatusLabel, retireStatusCls, retireTimelineLabel,
  canDecideRetirement, canCancelRetirement, canRevokeRetirement
} from '@/utils/retirement'

const props = defineProps({
  r: { type: Object, required: true },
  compact: { type: Boolean, default: false } // 批次分组内紧凑展示
})

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const retirementStore = useRetirementStore()

const busy = ref(false)
const note = ref('')
const revokeNote = ref('')

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

async function decide(decision) {
  if (busy.value) return
  busy.value = true
  try {
    const res = await retirementStore.decideRetirement(props.r.id, decision, note.value.trim(), auth.user)
    if (res.status === 'ok') {
      if (res.approved) alert('《' + props.r.docTitle + '》已退役：停止搜索与问答引用，共享链接已撤销，缺口工单答案来源已改挂替代文档。')
    } else if (res.status === 'replacement-missing') {
      alert('替代文档已不存在，无法批准退役。请驳回后由发起人重新指定。')
    } else if (res.status === 'replacement-retired') {
      alert('替代文档在审批期间也被退役了，无法批准。请驳回后重新指定有效替代文档。')
    } else if (res.status === 'used-as-replacement') {
      alert('本文档正作为另一篇文档的替代文档（替代冲突），请先处理或撤销相关退役后再批准。')
    } else if (res.status === 'in-review') {
      alert('旧文档在审批期间进入评审，请待评审完结后再处理退役。')
    } else if (res.status === 'in-handover') {
      alert('旧文档在审批期间进入责任交接，请先完成或取消交接。')
    } else if (res.status === 'doc-missing') {
      alert('旧文档已被删除，无法批准退役。')
    } else {
      alert('操作失败：退役单状态已变化')
    }
  } finally {
    busy.value = false
  }
}

async function cancel() {
  if (!confirm('确定撤销本篇退役申请？旧文档保持原状。')) return
  const res = await retirementStore.cancelRetirement(props.r.id, auth.user)
  if (res.status !== 'ok') alert('操作失败：退役单状态已变化')
}

async function revoke() {
  if (!confirm('确定撤销本篇退役？将恢复旧文档搜索/问答引用、恢复共享链接、答案来源回挂旧文档。')) return
  busy.value = true
  try {
    const res = await retirementStore.revokeRetirement(props.r.id, revokeNote.value.trim(), auth.user)
    if (res.status === 'ok') {
      alert('已撤销退役：恢复共享链接 ' + res.restoredShareIds.length + ' 条，回挂答案来源 ' + res.restoredTicketIds.length + ' 张。')
    } else if (res.status === 'denied') {
      alert('只有退役发起人或管理员可以撤销退役。')
    } else {
      alert('操作失败：退役单状态已变化')
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="rt-item" :class="{ compact }">
    <div class="rt-top">
      <div class="rt-flow">
        <span class="rt-doc old" @click="docById[r.docId] && router.push('/docs/' + r.docId)">《{{ docById[r.docId]?.title || r.docTitle }}》</span>
        <span class="arrow">⇒</span>
        <span class="rt-doc rep" @click="docById[r.replacementDocId] && router.push('/docs/' + r.replacementDocId)">《{{ docById[r.replacementDocId]?.title || r.replacementTitle }}》</span>
        <span v-if="!docById[r.replacementDocId]" class="rep-gone" title="替代文档已删除">（替代文档已删除）</span>
      </div>
      <div class="rt-side">
        <span class="st" :class="retireStatusCls(r.status)">{{ retireStatusLabel(r.status) }}</span>
        <span v-if="!compact" class="rt-time">{{ formatDate(r.createdAt) }}</span>
      </div>
    </div>

    <div v-if="!compact" class="rt-info">
      <span class="who">
        <span class="ava" :style="{ background: avatarColor(r.initiatedBy) }">{{ userById[r.initiatedBy]?.avatar || '?' }}</span>
        {{ userName(r.initiatedBy) }} 发起
      </span>
      <span v-if="r.decidedAt" class="dim">{{ userName(r.decidedBy) }} 于 {{ formatDate(r.decidedAt) }} 处理</span>
      <span v-if="r.status === RETIRE.APPROVED && r.effects" class="dim">
        撤销链接 {{ r.effects.revokedShareIds?.length || 0 }} 条 · 改挂工单 {{ r.effects.repointedTicketIds?.length || 0 }} 张
      </span>
      <span v-if="r.status === RETIRE.REVOKED && r.effects" class="dim restore-dim">
        已恢复链接 {{ r.effects.restoredShareIds?.length || 0 }} 条 · 回挂工单 {{ r.effects.restoredTicketIds?.length || 0 }} 张
      </span>
    </div>

    <p v-if="r.reason && !compact" class="note">退役原因：“{{ r.reason }}”</p>
    <p v-if="r.decideNote" class="dnote">审批备注：“{{ r.decideNote }}”</p>
    <p v-if="r.status === RETIRE.REVOKED && r.revokeNote" class="dnote restore-note">撤销退役说明：“{{ r.revokeNote }}”（{{ userName(r.revokedBy) }} · {{ formatFull(r.revokedAt) }}）</p>

    <!-- 管理员逐篇审批 -->
    <div v-if="canDecideRetirement(r, auth.user?.id, auth.user?.role)" class="decide-box">
      <input v-model="note" class="note-in" placeholder="审批备注（可选，写入本篇退役记录）" />
      <div class="decide-actions">
        <button class="btn sm" :disabled="busy" @click="decide('reject')">✕ 驳回</button>
        <button class="btn sm ok-solid" :disabled="busy" @click="decide('approve')">✓ 批准退役</button>
      </div>
    </div>

    <!-- 发起人/管理员撤销申请（审批前） -->
    <div v-if="canCancelRetirement(r, auth.user?.id, auth.user?.role)" class="row-actions">
      <button class="btn sm ghost" @click="cancel">撤销本篇申请</button>
    </div>

    <!-- 发起人/管理员撤销已生效退役 -->
    <div v-if="canRevokeRetirement(r, auth.user?.id, auth.user?.role)" class="decide-box">
      <input v-model="revokeNote" class="note-in" placeholder="撤销退役说明（可选，写入记录）" />
      <button class="btn sm restore-solid" :disabled="busy" @click="revoke">↩ 撤销本篇并恢复</button>
    </div>

    <details v-if="!compact" class="timeline">
      <summary>查看退役记录（{{ (r.timeline || []).length }}）</summary>
      <div v-for="(t, i) in r.timeline || []" :key="i" class="tl">
        <span class="tl-act">{{ retireTimelineLabel(t.action) }}</span>
        <span class="tl-who">{{ userName(t.by) }}</span>
        <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
        <span class="tl-tm">{{ formatFull(t.at) }}</span>
      </div>
    </details>
  </div>
</template>

<style scoped>
.rt-item { padding: 14px 18px; }
.rt-item.compact { padding: 12px 14px; background: var(--panel-2); border-radius: 10px; }
.rt-top { display: flex; justify-content: space-between; gap: 14px; }
.rt-flow { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 700; flex-wrap: wrap; min-width: 0; }
.compact .rt-flow { font-size: 13px; }
.rt-doc { cursor: pointer; overflow: hidden; text-overflow: ellipsis; }
.rt-doc.old { color: var(--text-2); }
.rt-doc.old:hover { color: var(--danger); }
.rt-doc.rep { color: var(--primary); }
.rt-doc.rep:hover { text-decoration: underline; }
.arrow { color: var(--text-3); font-weight: 400; }
.rep-gone { font-size: 12px; color: var(--danger); font-weight: 400; }
.rt-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-retired { background: #e2e8f0; color: #475569; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-restore { background: #dcfce7; color: #15803d; }
.rt-time { color: var(--text-3); font-size: 12px; }

.rt-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 13px; }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.dim { color: var(--text-3); font-size: 12px; }
.restore-dim { color: #15803d; }
.note { margin: 8px 0 0; font-size: 13px; color: var(--text-2); }
.dnote { margin: 6px 0 0; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.restore-note { background: #f0fdf4; color: #15803d; }

.decide-box { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.note-in { flex: 1; min-width: 180px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; outline: none; }
.note-in:focus { border-color: var(--primary); }
.decide-actions { display: flex; gap: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.restore-solid { background: #15803d; border-color: #15803d; color: #fff; }
.btn.restore-solid:hover { background: #166534; color: #fff; }
.row-actions { margin-top: 8px; }

.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 200px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
