// 知识退役分批编排端到端回归（fake-indexeddb + 真实 store）
// 覆盖：批量批准/批量撤销编排任务创建 → 分片逐篇独立事务执行（共享撤销/问答引用停止/
// 答案来源改挂按篇原子生效）→ 暂态失败就地重试 → 业务冲突隔离（不阻塞他篇、不产生
// 跨文档半联动状态）→ 部分失败/停止后续跑（幂等重判，已成功篇目不重复联动）→
// 任务/篇目/批次/退役单/工单/链接全链路留痕 → 单例防并发与权限。
// 运行：npm run test:retirement-job
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useGapStore } from '@/stores/gap'
import { useRetirementStore } from '@/stores/retirement'
import { uid, makeToken } from '@/utils/format'
import {
  RETIRE, RETIRE_BATCH, isDocRetired, isDocSearchable
} from '@/utils/retirement'
import {
  RETIRE_JOB, RETIRE_JOB_ITEM, RETIRE_JOB_KIND,
  isTransientRetirementError, isJobResumable, jobProgressOf, classifyRetirementStepResult
} from '@/utils/retirementJob'
import { isShareActive } from '@/utils/share'
import { GAP } from '@/utils/gap'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const gap = useGapStore(pinia)
const retirement = useRetirementStore(pinia)

const owner = { id: 'u-owner', name: '文档负责人', role: 'editor', avatar: 'FZ' }
const other = { id: 'u-other', name: '其他编辑', role: 'editor', avatar: 'QT' }
const admin = { id: 'u-admin', name: '管理员', role: 'admin', avatar: 'GL' }
const viewer = { id: 'u-viewer', name: '只读', role: 'viewer', avatar: 'ZD' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const nowIso = () => new Date().toISOString()
// 测试提速：关闭分片间隔与重试退避
const FAST = { chunkDelayMs: 0, retryDelayMs: 0 }

await db.users.bulkAdd([owner, other, admin, viewer].map((u) => ({ ...u, email: '', title: '' })))

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '编排文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>旧正文 鉴权 Token 权限点</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: { title: '', body: '<p>旧正文</p>', categoryId: 'c', tagIds: [], visibility: 'public' } }],
    ...extra
  }
  d.versions[0].snapshot.title = d.title
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}
const getDoc = (id) => db.docs.get(id)

async function mkResolvedGap(docId, question) {
  const t = {
    id: uid('gap'), question, detail: '', status: GAP.RESOLVED, createdBy: viewer.id, createdAt: nowIso(),
    claimedBy: owner.id, claimedAt: nowIso(), docId, reviewId: null, groupId: null, resolvedAt: nowIso(),
    timeline: [{ action: 'resolve', by: admin.id, note: '审批通过，答案来源已回填', at: nowIso() }]
  }
  await db.gapTickets.add(t)
  await gap.reload()
  return t
}
async function mkShare(docId) {
  const s = { id: uid('share'), docId, token: makeToken(), permission: 'view', createdBy: owner.id, createdAt: nowIso(), expiresAt: null, revokedAt: null }
  await db.shares.add(s)
  return s
}
// 建批次：docs 篇旧文档（owner 所有）统一送审，替代文档各自独立
async function mkBatch(titles, note = '') {
  const rows = []
  for (const t of titles) {
    const old = await mkDoc({ title: t })
    const rep = await mkDoc({ title: t + '-替代' })
    rows.push({ old, rep, row: { docId: old.id, replacementDocId: rep.id } })
  }
  const res = await retirement.initiateRetirementBatch({ rows: rows.map((x) => x.row), note }, owner)
  if (res.status !== 'ok') throw new Error('建批次失败：' + res.status)
  return { batch: res.batch, retirements: res.retirements, rows }
}
// 模拟暂态故障（IndexedDB 环境性异常）
function transientError() {
  const e = new Error('模拟的事务中断')
  e.name = 'QuotaExceededError'
  return e
}

// ---------- 1. 批量批准编排：分片逐篇原子生效 + 全链路留痕 ----------
console.log('\n[1] 批量批准编排：逐篇独立事务生效，全链路留痕')
{
  const { batch, retirements, rows } = await mkBatch(['A1', 'A2', 'A3'], '季度清理')
  const gaps = []; const shares = []
  for (const { old } of rows) { gaps.push(await mkResolvedGap(old.id, old.title + ' 的历史问题')); shares.push(await mkShare(old.id)) }

  const res = await retirement.startBatchApproveJob(batch.id, '', admin, FAST)
  assert(res.status === 'done' && res.summary.succeeded === 3, '批量批准编排：3 篇全部生效，任务 done')
  const job = res.job
  assert(job.kind === RETIRE_JOB_KIND.APPROVE && job.status === RETIRE_JOB.DONE, '任务持久化为 approve/done')
  assert(job.items.every((it) => it.status === RETIRE_JOB_ITEM.SUCCEEDED && it.attempts === 1), '逐篇状态 succeeded，一次尝试成功')
  for (let i = 0; i < 3; i++) {
    const d = await getDoc(rows[i].old.id)
    assert(isDocRetired(d) && !isDocSearchable(d), '旧文档 ' + rows[i].old.title + ' 已退役并停止搜索引用')
    const s = await db.shares.get(shares[i].id)
    assert(s.revokedAt && s.revokeReason === 'retirement:' + retirements[i].id && !isShareActive(s), '共享链接随本篇退役撤销（记录保留）')
    const g = await db.gapTickets.get(gaps[i].id)
    assert(g.docId === rows[i].rep.id && g.timeline.some((t) => t.action === 'gap-repoint'), '缺口工单答案来源改挂替代文档并留痕')
  }
  assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.ACTIVE_RETIRED, '批次状态派生为 active-retired')
  const batchAfter = await db.retirementBatches.get(batch.id)
  assert(batchAfter.timeline.some((t) => t.action === 'batch-approve-job' && t.note.includes(job.id)), '批次时间线留有编排结论（关联任务 id）')
  assert(job.timeline.some((t) => t.action === 'job-initiate') && job.timeline.some((t) => t.action === 'job-finish'), '任务时间线含创建与完成留痕')
  assert(job.items.every((it) => it.history.length === 1 && it.history[0].result === 'ok'), '每篇留有尝试记录（第 1 次即成功）')
  assert(retirement.jobsOfBatch(batch.id).length === 1 && retirement.resumableJobs.length === 0, 'store 可查询任务；全部完成无可续跑任务')

  // 撤销编排（同一批次）：篡改一张工单（退役期间被退回处理）→ 该工单不回挂，其余正常恢复
  await db.gapTickets.update(gaps[0].id, {
    status: GAP.CLAIMED, docId: null,
    timeline: [...(await db.gapTickets.get(gaps[0].id)).timeline, { action: 'return', by: other.id, note: '退回处理', at: nowIso() }]
  })
  await gap.reload()
  const res2 = await retirement.startBatchRevokeJob(batch.id, '体系并行恢复', owner, FAST)
  assert(res2.status === 'done' && res2.summary.succeeded === 3, '批量撤销编排：3 篇全部恢复，任务 done')
  for (const { old } of rows) {
    assert(!isDocRetired(await getDoc(old.id)) && isDocSearchable(await getDoc(old.id)), '旧文档 ' + old.title + ' 解除退役、恢复搜索引用')
  }
  assert(isShareActive(await db.shares.get(shares[0].id)), '被退役撤销的共享链接已恢复')
  const g0 = await db.gapTickets.get(gaps[0].id)
  assert(g0.status === GAP.CLAIMED && g0.docId === null, '退役期间被另行处理的工单不强行回挂')
  assert((await db.gapTickets.get(gaps[1].id)).docId === rows[1].old.id, '未动过的工单答案来源回挂旧文档')
  assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.REVERTED, '全部撤销后批次 reverted')
  const batchAfter2 = await db.retirementBatches.get(batch.id)
  assert(batchAfter2.timeline.some((t) => t.action === 'batch-revoke-job'), '批次时间线留有撤销编排结论')
}

// ---------- 2. 暂态失败：就地重试后成功 ----------
console.log('\n[2] 暂态失败就地重试')
{
  const { batch, retirements } = await mkBatch(['B1', 'B2'])
  const target = retirements[0].id
  const res = await retirement.startBatchApproveJob(batch.id, '', admin, {
    ...FAST,
    itemInterceptor: async (item, attempt) => {
      if (item.retirementId === target && attempt === 1) throw transientError()
    }
  })
  assert(res.status === 'done', '暂态故障重试后任务 done')
  const item = res.job.items.find((it) => it.retirementId === target)
  assert(item.status === RETIRE_JOB_ITEM.SUCCEEDED && item.attempts === 2, '故障篇第 2 次尝试成功')
  assert(item.history[0].result === 'error' && item.history[0].transient === true && item.history[1].result === 'ok', '篇目留痕：先暂态失败、后重试成功')
  assert(isDocRetired(await getDoc(res.job.items.find((it) => it.retirementId === target).docId)), '重试成功的篇目正常退役生效')
}

// ---------- 3. 持续暂态故障：部分失败 + 冲突隔离 + 续跑不重复联动 ----------
console.log('\n[3] 持续故障 → 部分完成 → 续跑（已成功篇目不重复执行）')
{
  const { batch, retirements, rows } = await mkBatch(['C1', 'C2', 'C3'])
  const cShares = {}; const cGaps = {}
  for (const { old } of rows) { cShares[old.id] = await mkShare(old.id); cGaps[old.id] = await mkResolvedGap(old.id, old.title + ' 问题') }
  const failRt = retirements[1].id // C2 持续故障
  const res = await retirement.startBatchApproveJob(batch.id, '', admin, {
    ...FAST,
    itemInterceptor: async (item) => { if (item.retirementId === failRt) throw transientError() }
  })
  assert(res.status === 'partial' && res.summary.succeeded === 2 && res.summary.failed === 1, '持续故障：2 篇成功、1 篇失败，任务 partial（可续跑）')
  const failItem = res.job.items.find((it) => it.retirementId === failRt)
  assert(failItem.status === RETIRE_JOB_ITEM.FAILED && failItem.attempts === 2 && failItem.history.every((h) => h.result === 'error'), '故障篇重试耗尽后标记 failed，留痕完整')
  // 冲突/故障隔离：C2 保持原状（不产生半联动），C1/C3 正常生效
  const c2 = rows[1].old
  assert(!isDocRetired(await getDoc(c2.id)) && isDocSearchable(await getDoc(c2.id)), '故障篇旧文档保持原状（未退役、可搜索）')
  assert(isShareActive(await db.shares.get(cShares[c2.id].id)), '故障篇共享链接未被撤销（无半联动）')
  assert((await db.gapTickets.get(cGaps[c2.id].id)).docId === c2.id, '故障篇工单答案来源未改挂（无半联动）')
  assert(isDocRetired(await getDoc(rows[0].old.id)) && isDocRetired(await getDoc(rows[2].old.id)), '其余篇正常退役生效，不受故障篇阻塞')
  assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.ACTIVE, '部分失败后批次仍 active（C2 待审批）')
  assert(retirement.resumableJobs.some((j) => j.id === res.job.id), '部分失败任务进入可续跑列表')

  // 记录成功篇的审批时间，验证续跑不重复执行
  const rt1Before = await db.retirements.get(retirements[0].id)
  const res2 = await retirement.resumeRetirementJob(res.job.id, admin, FAST)
  assert(res2.status === 'done' && res2.summary.succeeded === 3, '故障恢复后续跑：全部成功，任务 done')
  assert(isDocRetired(await getDoc(c2.id)), '续跑后故障篇正常退役')
  const rt1After = await db.retirements.get(retirements[0].id)
  assert(rt1After.decidedAt === rt1Before.decidedAt && rt1After.timeline.length === rt1Before.timeline.length, '已成功篇目未参与续跑（审批记录无变化）')
  const jobAfter = res2.job
  assert(jobAfter.timeline.some((t) => t.action === 'job-resume'), '任务时间线留有续跑记录')
  const c2Item = jobAfter.items.find((it) => it.retirementId === failRt)
  assert(c2Item.history.length === 3 && c2Item.history[2].result === 'ok', '故障篇留痕累计：2 次失败 + 续跑成功')
}

// ---------- 4. 业务冲突隔离：评审中篇目不阻塞他篇，处理后续跑 ----------
console.log('\n[4] 业务冲突隔离与处理后续跑')
{
  const { batch, retirements, rows } = await mkBatch(['D1', 'D2'])
  // D1 在送审后进入评审（审批时兜底判定为冲突）
  await db.reviews.add({
    id: uid('rev'), docId: rows[0].old.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
    snapshot: { title: rows[0].old.title, body: '<p>x</p>', categoryId: 'c', tagIds: [], visibility: 'public' },
    baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
  })
  await db.docs.update(rows[0].old.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: 'dummy' })
  const res = await retirement.startBatchApproveJob(batch.id, '', admin, FAST)
  assert(res.status === 'partial' && res.summary.conflict === 1 && res.summary.succeeded === 1, '评审中篇目冲突隔离：1 冲突 + 1 成功')
  const cItem = res.job.items.find((it) => it.retirementId === retirements[0].id)
  assert(cItem.status === RETIRE_JOB_ITEM.CONFLICT && cItem.lastError.includes('评审'), '冲突篇目标记 conflict 并记录原因')
  assert(!isDocRetired(await getDoc(rows[0].old.id)) && isDocRetired(await getDoc(rows[1].old.id)), '冲突篇保持原状，他篇正常生效')
  // 评审完结后续跑 → 冲突篇重判成功
  await db.reviews.where('docId').equals(rows[0].old.id).delete()
  await db.docs.update(rows[0].old.id, { publishState: PUBLISH.PUBLISHED, activeReviewId: null })
  const res2 = await retirement.resumeRetirementJob(res.job.id, admin, FAST)
  assert(res2.status === 'done' && isDocRetired(await getDoc(rows[0].old.id)), '冲突处理后续跑：冲突篇重判生效，任务 done')
}

// ---------- 5. 幂等：执行期间被他人先行批准，重判为成功且不重复联动 ----------
console.log('\n[5] 幂等重判：执行期间状态已达目标态')
{
  const { batch, retirements } = await mkBatch(['E1', 'E2'])
  const target = retirements[0].id
  const res = await retirement.startBatchApproveJob(batch.id, '', admin, {
    ...FAST,
    itemInterceptor: async (item, attempt) => {
      // 模拟并发：该篇执行前已被另一窗口的管理员批准
      if (item.retirementId === target && attempt === 1) await retirement.decideRetirement(target, 'approve', '', admin)
    }
  })
  assert(res.status === 'done' && res.summary.succeeded === 2, '并发批准下任务仍 done')
  const item = res.job.items.find((it) => it.retirementId === target)
  assert(item.status === RETIRE_JOB_ITEM.SUCCEEDED && item.history[0].result === 'changed' && item.history[0].message.includes('幂等'), '已达目标态的篇目幂等记为成功（不重复联动）')
  const rt = await db.retirements.get(target)
  assert(rt.timeline.filter((t) => t.action === 'approve').length === 1, '退役单仅一条批准留痕（未重复执行联动）')
}

// ---------- 6. 执行中停止：分片边界生效，剩余篇目可续跑 ----------
console.log('\n[6] 请求停止与再续跑')
{
  const { batch } = await mkBatch(['F1', 'F2', 'F3'])
  let stopIssued = false
  const res = await retirement.startBatchApproveJob(batch.id, '', admin, {
    ...FAST, chunkSize: 1,
    itemInterceptor: async (item, attempt) => {
      if (!stopIssued && attempt === 1 && item.docTitle === 'F2') {
        stopIssued = true
        const job = retirement.jobsOfBatch(batch.id)[0]
        const sr = await retirement.stopRetirementJob(job.id, admin)
        assert(sr.status === 'ok', '执行中可请求停止')
      }
    }
  })
  assert(res.status === 'stopped', '分片边界停止：任务 stopped')
  assert(res.summary.succeeded === 2 && res.summary.pending === 1, '停止时已执行 2 篇，剩余 1 篇待执行')
  assert(res.job.timeline.some((t) => t.action === 'job-stopped'), '任务时间线留有停止记录')
  assert(retirement.resumableJobs.some((j) => j.id === res.job.id), '已停止任务可续跑')
  const res2 = await retirement.resumeRetirementJob(res.job.id, admin, FAST)
  assert(res2.status === 'done' && res2.summary.succeeded === 3, '停止后续跑：剩余篇目执行完成')
}

// ---------- 7. 单例防并发与权限 ----------
console.log('\n[7] 单例防并发与权限')
{
  const { batch } = await mkBatch(['G1'])
  let r = await retirement.startBatchApproveJob(batch.id, '', owner, FAST)
  assert(r.status === 'denied', '非管理员不能发起批量批准编排')
  r = await retirement.startBatchApproveJob(batch.id, '', null, FAST)
  assert(r.status === 'guest', '访客不能发起批量批准编排')
  // 手工插入一条未完成 approve 任务 → 新建被拦截为 busy（应续跑而非并发）
  await db.retirementJobs.add({
    id: uid('rtj'), batchId: batch.id, kind: RETIRE_JOB_KIND.APPROVE, status: RETIRE_JOB.PARTIAL,
    note: '', initiatedBy: admin.id, stopRequested: false,
    items: [{ retirementId: 'x', docId: 'y', docTitle: 'z', status: RETIRE_JOB_ITEM.FAILED, attempts: 1, lastError: 'e', history: [] }],
    stats: null, createdAt: nowIso(), updatedAt: nowIso(), finishedAt: null, timeline: []
  })
  await retirement.reload()
  r = await retirement.startBatchApproveJob(batch.id, '', admin, FAST)
  assert(r.status === 'busy' && r.job.kind === RETIRE_JOB_KIND.APPROVE, '存在未完成任务时新建被拦截（单例，应续跑）')
  const stale = r.job
  // 非任务发起人/非管理员不可续跑该 revoke 类任务（approve 类仅管理员可续跑）
  r = await retirement.resumeRetirementJob(stale.id, other, FAST)
  assert(r.status === 'denied', '非管理员不能续跑批量批准任务')
  await db.retirementJobs.delete(stale.id)
  await retirement.reload()
  // 清理后可正常新建
  r = await retirement.startBatchApproveJob(batch.id, '', admin, FAST)
  assert(r.status === 'done', '清理未完成任务后可正常新建并执行')
  // 批量撤销权限
  r = await retirement.startBatchRevokeJob(batch.id, '', other, FAST)
  assert(r.status === 'denied', '非发起人/管理员不能发起批量撤销编排')
}

// ---------- 8. 兼容入口：revokeRetirementBatch 走编排且保持聚合返回 ----------
console.log('\n[8] 兼容入口 revokeRetirementBatch')
{
  const { batch, retirements } = await mkBatch(['H1', 'H2'])
  for (const rt of retirements) await retirement.decideRetirement(rt.id, 'approve', '', admin)
  const r = await retirement.revokeRetirementBatch(batch.id, '兼容入口', owner)
  assert(r.status === 'ok' && r.done === 2 && r.failed === 0, '兼容入口聚合返回：2 篇完成')
  assert(r.job && r.job.kind === RETIRE_JOB_KIND.REVOKE && r.job.status === RETIRE_JOB.DONE, '兼容入口内部生成撤销编排任务')
  assert(retirement.itemsOfBatch(batch.id).every((x) => x.status === RETIRE.REVOKED), '两篇均撤销退役')
  const r2 = await retirement.revokeRetirementBatch(batch.id, '', owner)
  assert(r2.status === 'changed', '无生效篇时兼容入口返回 changed')
}

// ---------- 9. 纯函数：暂态判定 / 进度 / 结果归类 ----------
console.log('\n[9] 纯函数行为')
{
  assert(isTransientRetirementError(transientError()) === true, 'QuotaExceededError 判定为暂态')
  assert(isTransientRetirementError(new Error('普通错误')) === false, '普通错误非暂态')
  const e = new Error('自定义'); e.transient = true
  assert(isTransientRetirementError(e) === true, '显式 transient 标记判定为暂态')
  const prog = jobProgressOf({ items: [
    { status: RETIRE_JOB_ITEM.SUCCEEDED }, { status: RETIRE_JOB_ITEM.CONFLICT },
    { status: RETIRE_JOB_ITEM.FAILED }, { status: RETIRE_JOB_ITEM.PENDING }
  ] })
  assert(prog.total === 4 && prog.succeeded === 1 && prog.remaining === 3, '进度统计正确')
  assert(isJobResumable({ status: RETIRE_JOB.PARTIAL, items: [{ status: RETIRE_JOB_ITEM.FAILED }] }) === true, 'partial 且有剩余 → 可续跑')
  assert(isJobResumable({ status: RETIRE_JOB.DONE, items: [{ status: RETIRE_JOB_ITEM.SUCCEEDED }] }) === false, 'done → 不可续跑')
  const c1 = classifyRetirementStepResult('approve', { status: 'ok' })
  assert(c1.outcome === RETIRE_JOB_ITEM.SUCCEEDED, 'ok → succeeded')
  const c2 = classifyRetirementStepResult('approve', { status: 'changed', retirement: { status: RETIRE.APPROVED } })
  assert(c2.outcome === RETIRE_JOB_ITEM.SUCCEEDED && c2.message.includes('幂等'), 'changed 但已达目标态 → 幂等成功')
  const c3 = classifyRetirementStepResult('approve', { status: 'in-review' })
  assert(c3.outcome === RETIRE_JOB_ITEM.CONFLICT && c3.message.includes('评审'), '业务冲突 → conflict 并生成中文原因')
  const c4 = classifyRetirementStepResult('revoke', { status: 'changed', retirement: { status: RETIRE.REVOKED } })
  assert(c4.outcome === RETIRE_JOB_ITEM.SUCCEEDED, '撤销任务幂等：已 revoked → succeeded')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
