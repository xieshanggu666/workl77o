import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import {
  enqueueJob, runJob, abortJob, retryFailedJob, resumeStaleJobs
} from '@/utils/batch-runner'
import { JOB_TABLE, ITEM_TABLE, isStaleJob, jobProgress, getBatchHandler } from '@/utils/orchestration'

// 可重试分批编排 store（业务无关）：
// 持有全部编排作业与逐篇记录的响应式镜像，引擎执行时通过钩子增量同步，
// 供退役中心等页面展示执行进度、逐篇冲突、重试/中止入口与全链路时间线。
export const useOrchestrationStore = defineStore('orchestration', () => {
  const jobs = ref([])
  const itemsByJob = ref({})
  const loaded = ref(false)

  async function loadAll() {
    await reload()
    loaded.value = true
  }

  async function reload() {
    const [js, its] = await Promise.all([
      db[JOB_TABLE].toArray(),
      db[ITEM_TABLE].toArray()
    ])
    jobs.value = js
    const map = {}
    for (const it of its) {
      (map[it.jobId] ||= []).push(it)
    }
    for (const arr of Object.values(map)) arr.sort((a, b) => a.index - b.index)
    itemsByJob.value = map
  }

  const sortedJobs = computed(() =>
    [...jobs.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  function jobById(id) {
    return jobs.value.find((j) => j.id === id) || null
  }
  function itemsOf(jobId) {
    return itemsByJob.value[jobId] || []
  }
  function progressOf(job) {
    return jobProgress(job, itemsOf(job?.id))
  }
  // 关联某业务记录（如退役批次 id）的作业，新到旧
  function jobsByRef(refId) {
    return sortedJobs.value.filter((j) => j.refId === refId)
  }
  // 心跳超时作业（供页面提示「可续跑」）
  function staleJobs() {
    return jobs.value.filter((j) => isStaleJob(j))
  }

  // 引擎执行钩子：增量同步响应式镜像
  function hooks() {
    const upsertJob = (j) => {
      if (!j) return
      const idx = jobs.value.findIndex((x) => x.id === j.id)
      if (idx >= 0) jobs.value[idx] = j
      else jobs.value.push(j)
    }
    const upsertItems = (list) => {
      for (const it of list || []) {
        const arr = itemsByJob.value[it.jobId] || (itemsByJob.value[it.jobId] = [])
        const idx = arr.findIndex((x) => x.id === it.id)
        if (idx >= 0) arr[idx] = it
        else arr.push(it)
        arr.sort((a, b) => a.index - b.index)
      }
    }
    return {
      onJob: upsertJob,
      onItem: (it) => upsertItems([it]),
      onItems: upsertItems
    }
  }

  // 建档并执行到终止（编排型批量动作统一入口）。payload.actor 为真实操作者对象（含角色），
  // 逐篇执行器据此做权限复核，避免凭作业建档身份提权。
  // 事务涉及的业务表由注册的 handler.setupTables() 统一声明（引擎不接收调用方传表）。
  async function enqueueAndRun(payload) {
    const handler = getBatchHandler(payload.module, payload.action)
    if (!handler) return { status: 'handler-missing' }
    const { job, items } = await db.transaction(
      'rw',
      db[JOB_TABLE], db[ITEM_TABLE],
      ...(handler.setupTables?.() || []),
      async (tx) => enqueueJob(payload, tx)
    )
    const baseHooks = hooks()
    const run = await runJob(job.id, {
      userId: payload.createdBy,
      actor: payload.actor || null,
      hooks: { ...baseHooks, afterFinish: async () => { await reload() } }
    })
    await reload()
    return { status: run.status, job: run.job || job, items }
  }

  async function abort(jobId, user) {
    const res = await abortJob(jobId, user)
    if (res.job) hooks().onJob(res.job)
    return res
  }

  async function retryFailed(jobId, user) {
    const res = await retryFailedJob(jobId, user, {
      actor: user || null,
      hooks: { ...hooks(), afterFinish: async () => { await reload() } }
    })
    await reload()
    return res
  }

  // 应用启动/刷新后接管心跳超时作业（逐篇幂等续跑）
  async function resumeStale() {
    const results = await resumeStaleJobs({ hooks: hooks() })
    if (results.length) await reload()
    return results
  }

  return {
    jobs, itemsByJob, loaded, loadAll, reload, sortedJobs,
    jobById, itemsOf, progressOf, jobsByRef, staleJobs,
    enqueueAndRun, abort, retryFailed, resumeStale
  }
})
