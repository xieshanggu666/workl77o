<script setup>
// 编排作业面板：展示某退役批次关联的全部可重试分批编排作业
// （批量送审 / 批量批准 / 批量撤销恢复）的进度、逐篇状态、失败原因与全链路时间线，
// 提供「仅重试失败/待处理篇」「中止运行中作业」入口（部分失败续跑、冲突隔离）。
import { computed } from 'vue'
import { useOrchestrationStore } from '@/stores/orchestration'
import { useAuthStore } from '@/stores/auth'
import { formatFull } from '@/utils/format'
import {
  jobStatusLabel, jobStatusCls, itemStatusLabel, itemStatusCls,
  orchestrationErrorLabel, orchestrationActionLabel, isStaleJob
} from '@/utils/orchestration'

const props = defineProps({
  refId: { type: String, required: true }
})

const orchestration = useOrchestrationStore()
const auth = useAuthStore()

const jobs = computed(() => orchestration.jobsByRef(props.refId))

const actionLabel = (job) => ({
  'batch-submit': '📤 批量送审',
  'batch-approve': '✅ 批量批准生效',
  'batch-revoke': '↩️ 批量撤销恢复'
}[job.action] || orchestrationActionLabel(job.action))

function progress(job) {
  return orchestration.progressOf(job)
}
function canRetry(job) {
  return ['partial', 'failed', 'aborted', 'completed'].includes(job.status) || isStaleJob(job)
}
function canAbort(job) {
  return job.status === 'running' && !job.abortRequested
}

async function retry(job) {
  const p = progress(job)
  if (!confirm('仅重试该作业的失败/未处理篇（已成功的篇不重放）？' +
    (p.failed ? '\n失败 ' + p.failed + ' 篇将在解除冲突后续跑。' : ''))) return
  await orchestration.retryFailed(job.id, auth.user)
}
async function abort(job) {
  if (!confirm('中止该作业？当前批次跑完后停止，已成功的篇保留，其余篇可随时续跑。')) return
  await orchestration.abort(job.id, auth.user)
}
</script>

<template>
  <div v-if="jobs.length" class="jobs">
    <section v-for="job in jobs" :key="job.id" class="job" :class="jobStatusCls(job.status)">
      <header class="j-head">
        <span class="j-act">{{ actionLabel(job) }}</span>
        <span class="j-status" :class="jobStatusCls(job.status)">
          {{ isStaleJob(job) ? '中断待续跑' : jobStatusLabel(job.status) }}
        </span>
        <span class="j-meta">{{ formatFull(job.createdAt) }} · 第 {{ job.runCount || 0 }} 次运行</span>
        <span v-if="job.abortRequested" class="j-abort-flag">中止请求已发出</span>
        <span class="j-spacer"></span>
        <button v-if="canRetry(job)" class="btn xs primary" @click="retry(job)">
          {{ isStaleJob(job) ? '断点续跑' : '重试失败/未处理篇' }}
        </button>
        <button v-if="canAbort(job)" class="btn xs ghost" @click="abort(job)">中止</button>
      </header>

      <div class="j-bar">
        <span class="seg ok" :style="{ flexGrow: progress(job).succeeded }"></span>
        <span class="seg fail" :style="{ flexGrow: progress(job).failed }"></span>
        <span class="seg skip" :style="{ flexGrow: progress(job).skipped }"></span>
        <span class="seg wait" :style="{ flexGrow: progress(job).pending + progress(job).running }"></span>
      </div>
      <div class="j-count">
        共 {{ progress(job).total }} 篇 · 成功 {{ progress(job).succeeded }}
        <template v-if="progress(job).failed"> · <b class="c-fail">失败 {{ progress(job).failed }}</b></template>
        <template v-if="progress(job).skipped"> · 跳过 {{ progress(job).skipped }}</template>
        <template v-if="progress(job).pending + progress(job).running">
          · 待处理/处理中 {{ progress(job).pending + progress(job).running }}
        </template>
      </div>

      <ul v-if="orchestration.itemsOf(job.id).some((x) => x.status !== 'succeeded')" class="j-items">
        <li v-for="it in orchestration.itemsOf(job.id)" :key="it.id"
            v-show="it.status !== 'succeeded'" :class="['it', itemStatusCls(it.status)]">
          <span class="it-title">《{{ it.title || it.key }}》</span>
          <span class="it-status">{{ itemStatusLabel(it.status) }}</span>
          <span v-if="it.status === 'failed'" class="it-err">
            ⚠ {{ orchestrationErrorLabel(it.errorCode) }}
            <template v-if="it.errorTitle">（{{ it.errorTitle }}）</template>
            · 已尝试 {{ it.attempts?.length || 0 }} 次
          </span>
          <span v-else-if="it.status === 'skipped'" class="it-err">状态已变化，无需处理</span>
        </li>
      </ul>

      <details class="j-tl">
        <summary>全链路操作记录（{{ (job.timeline || []).length }}）</summary>
        <div v-for="(t, i) in job.timeline || []" :key="i" class="tl">
          <span class="tl-note">{{ orchestrationActionLabel(t.action) }}<template v-if="t.note"> · {{ t.note }}</template></span>
          <span class="tl-tm">{{ formatFull(t.at) }}</span>
        </div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.jobs { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.job { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--panel-2); }
.job.st-no { border-left: 3px solid #f2555c; }
.job.st-pending { border-left: 3px solid #f59e0b; }
.job.st-restore { border-left: 3px solid #16a34a; }
.job.st-off { border-left: 3px solid #cbd5e1; }
.j-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.j-act { font-weight: 600; }
.j-status { padding: 1px 8px; border-radius: 999px; background: #e2e8f0; color: #475569; }
.j-status.st-no { background: #fee2e2; color: #b91c1c; }
.j-status.st-pending { background: #fef3c7; color: #b45309; }
.j-status.st-restore { background: #dcfce7; color: #15803d; }
.j-status.st-off { background: var(--panel-2); color: var(--text-3); }
.j-meta { color: var(--text-3); }
.j-abort-flag { color: #b45309; }
.j-spacer { flex: 1; }
.btn.xs { font-size: 12px; padding: 3px 10px; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.j-bar { display: flex; height: 5px; border-radius: 999px; overflow: hidden; background: var(--panel); margin: 8px 0 4px; gap: 2px; }
.seg { height: 100%; }
.seg.ok { background: #16a34a; }
.seg.fail { background: #f2555c; }
.seg.skip { background: #cbd5e1; }
.seg.wait { background: #f59e0b; }
.j-count { font-size: 12px; color: var(--text-3); }
.c-fail { color: #b91c1c; }
.j-items { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.it { font-size: 12px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.it-status { color: var(--text-3); }
.it-err { color: #b91c1c; }
.it.st-off .it-err { color: var(--text-3); }
.j-tl { margin-top: 6px; }
.j-tl summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; padding: 2px 0; color: var(--text-2); }
.tl-tm { color: var(--text-3); flex-shrink: 0; }
</style>
