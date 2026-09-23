// 可重试分批编排引擎：持久化 runner（Dexie）
//
// 作业（batchJobs）记录整体状态、进度、心跳租约、中止标志与时间线；
// 篇记录（batchJobItems）逐篇持久化状态、业务载荷、每次尝试结果（attempts）与错误。
//
// 执行模型：
// - enqueueJob：handler.setup 内由业务方建立业务批次，同时建档作业与逐篇记录，同一事务原子写入。
// - runJob：仅处理 pending/running 篇；每篇一个独立业务事务（冲突隔离）；每 chunkSize 篇为一批，
//   批间更新心跳、检查中止标志并让出事件循环（页面可中止/刷新，避免长任务锁死 UI）。
// - 崩溃续跑：running 作业心跳超过 STALE_MS 后可被 resumeStaleJobs 接管，逐篇幂等重放
//   （runItem 必须幂等，由业务层状态检查保证）。
// - retryFailedJob：只把 failed 篇重置为 pending 后续跑；succeeded/skipped 不重放。
//
// 视图同步钩子（由 Pinia store 传入）：
// onJob(job) / onItems(items) 在每个 item 状态落库、每批推进与作业终态时触发，刷新响应式列表。
import { uid } from './format'
import { db } from '@/db'
import { buildTimelineEntry } from './review'
import {
  JOB, ITEM, JOB_TABLE, ITEM_TABLE, DEFAULT_CHUNK,
  getBatchHandler, isJobTerminal, isStaleJob,
  classifyItemResult, isResultRetryable, jobStatusOfItems
} from './orchestration'

function nowIso() { return new Date().toISOString() }

// 建档：在业务 handler.setup 的同一事务内写入作业与逐篇记录。
// payload:
// { module, action, refId?, refType?, title?, createdBy, items: [{ key, title, payload }],
//   chunkSize?, setupPayload?, partial?, note? }
// 返回 { job, items }（已带 id，供 setup 业务记录引用）
export async function enqueueJob(payload, tx) {
  const handler = getBatchHandler(payload.module, payload.action)
  if (!handler) throw new Error('未注册的编排处理器：' + payload.module + ':' + payload.action)
  const created = nowIso()
  const jobId = uid('job')
  const items = (payload.items || []).map((it, i) => ({
    id: uid('jbi'),
    jobId,
    key: String(it.key ?? i),
    index: i,
    title: it.title || '',
    entityId: it.entityId || null,
    status: ITEM.PENDING,
    payload: it.payload || {},
    errorCode: null,
    errorTitle: '',
    attempts: [],
    startedAt: null,
    finishedAt: null,
    createdAt: created
  }))
  const job = {
    id: jobId,
    module: payload.module,
    action: payload.action,
    refId: payload.refId || null,
    refType: payload.refType || null,
    title: payload.title || '',
    note: payload.note || '',
    status: JOB.PENDING,
    createdBy: payload.createdBy || null,
    total: items.length,
    chunkSize: payload.chunkSize || DEFAULT_CHUNK,
    runCount: 0,
    runId: null,
    heartbeatAt: null,
    abortRequested: false,
    abortRequestedBy: null,
    partial: !!payload.partial,
    setupPayload: payload.setupPayload || null,
    createdAt: created,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    timeline: [buildTimelineEntry('job-create', payload.createdBy || 'system',
      (payload.title || '编排作业') + ' 建档，共 ' + items.length + ' 篇', created)]
  }
  const scope = tx || db
  await scope.table(JOB_TABLE).add(job)
  if (items.length) await scope.table(ITEM_TABLE).bulkAdd(items)
  // 业务批次在同一事务建档（如退役批次单），失败整体回滚（作业与业务批次不会出现半成品）
  if (typeof handler.setup === 'function') {
    await handler.setup({ job, items, tx: scope, ...(payload.setupPayload || {}) })
  }
  return { job, items }
}

// 运行作业到终止/中止。仅 pending、running 篇会被处理。
// opts: { force?: 强制接管（续跑）, userId, hooks: { onJob, onItems, afterFinish } }
export async function runJob(jobId, opts = {}) {
  const job0 = await db.table(JOB_TABLE).get(jobId)
  if (!job0) return { status: 'job-missing' }
  if (isJobTerminal(job0)) return { status: 'job-terminal', job: job0 }
  if (job0.status === JOB.RUNNING && !opts.force && !isStaleJob(job0)) {
    return { status: 'job-locked', job: job0 }
  }
  const handler = getBatchHandler(job0.module, job0.action)
  if (!handler) return { status: 'handler-missing', job: job0 }
  const hooks = opts.hooks || {}
  const userId = opts.userId || job0.createdBy || 'system'
  const actor = opts.actor || null

  const resumed = job0.status === JOB.RUNNING
  const runId = uid('run')
  await db.transaction('rw', db[JOB_TABLE], db[ITEM_TABLE], async () => {
    const j = await db.table(JOB_TABLE).get(jobId)
    const tlNote = resumed ? '心跳超时/继续执行，断点续跑（逐篇幂等）' : '开始分批执行'
    j.status = JOB.RUNNING
    j.runId = runId
    j.runCount = (j.runCount || 0) + 1
    j.startedAt = j.startedAt || nowIso()
    j.heartbeatAt = nowIso()
    j.abortRequested = false
    j.finishedAt = null
    j.timeline = [...(j.timeline || []), buildTimelineEntry(resumed ? 'job-resume' : 'job-start', userId, tlNote, nowIso())]
    await db.table(JOB_TABLE).put(j)
  })
  hooks.onJob?.(await db.table(JOB_TABLE).get(jobId))

  // 主循环：按批取 pending/running 篇（succeeded/skipped/failed 不重放——failed 走 retryFailedJob）
  let aborted = false
  for (;;) {
    const chunk = await db.table(ITEM_TABLE)
      .where('jobId').equals(jobId)
      .filter((x) => x.status === ITEM.PENDING || x.status === ITEM.RUNNING)
      .sortBy('index')
    if (!chunk.length) break

    // 中止检查（标志由 abortJob 落库，UI/续跑都能看到）
    const jReq = await db.table(JOB_TABLE).get(jobId)
    if (jReq.abortRequested) {
      aborted = true
      break
    }

    const batch = chunk.slice(0, job0.chunkSize || DEFAULT_CHUNK)
    const afterItems = []
    for (const it of batch) {
      const attemptNo = (it.attempts?.length || 0) + 1
      // 标记 running 并落心跳（崩溃点之后 resume 可凭 item.status=running 幂等重放本篇）
      await db.transaction('rw', db[JOB_TABLE], db[ITEM_TABLE], async () => {
        const now = nowIso()
        await db.table(ITEM_TABLE).update(it.id, { status: ITEM.RUNNING, startedAt: it.startedAt || now })
        await db.table(JOB_TABLE).update(jobId, { heartbeatAt: now })
      })

      let res = null
      let thrown = null
      try {
        res = await handler.runItem(it, {
          job: await db.table(JOB_TABLE).get(jobId),
          userId, runId, attemptNo,
          actor: opts.actor || null
        })
      } catch (e) {
        thrown = e
      }

      const now = nowIso()
      let next
      let attempt
      if (thrown) {
        next = ITEM.FAILED
        attempt = {
          no: attemptNo, at: now, by: userId, runId,
          status: ITEM.FAILED, errorCode: 'exception', errorTitle: String(thrown?.message || thrown),
          retryable: true
        }
      } else {
        next = classifyItemResult(res)
        attempt = {
          no: attemptNo, at: now, by: userId, runId,
          status: next,
          resultStatus: res?.status || null,
          errorCode: next === ITEM.FAILED ? (res?.status || 'error') : null,
          errorTitle: next === ITEM.FAILED ? (res?.title || res?.errorTitle || '') : '',
          retryable: next === ITEM.FAILED ? isResultRetryable(res) : false,
          detail: next === ITEM.SUCCEEDED ? sanitize(res) : null
        }
      }

      const patch = {
        status: next,
        finishedAt: now,
        errorCode: attempt.errorCode,
        errorTitle: attempt.errorTitle || '',
        attempts: [...(it.attempts || []), attempt]
      }
      await db.transaction('rw', db[JOB_TABLE], db[ITEM_TABLE], async () => {
        await db.table(ITEM_TABLE).update(it.id, patch)
        const j2 = await db.table(JOB_TABLE).get(jobId)
        j2.heartbeatAt = now
        if (next === ITEM.FAILED) {
          j2.lastError = attempt.errorCode + (attempt.errorTitle ? '：' + attempt.errorTitle : '')
        }
        await db.table(JOB_TABLE).put(j2)
      })
      const saved = await db.table(ITEM_TABLE).get(it.id)
      afterItems.push(saved)
      hooks.onItem?.(saved)
    }
    hooks.onItems?.(afterItems)
    hooks.onJob?.(await db.table(JOB_TABLE).get(jobId))

    // 批间让出事件循环：页面可渲染进度、落中止标志或直接关闭（崩溃续跑由心跳租约兜底）
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return finalizeJob(jobId, { aborted, userId, actor, hooks })
}

async function finalizeJob(jobId, { aborted, userId, hooks }) {
  const handler = getBatchHandler((await db.table(JOB_TABLE).get(jobId)).module,
    (await db.table(JOB_TABLE).get(jobId)).action)
  let finalJob
  await db.transaction('rw', db[JOB_TABLE], db[ITEM_TABLE], ...(handler.setupTables?.() || []), async () => {
    const job = await db.table(JOB_TABLE).get(jobId)
    const items = await db.table(ITEM_TABLE).where('jobId').equals(jobId).toArray()
    const status = jobStatusOfItems(items, { aborted })
    const now = nowIso()
    const n = {
      succeeded: items.filter((x) => x.status === ITEM.SUCCEEDED).length,
      failed: items.filter((x) => x.status === ITEM.FAILED).length,
      skipped: items.filter((x) => x.status === ITEM.SKIPPED).length
    }
    const note = aborted
      ? '已中止：成功 ' + n.succeeded + ' / 失败 ' + n.failed + ' / 跳过 ' + n.skipped + '，待处理篇保留可续跑'
      : '执行完成：成功 ' + n.succeeded + ' / 失败 ' + n.failed + ' / 跳过 ' + n.skipped
    job.status = status
    job.finishedAt = now
    job.heartbeatAt = now
    job.runId = null
    job.timeline = [...(job.timeline || []), buildTimelineEntry(
      aborted ? 'job-aborted' : status === JOB.COMPLETED ? 'job-complete' : status === JOB.PARTIAL ? 'job-partial' : 'job-failed',
      userId, note, now)]
    await db.table(JOB_TABLE).put(job)
    // 业务批次状态/时间线回写（同一事务，避免编排作业与业务批次状态不一致）
    if (typeof handler.afterFinish === 'function') {
      await handler.afterFinish({ job, items, tx: db, userId, now })
    }
    finalJob = job
  })
  hooks.afterFinish?.(finalJob)
  hooks.onItems?.(await db.table(ITEM_TABLE).where('jobId').equals(jobId).toArray())
  hooks.onJob?.(await db.table(JOB_TABLE).get(jobId))
  return { status: 'ok', job: finalJob }
}

// 中止：running 作业请求中止（当前批次跑完后停止，已成功的篇保留）
export async function abortJob(jobId, user) {
  const userId = user?.id || 'system'
  let out
  await db.transaction('rw', db[JOB_TABLE], async () => {
    const job = await db.table(JOB_TABLE).get(jobId)
    if (!job) { out = { status: 'missing' }; return }
    if (isJobTerminal(job)) { out = { status: 'changed', job }; return }
    if (job.abortRequested) { out = { status: 'already', job }; return }
    const now = nowIso()
    job.abortRequested = true
    job.abortRequestedBy = userId
    job.timeline = [...(job.timeline || []), buildTimelineEntry('job-abort-request', userId, '请求中止：当前批次后停止', now)]
    await db.table(JOB_TABLE).put(job)
    out = { status: 'ok', job }
  })
  return out
}

// 只重试失败篇（partial/failed/aborted），随后立即续跑；若只有待处理篇（中止残留）也直接续跑
export async function retryFailedJob(jobId, user, opts = {}) {
  const userId = user?.id || 'system'
  let resetCount = 0
  let job
  await db.transaction('rw', db[JOB_TABLE], db[ITEM_TABLE], async () => {
    job = await db.table(JOB_TABLE).get(jobId)
    if (!job) return
    if (job.status === JOB.RUNNING && !isStaleJob(job)) return
    const now = nowIso()
    const failed = await db.table(ITEM_TABLE).where('jobId').equals(jobId)
      .filter((x) => x.status === ITEM.FAILED).toArray()
    for (const it of failed) {
      await db.table(ITEM_TABLE).update(it.id, {
        status: ITEM.PENDING, errorCode: null, errorTitle: '', finishedAt: null
      })
    }
    resetCount = failed.length
    job.status = JOB.PENDING
    job.abortRequested = false
    job.finishedAt = null
    job.heartbeatAt = null
    job.lastError = null
    job.timeline = [...(job.timeline || []), buildTimelineEntry('job-retry-failed', userId,
      '重置失败篇 ' + failed.length + ' 篇并续跑', now)]
    await db.table(JOB_TABLE).put(job)
  })
  if (!job) return { status: 'missing' }
  if (job.status === JOB.RUNNING && !isStaleJob(job)) return { status: 'job-locked', job }
  const run = await runJob(jobId, { force: true, userId, actor: opts.actor, hooks: opts.hooks })
  return { ...run, resetCount }
}

// 应用启动/刷新后：接管心跳超时的 running 作业（逐篇幂等重放），返回续跑结果
export async function resumeStaleJobs(opts = {}) {
  const running = await db.table(JOB_TABLE).where('status').equals(JOB.RUNNING).toArray()
  const stale = running.filter((j) => isStaleJob(j))
  const results = []
  for (const job of stale) {
    // 处理器未注册（模块未加载）的作业跳过，不破坏其他作业
    if (!getBatchHandler(job.module, job.action)) continue
    results.push(await runJob(job.id, { force: true, userId: job.createdBy || 'system', hooks: opts.hooks }))
  }
  return results
}

function sanitize(v) {
  if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) return v
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return null
  }
}
