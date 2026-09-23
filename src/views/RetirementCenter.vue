<script setup>
import { ref, computed, onMounted } from 'vue'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useRetirementStore } from '@/stores/retirement'
import { formatDate, formatFull } from '@/utils/format'
import {
  RETIRE_BATCH, retirementBatchStatusLabel, retirementBatchProgress, isRetirementActive
} from '@/utils/retirement'
import RetirementCard from '@/components/doc/RetirementCard.vue'
import RetirementBatchDialog from '@/components/doc/RetirementBatchDialog.vue'

const kb = useKbStore()
const auth = useAuthStore()
const retirementStore = useRetirementStore()

const tab = ref('approve') // approve | mine | all
const showBatchDialog = ref(false)
const batchBusy = ref('')
const batchNoteMap = ref({})

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

const approveList = computed(() => retirementStore.pendingApprovalFor(auth.user?.role))
const mineList = computed(() => retirementStore.initiatedBy(auth.user?.id))
const allList = computed(() =>
  auth.user?.role === 'admin' ? retirementStore.sorted : retirementStore.involvedIn(auth.user?.id)
)
const activeList = computed(() => {
  if (tab.value === 'approve') return approveList.value
  if (tab.value === 'mine') return mineList.value
  return allList.value
})

// 把当前 tab 的退役单组织成「批次组 + 独立单篇」：批次内按送审顺序排列
const groups = computed(() => {
  const batchMap = new Map()
  const standalone = []
  for (const r of activeList.value) {
    if (r.batchId) {
      if (!batchMap.has(r.batchId)) batchMap.set(r.batchId, [])
      batchMap.get(r.batchId).push(r)
    } else {
      standalone.push(r)
    }
  }
  const batchGroups = []
  for (const [batchId, items] of batchMap) {
    batchGroups.push({ batch: retirementStore.batchById(batchId), items: items.sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0)) })
  }
  // 组排序：按批次创建时间倒序；独立单篇按退役单时间倒序（activeList 已倒序）
  batchGroups.sort((a, b) => new Date(b.batch.createdAt) - new Date(a.batch.createdAt))
  return { batchGroups, standalone }
})

const counts = computed(() => ({
  approve: approveList.value.length,
  mine: mineList.value.length,
  all: allList.value.length
}))

// 批次状态直接由 items 派生（batchStatusById 已计算，这里兜底）
function batchStatus(items) {
  return retirementStore.batchStatusById[items[0]?.batchId]
}
function progressOf(items) {
  return retirementBatchProgress(items)
}
function statusLabelOf(items) {
  return retirementBatchStatusLabel(batchStatus(items))
}
function batchGroupCls(items) {
  return {
    [RETIRE_BATCH.ACTIVE]: 'bg-active',
    [RETIRE_BATCH.RESOLVED]: 'bg-resolved',
    [RETIRE_BATCH.ACTIVE_RETIRED]: 'bg-retired',
    [RETIRE_BATCH.REVERTED]: 'bg-reverted'
  }[batchStatus(items)] || ''
}
function canManageBatch(batch) {
  return batch && (batch.initiatedBy === auth.user?.id || auth.user?.role === 'admin')
}

async function cancelBatch(batch) {
  if (batchBusy.value) return
  if (!confirm('确定整体取消该批次中仍待审批的退役申请？已结案（批准/驳回）的篇不受影响。')) return
  batchBusy.value = batch.id
  try {
    const res = await retirementStore.cancelRetirementBatch(batch.id, auth.user)
    if (res.status === 'ok') alert('已取消 ' + res.cancelled.length + ' 篇待审批申请。')
    else if (res.status === 'denied') alert('只有批次发起人或管理员可以整体取消。')
    else if (res.status === 'changed') alert('该批次已无待审批篇。')
    else alert('操作失败：批次状态已变化')
  } finally {
    batchBusy.value = ''
  }
}

async function revokeBatch(batch) {
  if (batchBusy.value) return
  const activeCount = retirementStore.itemsOfBatch(batch.id).filter((r) => isRetirementActive(r)).length
  if (!activeCount) { alert('该批次已无生效中的退役。'); return }
  if (!confirm('确定批量撤销该批次的 ' + activeCount + ' 篇已生效退役？将逐篇恢复搜索/问答引用、共享链接与答案来源（单篇被另行处理时不影响其他篇）。')) return
  batchBusy.value = batch.id
  try {
    const res = await retirementStore.revokeRetirementBatch(batch.id, (batchNoteMap.value[batch.id] || '').trim(), auth.user)
    if (res.status === 'ok') alert('批量撤销完成：成功 ' + res.done + ' 篇' + (res.failed ? '，' + res.failed + ' 篇因状态变化未撤销' : ''))
    else if (res.status === 'denied') alert('只有批次发起人或管理员可以批量撤销。')
    else if (res.status === 'changed') alert('该批次已无生效中的退役。')
    else alert('操作失败')
  } finally {
    batchBusy.value = ''
  }
}

function onBatchSubmitted() {
  tab.value = 'mine'
}

onMounted(async () => {
  await Promise.all([kb.loadAll(), auth.loadUsers(), retirementStore.loadAll()])
  if (approveList.value.length) tab.value = 'approve'
  else tab.value = 'mine'
})
</script>

<template>
  <div class="rt-page">
    <header class="head">
      <div class="head-row">
        <h2>🗄 知识退役替代</h2>
        <button class="btn sm primary batch-btn" @click="showBatchDialog = true">📦 批量退役 · 统一送审</button>
      </div>
      <p class="sub">
        负责人可一次为多篇文档<b>分别指定替代文档并统一送审</b>，管理员<b>逐篇批准</b>；
        审批通过后逐篇停止旧文档的搜索与问答引用、撤销其共享链接，并把已解决缺口工单的答案来源改挂对应替代文档；
        替代文档无权限时可申请访问。退役可逐篇或按批撤销，共享链接与答案来源同步恢复，全程留痕。
      </p>
      <div class="tabs">
        <button v-if="auth.user?.role === 'admin'" :class="{ on: tab === 'approve' }" @click="tab = 'approve'">待审批 <em>{{ counts.approve }}</em></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我发起的 <em>{{ counts.mine }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部记录 <em>{{ counts.all }}</em></button>
      </div>
    </header>

    <div v-if="!activeList.length" class="empty card">
      <div class="ico">🗄</div>
      {{ tab === 'approve' ? '暂无待审批的退役申请' : tab === 'mine' ? '你还没有发起过文档退役（可单篇在文档详情页发起，或点击右上角批量送审）' : '暂无退役记录' }}
    </div>

    <div v-else class="rt-list">
      <!-- 批次分组 -->
      <section v-for="g in groups.batchGroups" :key="g.batch.id" class="batch card" :class="batchGroupCls(g.items)">
        <header class="bg-head">
          <div class="bg-title">
            <span class="bg-ico">📦</span>
            <b>退役批次</b>
            <span class="bg-status">{{ statusLabelOf(g.items) }}</span>
            <span class="bg-prog">{{ progressOf(g.items).done }}/{{ progressOf(g.items).total }} 已处理
              <template v-if="progressOf(g.items).approved">（生效 {{ progressOf(g.items).approved }}）</template>
            </span>
          </div>
          <div class="bg-meta">
            <span>{{ userName(g.batch.initiatedBy) }} 发起 · {{ formatDate(g.batch.createdAt) }}</span>
            <div v-if="canManageBatch(g.batch)" class="bg-acts">
              <button v-if="progressOf(g.items).pending" class="btn xs ghost" :disabled="batchBusy === g.batch.id" @click="cancelBatch(g.batch)">整体取消待审批篇</button>
              <template v-if="progressOf(g.items).approved">
                <input v-model="batchNoteMap[g.batch.id]" class="bg-note" placeholder="批量撤销说明（可选）" />
                <button class="btn xs restore-solid" :disabled="batchBusy === g.batch.id" @click="revokeBatch(g.batch)">批量撤销生效篇（{{ progressOf(g.items).approved }}）</button>
              </template>
            </div>
          </div>
        </header>
        <p v-if="g.batch.note" class="bg-batchnote">批次说明：“{{ g.batch.note }}”</p>

        <!-- 进度条 -->
        <div class="bg-bar">
          <span class="seg approved" :style="{ flexGrow: progressOf(g.items).approved }"></span>
          <span class="seg rejected" :style="{ flexGrow: progressOf(g.items).rejected }"></span>
          <span class="seg cancelled" :style="{ flexGrow: progressOf(g.items).cancelled + progressOf(g.items).revoked }"></span>
          <span class="seg pending" :style="{ flexGrow: progressOf(g.items).pending }"></span>
        </div>

        <div class="bg-items">
          <RetirementCard v-for="r in g.items" :key="r.id" :r="r" compact />
        </div>

        <details class="bg-tl">
          <summary>批次操作记录（{{ (g.batch.timeline || []).length }}）</summary>
          <div v-for="(t, i) in g.batch.timeline || []" :key="i" class="tl">
            <span class="tl-who">{{ userName(t.by) }}</span>
            <span v-if="t.note" class="tl-note">{{ t.note }}</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </section>

      <!-- 独立单篇退役单（无批次，含历史单篇记录） -->
      <RetirementCard v-for="r in groups.standalone" :key="r.id" :r="r" class="card rt-card" />
    </div>

    <RetirementBatchDialog :open="showBatchDialog" @close="showBatchDialog = false" @submitted="onBatchSubmitted" />
  </div>
</template>

<style scoped>
.rt-page { max-width: 920px; margin: 0 auto; }
.head h2 { margin: 0; }
.head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.batch-btn { white-space: nowrap; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.primary:hover { filter: brightness(1.05); color: #fff; }
.btn.xs { font-size: 12px; padding: 4px 10px; }
.sub { color: var(--text-2); font-size: 13px; margin: 8px 0 14px; line-height: 1.7; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }

.rt-list { display: flex; flex-direction: column; gap: 14px; margin-top: 16px; }
.rt-card { padding: 0; overflow: hidden; }

.batch { padding: 16px 18px; border-left-width: 4px; border-left-style: solid; }
.bg-active { border-left-color: #f59e0b; }
.bg-retired { border-left-color: #64748b; }
.bg-resolved { border-left-color: #cbd5e1; }
.bg-reverted { border-left-color: #16a34a; }
.bg-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.bg-title { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.bg-ico { font-size: 16px; }
.bg-status { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: #fef3c7; color: #b45309; }
.bg-retired .bg-status { background: #e2e8f0; color: #475569; }
.bg-resolved .bg-status { background: var(--panel-2); color: var(--text-3); }
.bg-reverted .bg-status { background: #dcfce7; color: #15803d; }
.bg-prog { font-size: 12px; color: var(--text-3); }
.bg-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-3); }
.bg-acts { display: flex; align-items: center; gap: 6px; }
.bg-note { border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; outline: none; width: 170px; }
.bg-note:focus { border-color: var(--primary); }
.btn.restore-solid { background: #15803d; border-color: #15803d; color: #fff; }
.btn.restore-solid:hover { background: #166534; color: #fff; }
.bg-batchnote { margin: 8px 0 0; font-size: 12px; color: var(--text-2); }

.bg-bar { display: flex; height: 6px; border-radius: 999px; overflow: hidden; background: var(--panel-2); margin: 12px 0; gap: 2px; }
.seg { height: 100%; }
.seg.approved { background: #64748b; }
.seg.rejected { background: #f2555c; }
.seg.cancelled { background: #cbd5e1; }
.seg.pending { background: #f59e0b; }

.bg-items { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.bg-tl { margin-top: 10px; }
.bg-tl summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 3px 0; font-size: 12px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
