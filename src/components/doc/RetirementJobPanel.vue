<script setup>
// 退役分批编排任务面板：展示批次下批量批准/批量撤销任务的分片执行进度、逐篇结果与留痕，
// 支持部分失败/中断后续跑（幂等重判）与执行中请求停止（分片边界生效）。
import { computed, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useRetirementStore } from '@/stores/retirement'
import { formatFull } from '@/utils/format'
import {
  RETIRE_JOB, RETIRE_JOB_ITEM, retireJobKindLabel, retireJobStatusLabel,
  retireJobItemStatusLabel, retireJobTimelineLabel, jobProgressOf, isJobResumable
} from '@/utils/retirementJob'

const props = defineProps({
  batch: { type: Object, required: true }
})

const auth = useAuthStore()
const retirementStore = useRetirementStore()
const busy = ref('')

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

const jobs = computed(() => retirementStore.jobsOfBatch(props.batch.id))
const progressOf = (job) => jobProgressOf(job)

function canOperate(job) {
  return job.initiatedBy === auth.user?.id || auth.user?.role === 'admin'
}
function resumable(job) {
  return isJobResumable(job) && !retirementStore.isJobExecuting(job.id)
}
function executing(job) {
  return retirementStore.isJobExecuting(job.id)
}

const ITEM_ICON = {
  [RETIRE_JOB_ITEM.PENDING]: '⏳',
  [RETIRE_JOB_ITEM.RUNNING]: '🔄',
  [RETIRE_JOB_ITEM.SUCCEEDED]: '✅',
  [RETIRE_JOB_ITEM.CONFLICT]: '⚠️',
  [RETIRE_JOB_ITEM.FAILED]: '❌'
}

async function resume(job) {
  if (busy.value) return
  busy.value = job.id
  try {
    const res = await retirementStore.resumeRetirementJob(job.id, auth.user)
    if (res.status === 'done') {
      alert('续跑完成：全部篇目处理成功。')
    } else if (res.status === 'partial') {
      alert('续跑完成：仍有 ' + res.summary.remaining + ' 篇未成功（冲突 ' + res.summary.conflict + ' / 失败 ' + res.summary.failed + '），处理对应篇目后可再次续跑。')
    } else if (res.status === 'stopped') {
      alert('任务已被停止，剩余篇目可再次续跑。')
    } else if (res.status === 'denied') {
      alert('只有任务发起人或管理员可以续跑该任务。')
    } else if (res.status === 'busy') {
      alert('任务正在执行中，请稍候。')
    }
  } finally {
    busy.value = ''
  }
}

async function stop(job) {
  if (!confirm('确定请求停止该编排任务？当前分片执行完后停止，剩余篇目可随时续跑。')) return
  const res = await retirementStore.stopRetirementJob(job.id, auth.user)
  if (res.status === 'denied') alert('只有任务发起人或管理员可以停止该任务。')
  else if (res.status === 'changed') alert('任务未在执行中。')
}
</script>

<template>
  <div v-if="jobs.length" class="job-panel">
    <section v-for="job in jobs" :key="job.id" class="job" :class="'js-' + job.status">
      <header class="jp-head">
        <span class="jp-kind">{{ retireJobKindLabel(job.kind) }}</span>
        <span class="jp-status">{{ executing(job) ? '执行中…' : retireJobStatusLabel(job.status) }}</span>
        <span class="jp-prog">{{ progressOf(job).succeeded }}/{{ progressOf(job).total }} 成功
          <template v-if="progressOf(job).conflict">· 冲突 {{ progressOf(job).conflict }}</template>
          <template v-if="progressOf(job).failed">· 失败 {{ progressOf(job).failed }}</template>
          <template v-if="progressOf(job).pending + progressOf(job).running">· 待执行 {{ progressOf(job).pending + progressOf(job).running }}</template>
        </span>
        <span class="jp-meta">{{ userName(job.initiatedBy) }} · {{ formatFull(job.createdAt) }}</span>
        <span class="jp-acts">
          <button v-if="executing(job)" class="btn xs ghost" @click="stop(job)">⏸ 停止</button>
          <button v-else-if="resumable(job) && canOperate(job)" class="btn xs resume-solid" :disabled="busy === job.id" @click="resume(job)">
            {{ busy === job.id ? '续跑中…' : '▶ 续跑剩余 ' + progressOf(job).remaining + ' 篇' }}
          </button>
        </span>
      </header>

      <!-- 分片执行进度：成功/冲突/失败/待执行 -->
      <div class="jp-bar">
        <span class="seg ok" :style="{ flexGrow: progressOf(job).succeeded }"></span>
        <span class="seg conflict" :style="{ flexGrow: progressOf(job).conflict }"></span>
        <span class="seg failed" :style="{ flexGrow: progressOf(job).failed }"></span>
        <span class="seg todo" :style="{ flexGrow: progressOf(job).pending + progressOf(job).running }"></span>
      </div>

      <!-- 逐篇结果（仅在有未完成篇目时展开，避免长列表噪音） -->
      <ul v-if="progressOf(job).remaining" class="jp-items">
        <li v-for="it in job.items.filter((x) => x.status !== 'succeeded')" :key="it.retirementId" :class="'it-' + it.status">
          <span class="it-ico">{{ ITEM_ICON[it.status] }}</span>
          <span class="it-doc">《{{ it.docTitle }}》</span>
          <span class="it-st">{{ retireJobItemStatusLabel(it.status) }}</span>
          <span v-if="it.lastError" class="it-err">{{ it.lastError }}</span>
          <span v-if="it.attempts > 1" class="it-try">第 {{ it.attempts }} 次尝试</span>
        </li>
      </ul>

      <details class="jp-tl">
        <summary>任务留痕（{{ (job.timeline || []).length }}）· 篇目尝试记录 {{ job.items.reduce((n, x) => n + (x.history || []).length, 0) }} 条</summary>
        <div v-for="(t, i) in job.timeline || []" :key="i" class="tl">
          <span class="tl-act">{{ retireJobTimelineLabel(t.action) }}</span>
          <span class="tl-who">{{ userName(t.by) }}</span>
          <span v-if="t.note" class="tl-note">{{ t.note }}</span>
          <span class="tl-tm">{{ formatFull(t.at) }}</span>
        </div>
        <div v-for="it in job.items" :key="it.retirementId">
          <div v-for="(h, i) in it.history || []" :key="it.retirementId + '-' + i" class="tl sub">
            <span class="tl-act">《{{ it.docTitle }}》第 {{ h.attempt }} 次</span>
            <span class="tl-note">{{ h.message }}</span>
            <span class="tl-tm">{{ formatFull(h.at) }}</span>
          </div>
        </div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.job-panel { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.job { border: 1px dashed var(--border); border-radius: 10px; padding: 10px 12px; background: var(--panel); }
.job.js-partial, .job.js-stopped { border-color: #f59e0b; background: #fffbeb; }
.job.js-done { border-color: #bbf7d0; background: #f0fdf4; }
.jp-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.jp-kind { font-weight: 700; color: var(--text-2); }
.jp-status { padding: 1px 8px; border-radius: 999px; background: var(--panel-2); color: var(--text-3); }
.js-partial .jp-status, .js-stopped .jp-status { background: #fef3c7; color: #b45309; }
.js-done .jp-status { background: #dcfce7; color: #15803d; }
.jp-prog { color: var(--text-3); }
.jp-meta { color: var(--text-3); }
.jp-acts { margin-left: auto; display: flex; gap: 6px; }
.btn.xs { font-size: 12px; padding: 3px 10px; }
.btn.resume-solid { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.resume-solid:hover { filter: brightness(1.05); color: #fff; }
.jp-bar { display: flex; height: 5px; border-radius: 999px; overflow: hidden; background: var(--panel-2); margin: 8px 0 4px; gap: 2px; }
.seg { height: 100%; }
.seg.ok { background: #16a34a; }
.seg.conflict { background: #f59e0b; }
.seg.failed { background: #f2555c; }
.seg.todo { background: #cbd5e1; }
.jp-items { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.jp-items li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.it-doc { color: var(--text-2); font-weight: 600; }
.it-st { color: var(--text-3); }
.it-conflict .it-st { color: #b45309; }
.it-failed .it-st { color: #b91c1c; }
.it-err { color: #b91c1c; }
.it-try { color: var(--text-3); }
.jp-tl { margin-top: 8px; }
.jp-tl summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 3px 0; font-size: 12px; }
.tl.sub { padding-left: 14px; }
.tl-act { color: var(--primary); font-weight: 600; min-width: 120px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
