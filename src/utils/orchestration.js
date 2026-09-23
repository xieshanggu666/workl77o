// 可重试分批编排引擎（纯函数 + 通用 runner，业务无关）
//
// 目标：把「批量退役与替代文档、共享链接、缺口答案来源、撤销恢复」这类多文档联动操作，
// 从「内存循环逐篇事务」升级为持久化的分批编排：
//
// - 分批执行：每个 item 独立事务，默认每批 chunkSize 篇，批间心跳写库并让出事件循环；
//   单篇失败只回滚该篇自己的事务（冲突隔离），不产生跨文档半成品状态。
// - 部分失败续跑：job/item 状态、错误、尝试次数全部持久化；运行中断（刷新/关闭标签页/崩溃）
//   后可凭心跳租约识别 stale 作业并断点续跑；失败篇外部条件解除后可只重试失败篇。
// - 全链路留痕：job.timeline（建档/执行/重试/中止/完成/续跑）+ item.attempts（每次尝试的
//   结果、错误、时间、执行人）全部入库；业务侧批次时间线由 handler.afterFinish 回写。
//
// 业务模块通过 registerBatchHandler 注册 handler：
// { module, action, runItem(item, ctx) -> 业务结果(需幂等), setupTables(), setup(...), afterFinish? }
import { uid } from './format'

export const JOB = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed', // 全部成功
  PARTIAL: 'partial', // 部分成功：至少一篇 succeeded，其余 failed/skipped
  FAILED: 'failed', // 无一篇成功，全部 failed/skipped
  ABORTED: 'aborted', // 用户中止（可能已有篇成功）
  STALE: 'stale' // 运行中失去心跳，等待续跑（瞬时标记，不持久化；由租约判定）
}

export const ITEM = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed', // 可重试（冲突/瞬时），外部条件解除后 retryFailed
  SKIPPED: 'skipped' // 状态已变化、业务上无需处理（幂等跳过），不计失败
}

// 需要人工/外部解除后才能重试的业务冲突码（区别于可自动重试的瞬时错误）
export const CONFLICT_CODES = new Set([
  'missing', 'doc-missing', 'replacement-missing', 'denied', 'guest',
  'changed', 'closed', 'in-retirement', 'in-review', 'in-handover',
  'used-as-replacement', 'replacement-retired', 'bad-replacement',
  'replacement-in-batch', 'duplicate-doc'
])

export const JOB_TABLE = 'batchJobs'
export const ITEM_TABLE = 'batchJobItems'
export const DEFAULT_CHUNK = 10
// 心跳超过该时长未更新的 running 作业视为崩溃/断连，可被接管续跑
export const STALE_MS = 30 * 1000

const handlers = new Map()
export function registerBatchHandler(handler) {
  if (!handler?.module || !handler?.action || typeof handler.runItem !== 'function') {
    throw new Error('batch handler 需要 module/action/runItem')
  }
  handlers.set(handler.module + ':' + handler.action, handler)
}
export function getBatchHandler(module, action) {
  return handlers.get(module + ':' + action) || null
}

export function isJobTerminal(job) {
  return !!job && [JOB.COMPLETED, JOB.PARTIAL, JOB.FAILED, JOB.ABORTED].includes(job.status)
}
export function isItemDone(item) {
  return !!item && [ITEM.SUCCEEDED, ITEM.SKIPPED].includes(item.status)
}
export function isItemTerminal(item) {
  return !!item && [ITEM.SUCCEEDED, ITEM.SKIPPED, ITEM.FAILED].includes(item.status)
}
export function isStaleJob(job, nowMs = Date.now()) {
  return !!job && job.status === JOB.RUNNING && !!job.heartbeatAt &&
    nowMs - new Date(job.heartbeatAt).getTime() > STALE_MS
}

// 业务结果归一化为 item 状态：
// - status 'ok' → succeeded；'skipped'/'changed' → skipped（业务幂等跳过）
// - 其他状态码 → failed（冲突码/未知码都持久化，前者提示需先解除条件，后者可直接重试）
// - runItem 抛异常 → failed（retryable=true），绝不击穿整个作业
export function classifyItemResult(res) {
  if (res?.status === 'ok') return ITEM.SUCCEEDED
  if (res?.status === 'skipped') return ITEM.SKIPPED
  return ITEM.FAILED
}

export function isResultRetryable(res) {
  if (!res) return true
  if (res.status === 'ok' || res.status === 'skipped') return false
  // 冲突类需外部解除后由用户手动重试（不自动续跑）；未知错误视为瞬时可重试
  return !CONFLICT_CODES.has(res.status)
}

// 由各 item 状态汇总作业终态
export function jobStatusOfItems(items, opts = {}) {
  if (opts.aborted) return JOB.ABORTED
  const list = items || []
  const nOk = list.filter((x) => x.status === ITEM.SUCCEEDED).length
  const nFail = list.filter((x) => x.status === ITEM.FAILED).length
  const nSkip = list.filter((x) => x.status === ITEM.SKIPPED).length
  const nDone = nOk + nFail + nSkip
  if (nDone < list.length) return JOB.RUNNING
  if (nFail === 0) return JOB.COMPLETED
  return nOk > 0 ? JOB.PARTIAL : (nSkip > 0 ? JOB.PARTIAL : JOB.FAILED)
}

export function jobProgress(job, items) {
  const list = items || []
  const p = {
    total: (job?.total) || list.length, pending: 0, running: 0,
    succeeded: 0, failed: 0, skipped: 0, done: 0
  }
  for (const it of list) {
    if (p[it.status] !== undefined) p[it.status]++
  }
  p.done = p.succeeded + p.failed + p.skipped
  return p
}

// 作业心跳租约对象（供运行方持有/判断）
export function leaseOf(job) {
  return { runId: job?.runId || null, heartbeatAt: job?.heartbeatAt || null }
}

// ---- 文案 ----
export function jobStatusLabel(s) {
  return {
    pending: '待执行',
    running: '执行中',
    completed: '全部成功',
    partial: '部分失败 · 可续跑',
    failed: '全部失败 · 可重试',
    aborted: '已中止 · 可续跑'
  }[s] || s
}
export function jobStatusCls(s) {
  return {
    pending: 'st-off',
    running: 'st-pending',
    completed: 'st-restore',
    partial: 'st-pending',
    failed: 'st-no',
    aborted: 'st-off'
  }[s] || ''
}
export function itemStatusLabel(s) {
  return {
    pending: '待处理',
    running: '处理中',
    succeeded: '成功',
    failed: '失败',
    skipped: '已跳过'
  }[s] || s
}
export function itemStatusCls(s) {
  return {
    pending: 'st-off',
    running: 'st-pending',
    succeeded: 'st-restore',
    failed: 'st-no',
    skipped: 'st-off'
  }[s] || ''
}
export function orchestrationActionLabel(action) {
  return {
    'job-create': '编排作业建档',
    'job-start': '开始分批执行',
    'job-heartbeat': '批次心跳',
    'job-chunk': '批次推进',
    'item-start': '开始处理篇',
    'item-retry': '失败篇重试',
    'item-error': '篇处理失败',
    'job-abort-request': '请求中止',
    'job-aborted': '作业已中止',
    'job-complete': '作业完成',
    'job-partial': '作业部分完成',
    'job-failed': '作业全部失败',
    'job-resume': '心跳超时，断点续跑',
    'job-retry-failed': '仅重试失败篇'
  }[action] || action
}

// 业务冲突码 → 中文（编排面板逐篇展示）
export function orchestrationErrorLabel(code) {
  return {
    missing: '文档不存在',
    'doc-missing': '旧文档已被删除',
    'replacement-missing': '替代文档已被删除',
    denied: '无操作权限',
    guest: '访客不可操作',
    changed: '状态已变化（无需处理）',
    closed: '对象已关闭',
    'in-retirement': '文档已退役或有在途退役单',
    'in-review': '文档评审中',
    'in-handover': '文档交接中',
    'used-as-replacement': '本文档正被他单用作替代文档',
    'replacement-retired': '替代文档已退役/在退役中',
    'bad-replacement': '替代文档不合法',
    'replacement-in-batch': '替代文档也在同批退役中',
    'duplicate-doc': '同篇文档重复'
  }[code] || (code ? '失败：' + code : '处理失败')
}
