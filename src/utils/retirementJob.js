// 知识退役 · 分批编排（纯函数部分）：任务/篇目状态常量、暂态失败判定、结果归类与留痕文案。
// 编排执行器在 stores/retirement.js：任务持久化到 retirementJobs 表，分片逐篇独立事务执行
// （单篇联动原子提交，中断即回滚，不产生跨文档半联动状态），暂态失败就地重试、业务冲突
// 隔离不阻塞他篇，部分失败/进程中断可续跑（逐篇幂等重判，已成功篇目不重复联动）。
import { RETIRE } from './retirement'

// 编排任务类型：批量批准退役（逐篇生效联动）/ 批量撤销退役（逐篇恢复）
export const RETIRE_JOB_KIND = {
  APPROVE: 'approve',
  REVOKE: 'revoke'
}

// 任务状态：running 执行中（进程中断后由续跑接管）；done 全部成功；
// partial 存在冲突/失败篇（可续跑）；stopped 被请求停止（可续跑）
export const RETIRE_JOB = {
  RUNNING: 'running',
  DONE: 'done',
  PARTIAL: 'partial',
  STOPPED: 'stopped'
}

// 篇目状态：pending 待执行；running 执行中（中断残留，续跑时重置重判）；
// succeeded 成功（含幂等命中目标态）；conflict 业务冲突（隔离，人工处理后可续跑重判）；
// failed 失败（暂态重试耗尽或异常，可续跑重试）
export const RETIRE_JOB_ITEM = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  CONFLICT: 'conflict',
  FAILED: 'failed'
}

// 默认分片大小与单篇就地重试次数（执行器可通过 opts 覆盖，供测试与调优）
export const RETIRE_JOB_CHUNK_SIZE = 5
export const RETIRE_JOB_MAX_ITEM_ATTEMPTS = 2

export function retireJobKindLabel(kind) {
  return { approve: '批量批准退役', revoke: '批量撤销退役' }[kind] || kind
}

export function retireJobStatusLabel(status) {
  return {
    running: '执行中',
    done: '全部完成',
    partial: '部分完成（可续跑）',
    stopped: '已停止（可续跑）'
  }[status] || status
}

export function retireJobItemStatusLabel(status) {
  return {
    pending: '待执行',
    running: '执行中',
    succeeded: '成功',
    conflict: '冲突待处理',
    failed: '失败可重试'
  }[status] || status
}

// 暂态失败判定：IndexedDB 事务中断/配额/超时等环境性异常可安全重试；
// 业务冲突以结果状态返回（不抛异常），不会进入此分支
const TRANSIENT_ERROR_NAMES = new Set([
  'QuotaExceededError', 'AbortError', 'TimeoutError', 'TransactionInactiveError',
  'PrematureCommitError', 'UnknownError', 'InternalError', 'InvalidStateError'
])

export function isTransientRetirementError(err) {
  if (!err) return false
  if (err.transient === true) return true
  return TRANSIENT_ERROR_NAMES.has(err.name)
}

// 篇目是否仍待处理（续跑时重新判定）：待执行/执行中残留/冲突/失败
export function isJobItemRemaining(item) {
  return !!item && [
    RETIRE_JOB_ITEM.PENDING, RETIRE_JOB_ITEM.RUNNING,
    RETIRE_JOB_ITEM.CONFLICT, RETIRE_JOB_ITEM.FAILED
  ].includes(item.status)
}

// 任务/篇目列表的进度统计
export function jobProgressOf(jobOrItems) {
  const items = Array.isArray(jobOrItems) ? jobOrItems : jobOrItems?.items || []
  const c = { total: items.length, pending: 0, running: 0, succeeded: 0, conflict: 0, failed: 0 }
  for (const it of items) {
    if (c[it.status] !== undefined) c[it.status]++
  }
  c.remaining = c.pending + c.running + c.conflict + c.failed
  return c
}

// 任务是否可续跑：未全部成功且仍有待处理篇目
export function isJobResumable(job) {
  return !!job && job.status !== RETIRE_JOB.DONE && jobProgressOf(job).remaining > 0
}

// 篇目执行结果归类（纯函数）：
// ok → succeeded；changed 但退役单已处于目标态 → succeeded（幂等跳过，不重复联动）；
// 其余业务结果 → conflict（冲突隔离：不自动重试、不阻塞他篇，人工处理后可续跑重判）
export function classifyRetirementStepResult(kind, res) {
  const goal = kind === RETIRE_JOB_KIND.APPROVE ? RETIRE.APPROVED : RETIRE.REVOKED
  if (res?.status === 'ok') {
    return { outcome: RETIRE_JOB_ITEM.SUCCEEDED, message: retireJobResultLabel(kind, res) }
  }
  if (res?.status === 'changed' && res?.retirement?.status === goal) {
    return { outcome: RETIRE_JOB_ITEM.SUCCEEDED, message: '已处于目标状态，幂等跳过（不重复联动）' }
  }
  return { outcome: RETIRE_JOB_ITEM.CONFLICT, message: retireJobResultLabel(kind, res) }
}

// 篇目执行结果文案（写入篇目留痕与面板展示）
export function retireJobResultLabel(kind, res) {
  const table = {
    approve: {
      ok: '批准生效：停止搜索/问答引用、撤销共享链接、答案来源改挂替代文档',
      changed: '退役单状态已变化（被他人先行处理）',
      missing: '退役单不存在',
      'doc-missing': '旧文档已被删除',
      'replacement-missing': '替代文档已不存在',
      'replacement-retired': '替代文档已退役或在退役流程中',
      'used-as-replacement': '本文档正被用作其他退役的替代文档',
      'in-review': '文档评审中，待评审完结',
      'in-handover': '文档责任交接中，待交接完结',
      denied: '无审批权限',
      guest: '未登录'
    },
    revoke: {
      ok: '撤销退役并恢复：搜索/问答引用、共享链接与答案来源已还原',
      changed: '退役单状态已变化（被他人先行处理）',
      missing: '退役单不存在',
      'doc-missing': '旧文档已被删除',
      denied: '无撤销权限',
      guest: '未登录'
    }
  }
  return table[kind]?.[res?.status] || ('未预期结果：' + (res?.status || 'error'))
}

// 任务时间线动作文案（任务级留痕全程保留）
export function retireJobTimelineLabel(action) {
  return {
    'job-initiate': '创建编排任务',
    'job-resume': '续跑剩余篇目',
    'job-stopped': '分片边界停止',
    'job-finish': '编排执行完成'
  }[action] || action
}
