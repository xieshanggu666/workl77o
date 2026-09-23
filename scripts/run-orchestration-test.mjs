// 知识退役可重试分批编排端到端回归（fake-indexeddb + 真实 store）
//
// 覆盖编排引擎与退役三类批量动作：
// - 批量送审（batch-submit）：预检全部非法逐行标红不建档；部分非法 → 冲突隔离、合法行逐篇成功，
//   同批替代链/自替代/重复/评审交接占用/权限逐行拦截；批次与作业原子建档、双向时间线留痕；
// - 批量批准（batch-approve）：逐篇独立事务停引用/撤共享链接/改挂缺口答案来源，
//   并发冲突篇只隔离该篇，成功篇照常生效，冲突解除后「仅重试失败篇」补齐；
// - 批量撤销恢复（batch-revoke）：逐篇恢复搜索引用/共享链接/答案来源，被另行处理的篇跳过不阻塞；
// - 中止续跑、心跳超时断点续跑（逐篇幂等重放，不重复建档/不重复联动）、异常隔离不击穿整作业；
// - 无 batchId 的单篇退役记录全程兼容。
// 运行：npm run test:orchestration
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useGapStore } from '@/stores/gap'
import { useRetirementStore } from '@/stores/retirement'
import { useHandoverStore } from '@/stores/handover'
import { useOrchestrationStore } from '@/stores/orchestration'
import { uid, makeToken } from '@/utils/format'
import {
  RETIRE, RETIRE_BATCH, isDocRetired, isDocSearchable, isDocRetireCitable,
  retirementBatchStatusOf, retirementBatchProgress, checkRetirementBatch
} from '@/utils/retirement'
import { isShareActive } from '@/utils/share'
import { GAP } from '@/utils/gap'
import { PUBLISH } from '@/utils/review'
import {
  JOB, ITEM, isStaleJob, jobProgress, getBatchHandler
} from '@/utils/orchestration'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const auth = useAuthStore(pinia)
const gap = useGapStore(pinia)
const retirement = useRetirementStore(pinia)
const handover = useHandoverStore(pinia)
const orch = useOrchestrationStore(pinia)

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

await db.users.bulkAdd([owner, other, admin, viewer].map((u) => ({ ...u, email: '', title: '' })))

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '批量退役文档-' + Math.random().toString(36).slice(2, 7),
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
const jobItemsOf = (jobId) => orch.itemsOf(jobId)

// ---------- 1. 预检：访客 / 全部非法逐行标红 / 不建档 ----------
console.log('\n[1] 批量送审预检（全部非法时不产生批次与作业）')
let r = await retirement.initiateRetirementBatch({ rows: [] }, null)
assert(r.status === 'guest', '访客不能批量送审')
const a1 = await mkDoc()
const b1 = await mkDoc({ ownerId: other.id })
const rep1 = await mkDoc()
r = await retirement.initiateRetirementBatch({ rows: [{ docId: a1.id, replacementDocId: rep1.id }, { docId: b1.id, replacementDocId: rep1.id }] }, owner)
assert(r.status === 'partial' && r.invalid.length === 1 && r.invalid[0].error === 'denied', '部分预检失败：invalid 逐行返回 denied')
assert(r.job && r.batch && r.retirements.length === 1, '合法行仍建档：生成 1 张退役单 + 批次 + 作业')
assert(jobItemsOf(r.job.id).length === 1 && jobItemsOf(r.job.id)[0].status === ITEM.SUCCEEDED, '冲突隔离：作业仅含合法 1 篇且成功')
assert(!!retirement.openRetirementOfDoc(b1.id) === false, '被隔离的 b1 未产生退役单')
assert((await db.batchJobs.toArray()).length >= 1 && (await db.batchJobItems.toArray()).length >= 1, '作业与逐篇记录已入库')

// ---------- 2. 全部非法：不建档 ----------
console.log('\n[2] 全部行预检非法 → invalid 且不产生任何记录')
const x2 = await mkDoc()
r = await retirement.initiateRetirementBatch({ rows: [{ docId: 'nope', replacementDocId: x2.id }, { docId: x2.id, replacementDocId: x2.id }] }, owner)
assert(r.status === 'invalid' && r.rows.length === 2 && r.rows.every((x) => x.error), '全部非法返回 invalid 逐行原因')
assert(!r.job && !r.batch, '全部非法不建档作业/批次')

// 同批替代链、自替代、重复：预检逐行隔离（合法行仍可进入作业）
const a2 = await mkDoc(); const b2 = await mkDoc(); const c2 = await mkDoc()
r = await retirement.initiateRetirementBatch({
  rows: [
    { docId: a2.id, replacementDocId: b2.id },
    { docId: b2.id, replacementDocId: c2.id }
  ]
}, owner)
assert(r.status === 'partial', '批次内 A⇒B 且 B 同批退役：冲突行隔离、合法行继续（partial）')
assert(r.rows.find((x) => x.docId === a2.id)?.error === 'replacement-in-batch', 'A 行预检标记 replacement-in-batch 被隔离')
assert(r.retirements.some((x) => x.docId === b2.id) && !r.retirements.some((x) => x.docId === a2.id), 'B⇒C 合法行建档，A⇒B 冲突行不建档')
r = await retirement.initiateRetirementBatch({ rows: [{ docId: a2.id, replacementDocId: a2.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'bad-replacement', '替代文档不能是文档自身')
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: a2.id, replacementDocId: c2.id }, { docId: a2.id, replacementDocId: c2.id }]
}, owner)
assert(r.status === 'partial' && r.invalid.some((x) => x.error === 'duplicate-doc') && r.retirements.length === 1, '同批重复：重复行隔离，唯一合法行照常建档')

// ---------- 3. 文档间替代冲突：单篇/批量两条路径 ----------
console.log('\n[3] 被用作替代文档的文档不可退役')
const x3 = await mkDoc(); const y3 = await mkDoc(); const z3 = await mkDoc()
r = await retirement.initiateRetirementBatch({ rows: [{ docId: x3.id, replacementDocId: y3.id }] }, owner)
r = await retirement.initiateRetirement({ docId: y3.id, replacementDocId: z3.id }, owner)
assert(r.status === 'used-as-replacement', '单篇：作为在途退役替代文档的 Y 不可退役')
r = await retirement.initiateRetirementBatch({ rows: [{ docId: y3.id, replacementDocId: z3.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'used-as-replacement', '批量：预检逐行拦截 used-as-replacement')
r = await kb.deleteDoc(y3.id, admin)
assert(r.status === 'is-replacement', '作为在途退役替代文档的文档不可删除')
await retirement.cancelRetirement(retirement.openRetirementOfDoc(x3.id).id, owner)
r = await retirement.initiateRetirement({ docId: y3.id, replacementDocId: z3.id }, owner)
assert(r.status === 'ok', '在途退役取消后，Y 可发起退役')
await retirement.cancelRetirement(r.retirement.id, owner)

// ---------- 4. 评审/交接占用：预检拦截 ----------
console.log('\n[4] 评审中/交接中的文档预检拦截')
const a4 = await mkDoc(); const rep4 = await mkDoc()
await db.reviews.add({
  id: uid('rev'), docId: a4.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: a4.title, body: a4.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
})
await db.docs.update(a4.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: 'dummy' })
r = await retirement.initiateRetirementBatch({ rows: [{ docId: a4.id, replacementDocId: rep4.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'in-review', '评审中文档预检返回 in-review')
await db.reviews.where('docId').equals(a4.id).delete()
await db.docs.update(a4.id, { publishState: PUBLISH.PUBLISHED, activeReviewId: null })

const a5 = await mkDoc()
await handover.initiateHandover({ items: [{ docId: a5.id, toUserId: other.id }], revokeMode: 'keep', note: '' }, owner)
r = await retirement.initiateRetirementBatch({ rows: [{ docId: a5.id, replacementDocId: rep4.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'in-handover', '交接中文档预检返回 in-handover')

// ---------- 5. 成功统一送审：批次 + N 张单 + 编排留痕 ----------
console.log('\n[5] 统一送审成功：批次/退役单/作业原子建档，全链路留痕')
const dA = await mkDoc({ title: '旧文档A' })
const dB = await mkDoc({ title: '旧文档B' })
const dC = await mkDoc({ title: '旧文档C' })
const repA = await mkDoc({ title: '新文档RA' })
const repB = await mkDoc({ title: '新文档RB' })
const gA = await mkResolvedGap(dA.id, 'A 的历史问题')
const gB = await mkResolvedGap(dB.id, 'B 的历史问题')
const sA = await mkShare(dA.id)
const sB = await mkShare(dB.id)
r = await retirement.initiateRetirementBatch({
  rows: [
    { docId: dA.id, replacementDocId: repA.id, reason: 'A 篇级原因' },
    { docId: dB.id, replacementDocId: repB.id },
    { docId: dC.id, replacementDocId: repA.id }
  ],
  note: '批次统一退役原因'
}, owner)
assert(r.status === 'ok' && r.retirements.length === 3, '三篇统一送审成功，生成 3 张退役单')
const batch = r.batch
const submitJob = r.job
assert(submitJob.status === JOB.COMPLETED && jobProgress(submitJob, jobItemsOf(submitJob.id)).succeeded === 3, '送审作业全部成功')
assert(batch.status === RETIRE_BATCH.ACTIVE && batch.total === 3, '批次初始为待逐篇审批，共 3 篇')
assert(r.retirements.every((x) => x.batchId === batch.id && x.status === RETIRE.PENDING), '每张退役单挂载 batchId 且待审批')
assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.ACTIVE, 'store 派生批次状态 active')
assert(retirement.itemsOfBatch(batch.id).map((x) => x.docId).join() === [dA.id, dB.id, dC.id].join(), '批次内退役单按送审顺序排列')
assert(r.retirements[0].reason === 'A 篇级原因', '篇级退役原因保留')
assert(r.retirements[1].reason === '批次统一退役原因' && r.retirements[2].reason === '批次统一退役原因', '未填篇级原因时回退批次统一原因')
// 全链路留痕：作业 timeline + 批次 timeline + 退役单 timeline
assert((submitJob.timeline || []).some((t) => t.action === 'job-create'), '作业留有建档记录')
assert((submitJob.timeline || []).some((t) => t.action === 'job-complete'), '作业留有完成记录')
assert((batch.timeline || []).some((t) => t.note.includes('编排作业')), '批次时间线回写编排作业结果')
assert(jobItemsOf(submitJob.id).every((it) => it.attempts.length === 1 && it.attempts[0].status === ITEM.SUCCEEDED), '逐篇尝试记录（attempts）留痕')

// ---------- 6. 批量批准：逐篇独立联动 + 冲突隔离 ----------
console.log('\n[6] 批量批准：逐篇停引用/撤链接/改挂工单，冲突篇隔离')
const rtAll = retirement.itemsOfBatch(batch.id)
// 先让 B 进入评审（并发冲突），批量批准应隔离 B，A/C 正常生效
await db.reviews.add({
  id: uid('rev'), docId: dB.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: dB.title, body: dB.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
})
await db.docs.update(dB.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: 'dummy' })
r = await retirement.decideRetirementBatch(batch.id, '', admin)
assert(r.status === 'partial' && r.done === 2 && r.failed === 1, '批量批准：2 篇生效、1 篇冲突隔离')
const approveJob = r.job
assert(approveJob.status === JOB.PARTIAL, '批准作业状态 partial（部分失败可续跑）')
const failedItem = r.items.find((it) => it.status === ITEM.FAILED)
assert(failedItem.errorCode === 'in-review' && failedItem.attempts.length === 1, '冲突篇记录错误码与尝试次数')
assert(isDocRetired(await getDoc(dA.id)) && !isDocSearchable(await getDoc(dA.id)) && !isDocRetireCitable(await getDoc(dA.id)), 'A 已退役并停止搜索/问答引用')
const sA2 = await db.shares.get(sA.id)
assert(sA2.revokedAt && sA2.revokeReason === 'retirement:' + rtAll[0].id && !isShareActive(sA2), 'A 的有效共享链接随本篇退役撤销')
assert((await db.gapTickets.get(gA.id)).docId === repA.id, 'A 的已解决工单答案来源改挂 RA')
assert(isShareActive(await db.shares.get(sB.id)), 'B 被隔离：其共享链接未被撤销')
assert((await db.gapTickets.get(gB.id)).docId === dB.id, 'B 被隔离：其工单答案来源未改挂')

// 解除 B 的冲突后「仅重试失败篇」
await db.reviews.where('docId').equals(dB.id).delete()
await db.docs.update(dB.id, { publishState: PUBLISH.PUBLISHED, activeReviewId: null })
r = await orch.retryFailed(approveJob.id, admin)
assert(r.status === 'ok', '仅重试失败篇：续跑成功')
const approveJob2 = await db.batchJobs.get(approveJob.id)
assert(approveJob2.status === JOB.COMPLETED, '重试后作业全部成功')
assert(jobItemsOf(approveJob.id).filter((it) => it.status === ITEM.SUCCEEDED).length === 3, '三篇最终全部成功')
// A/C 没有被重放（幂等）：attempts 仍为 1；B 为 2
const byEntity = Object.fromEntries(jobItemsOf(approveJob.id).map((it) => [it.entityId, it]))
assert(byEntity[dA.id].attempts.length === 1 && byEntity[dC.id].attempts.length === 1, '成功篇不重放（A/C 仍为 1 次尝试）')
assert(byEntity[dB.id].attempts.length === 2, '失败篇 B 第 2 次尝试成功')
assert(isDocRetired(await getDoc(dB.id)), 'B 重试后生效退役')
assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.ACTIVE_RETIRED, '批次派生为 active-retired')
const prog = retirementBatchProgress(retirement.itemsOfBatch(batch.id))
assert(prog.approved === 3 && prog.pending === 0 && prog.done === 3, '批次进度：3 生效 / 0 待审批')

// 纯函数：批次状态派生
assert(retirementBatchStatusOf([{ status: RETIRE.PENDING }]) === RETIRE_BATCH.ACTIVE, '纯函数：含待审批即 active')
assert(retirementBatchStatusOf([{ status: RETIRE.REJECTED }, { status: RETIRE.CANCELLED }]) === RETIRE_BATCH.RESOLVED, '纯函数：全结案无生效 → resolved')
assert(retirementBatchStatusOf([{ status: RETIRE.APPROVED }, { status: RETIRE.REJECTED }]) === RETIRE_BATCH.ACTIVE_RETIRED, '纯函数：有生效篇 → active-retired')
assert(retirementBatchStatusOf([{ status: RETIRE.REVOKED }, { status: RETIRE.REVOKED }]) === RETIRE_BATCH.REVERTED, '纯函数：曾生效全撤销 → reverted')
// 纯函数：成环
const ck = checkRetirementBatch(
  [{ docId: 'A', replacementDocId: 'B' }, { docId: 'B', replacementDocId: 'A' }],
  {
    docOf: (id) => ({ id, title: id, ownerId: owner.id }),
    openRetirementOfDoc: () => null, activeRetirementOfDoc: () => null,
    openUsingAsReplacement: () => null, activeUsingAsReplacement: () => null,
    pendingReviewOfDoc: () => null, openHandoverOfDoc: () => null
  }
)
assert(ck.rows.every((x) => x.error === 'replacement-in-batch'), '纯函数：批次内成环两篇均被拦截')

// ---------- 7. 非管理员不能批量批准 ----------
console.log('\n[7] 批量批准权限')
const q1 = await mkDoc(); const qrep = await mkDoc()
r = await retirement.initiateRetirementBatch({ rows: [{ docId: q1.id, replacementDocId: qrep.id }] }, owner)
r = await retirement.decideRetirementBatch(r.batch.id, '', other)
assert(r.status === 'denied', '非管理员不能批量批准')

// ---------- 8. 批量撤销恢复：逐篇恢复 + 被另行处理篇跳过 ----------
console.log('\n[8] 批量撤销恢复：逐篇独立，被另行处理篇跳过不阻塞')
const f1 = await mkDoc(); const f2 = await mkDoc(); const frep = await mkDoc()
const gf1 = await mkResolvedGap(f1.id, 'F1 问题'); const gf2 = await mkResolvedGap(f2.id, 'F2 问题')
const sf1 = await mkShare(f1.id)
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: f1.id, replacementDocId: frep.id }, { docId: f2.id, replacementDocId: frep.id }]
}, owner)
const fb = r.batch
await retirement.decideRetirementBatch(fb.id, '', admin)
assert(retirement.itemsOfBatch(fb.id).every((x) => x.status === RETIRE.APPROVED), '前置：两篇均生效')
assert((await db.gapTickets.get(gf1.id)).docId === frep.id && (await db.gapTickets.get(gf2.id)).docId === frep.id, '两张工单均改挂 frep')

// f1 工单在退役期间被另行退回处理 → 撤销时跳过回挂（不阻塞 f2）
await db.gapTickets.update(gf1.id, {
  status: GAP.CLAIMED, docId: null,
  timeline: [...(await db.gapTickets.get(gf1.id)).timeline, { action: 'return', by: other.id, note: '退回处理', at: nowIso() }]
})
await gap.reload()

r = await retirement.revokeRetirementBatch(fb.id, '旧体系并行恢复', owner)
assert(r.status === 'ok' && r.done === 2 && r.failed === 0, '批量撤销两篇均完成（逐篇独立事务）')
assert(!!r.job && r.job.status === JOB.COMPLETED, '撤销恢复作业全部成功')
const f1b = await getDoc(f1.id); const f2b = await getDoc(f2.id)
assert(!isDocRetired(f1b) && !isDocRetired(f2b) && isDocSearchable(f1b) && isDocSearchable(f2b), '两篇旧文档均解除退役、恢复搜索引用')
assert(isShareActive(await db.shares.get(sf1.id)), 'f1 撤销退役后其共享链接恢复')
const gf1b = await db.gapTickets.get(gf1.id); const gf2b = await db.gapTickets.get(gf2.id)
assert(gf1b.status === GAP.CLAIMED && gf1b.docId === null, 'f1 被另行处理的工单不强行回挂')
assert(gf2b.docId === f2.id, 'f2 工单答案来源正常回挂，不受 f1 异常篇阻塞')
assert(retirement.batchStatusById[fb.id] === RETIRE_BATCH.REVERTED, '两篇均撤销退役 → 批次 reverted')

// 无生效篇再批量撤销
r = await retirement.revokeRetirementBatch(fb.id, '', owner)
assert(r.status === 'changed', '批次无生效篇时批量撤销返回 changed')
r = await retirement.revokeRetirementBatch(batch.id, '', other)
assert(r.status === 'denied', '非发起人/管理员不能批量撤销批次')

// ---------- 9. 心跳超时断点续跑（逐篇幂等，不重复建档/联动） ----------
console.log('\n[9] 心跳超时 → resumeStaleJobs 断点续跑，逐篇幂等')
const h1 = await mkDoc(); const h2 = await mkDoc(); const hrep = await mkDoc()
const gh1 = await mkResolvedGap(h1.id, 'H1 问题')
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: h1.id, replacementDocId: hrep.id }, { docId: h2.id, replacementDocId: hrep.id }]
}, owner)
const hb = r.batch
// 先逐篇批准 h1（模拟作业在第 1 篇后崩溃）
await retirement.decideRetirement(retirement.itemsOfBatch(hb.id)[0].id, 'approve', '', admin)
// 直接构造一个绑定该批次、1 成功 1 待处理的 stale 批准作业
const staleJobId = uid('job')
const staleAt = new Date(Date.now() - 60 * 1000).toISOString()
await db.batchJobs.add({
  id: staleJobId, module: 'retirement', action: 'batch-approve', refId: hb.id, refType: 'retirementBatch',
  title: '崩溃作业', note: '', status: JOB.RUNNING, createdBy: admin.id, total: 2, chunkSize: 10,
  runCount: 1, runId: 'old-run', heartbeatAt: staleAt, abortRequested: false, partial: false,
  setupPayload: null, createdAt: staleAt, startedAt: staleAt, finishedAt: null, lastError: null,
  timeline: [{ action: 'job-start', by: admin.id, note: '开始分批执行', at: staleAt }]
})
await db.batchJobItems.bulkAdd([
  { id: uid('jbi'), jobId: staleJobId, key: retirement.itemsOfBatch(hb.id)[0].id, index: 0,
    title: h1.title, entityId: h1.id, status: ITEM.SUCCEEDED, payload: { retirementId: retirement.itemsOfBatch(hb.id)[0].id, decision: 'approve', note: '' },
    errorCode: null, errorTitle: '', attempts: [{ no: 1, at: staleAt, by: admin.id, runId: 'old-run', status: ITEM.SUCCEEDED }],
    startedAt: staleAt, finishedAt: staleAt, createdAt: staleAt },
  { id: uid('jbi'), jobId: staleJobId, key: retirement.itemsOfBatch(hb.id)[1].id, index: 1,
    title: h2.title, entityId: h2.id, status: ITEM.PENDING, payload: { retirementId: retirement.itemsOfBatch(hb.id)[1].id, decision: 'approve', note: '' },
    errorCode: null, errorTitle: '', attempts: [], startedAt: null, finishedAt: null, createdAt: staleAt }
])
await orch.reload()
assert(isStaleJob(await db.batchJobs.get(staleJobId)), '心跳超 30s 的 running 作业识别为 stale')
const resumed = await orch.resumeStale()
assert(resumed.length === 1 && resumed[0].status === 'ok', 'resumeStaleJobs 接管并续跑成功')
const hJobAfter = await db.batchJobs.get(staleJobId)
assert(hJobAfter.status === JOB.COMPLETED && hJobAfter.runCount === 2, '续跑后作业 completed，运行次数 +1')
assert((hJobAfter.timeline || []).some((t) => t.action === 'job-resume'), '续跑动作留痕')
assert(isDocRetired(await getDoc(h1.id)) && isDocRetired(await getDoc(h2.id)), '两篇最终均生效')
// 幂等：h1 的共享链接只被撤销一次（revokedAt 仅一个时间戳；无重复 gap 改挂记录）
const h1Shares = await db.shares.where('docId').equals(h1.id).toArray()
assert(h1Shares.every((s) => !s.revokedAt || typeof s.revokedAt === 'string'), '幂等：续跑未产生重复撤销')
// 幂等：h1 的工单改挂记录恰好一条（续跑未重复联动）
const gh1After = await db.gapTickets.get(gh1.id)
assert(gh1After.docId === hrep.id, 'h1 工单答案来源已改挂替代文档')
assert((gh1After.timeline || []).filter((t) => t.action === 'gap-repoint').length === 1, '幂等：续跑未对 h1 重复改挂工单')

// 新鲜心跳的 running 作业不被接管
const freshId = uid('job')
await db.batchJobs.add({
  id: freshId, module: 'retirement', action: 'batch-approve', refId: hb.id, refType: 'retirementBatch',
  title: '新鲜作业', note: '', status: JOB.RUNNING, createdBy: admin.id, total: 1, chunkSize: 10,
  runCount: 1, runId: 'r', heartbeatAt: nowIso(), abortRequested: false, partial: false,
  setupPayload: null, createdAt: nowIso(), startedAt: nowIso(), finishedAt: null, lastError: null, timeline: []
})
await orch.reload()
const resumed2 = await orch.resumeStale()
assert(resumed2.length === 0 && (await db.batchJobs.get(freshId)).status === JOB.RUNNING, '心跳新鲜的作业不被接管')
await db.batchJobs.delete(freshId)

// ---------- 10. 中止后续跑：已成功篇保留，待处理篇续跑 ----------
console.log('\n[10] 中止作业 → 续跑剩余篇（成功篇不重放）')
const k1 = await mkDoc(); const k2 = await mkDoc(); const krep = await mkDoc()
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: k1.id, replacementDocId: krep.id }, { docId: k2.id, replacementDocId: krep.id }]
}, owner)
const kb2 = r.batch
// 先批准 k1，构造 aborted 作业（1 成功 1 待处理）
await retirement.decideRetirement(retirement.itemsOfBatch(kb2.id)[0].id, 'approve', '', admin)
const abId = uid('job')
const abAt = nowIso()
await db.batchJobs.add({
  id: abId, module: 'retirement', action: 'batch-approve', refId: kb2.id, refType: 'retirementBatch',
  title: '中止作业', note: '', status: JOB.ABORTED, createdBy: admin.id, total: 2, chunkSize: 10,
  runCount: 1, runId: null, heartbeatAt: abAt, abortRequested: true, abortRequestedBy: admin.id, partial: true,
  setupPayload: null, createdAt: abAt, startedAt: abAt, finishedAt: abAt, lastError: null,
  timeline: [{ action: 'job-aborted', by: admin.id, note: '已中止', at: abAt }]
})
await db.batchJobItems.bulkAdd([
  { id: uid('jbi'), jobId: abId, key: retirement.itemsOfBatch(kb2.id)[0].id, index: 0,
    title: k1.title, entityId: k1.id, status: ITEM.SUCCEEDED, payload: { retirementId: retirement.itemsOfBatch(kb2.id)[0].id, decision: 'approve', note: '' },
    errorCode: null, errorTitle: '', attempts: [{ no: 1, at: abAt, by: admin.id, status: ITEM.SUCCEEDED }],
    startedAt: abAt, finishedAt: abAt, createdAt: abAt },
  { id: uid('jbi'), jobId: abId, key: retirement.itemsOfBatch(kb2.id)[1].id, index: 1,
    title: k2.title, entityId: k2.id, status: ITEM.PENDING, payload: { retirementId: retirement.itemsOfBatch(kb2.id)[1].id, decision: 'approve', note: '' },
    errorCode: null, errorTitle: '', attempts: [], startedAt: null, finishedAt: null, createdAt: abAt }
])
await orch.reload()
r = await orch.retryFailed(abId, admin)
assert(r.status === 'ok', '中止后续跑成功（含待处理篇）')
assert((await db.batchJobs.get(abId)).status === JOB.COMPLETED, '续跑后作业 completed')
assert(isDocRetired(await getDoc(k1.id)) && isDocRetired(await getDoc(k2.id)), '中止后两篇最终均生效')

// ---------- 11. 异常隔离：runItem 抛错不击穿整作业，可重试 ----------
console.log('\n[11] 执行异常隔离到单篇，整作业不中断')
const w1 = await mkDoc(); const w2 = await mkDoc(); const wrep = await mkDoc()
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: w1.id, replacementDocId: wrep.id }, { docId: w2.id, replacementDocId: wrep.id }]
}, owner)
const wb = r.batch
// 注册一个一次性抛错的处理器包装，模拟单篇执行期异常（如 IndexedDB 瞬时错误）
const handler = getBatchHandler('retirement', 'batch-approve')
const origRunItem = handler.runItem
let thrownOnce = false
handler.runItem = async (item, ctx) => {
  if (!thrownOnce && item.entityId === w1.id) { thrownOnce = true; throw new Error('模拟瞬时失败') }
  return origRunItem(item, ctx)
}
r = await retirement.decideRetirementBatch(wb.id, '', admin)
assert(r.status === 'partial' && r.done === 1 && r.failed === 1, '异常只隔离该篇：1 成功 1 失败，作业未崩溃')
const wFail = r.items.find((it) => it.entityId === w1.id)
assert(wFail.errorCode === 'exception' && wFail.attempts[0].errorTitle.includes('模拟瞬时失败'), '异常信息逐篇留痕')
assert(isDocRetired(await getDoc(w2.id)) && !isDocRetired(await getDoc(w1.id)), 'w2 正常生效，w1 未生效')
// 恢复处理器后重试失败篇
handler.runItem = origRunItem
r = await orch.retryFailed(r.job.id, admin)
assert(r.status === 'ok' && isDocRetired(await getDoc(w1.id)), '瞬时异常解除后重试成功')

// ---------- 12. 单篇退役记录兼容（无 batchId） ----------
console.log('\n[12] 无 batchId 的单篇退役记录兼容')
const s1 = await mkDoc(); const srep = await mkDoc()
r = await retirement.initiateRetirement({ docId: s1.id, replacementDocId: srep.id, reason: '单篇退役' }, owner)
assert(r.status === 'ok' && !r.retirement.batchId, '单篇发起退役单无 batchId')
const rtS = r.retirement
await retirement.decideRetirement(rtS.id, 'approve', '', admin)
assert(isDocRetired(await getDoc(s1.id)), '单篇退役正常生效')
r = await retirement.revokeRetirement(rtS.id, '', owner)
assert(r.status === 'ok' && isDocSearchable(await getDoc(s1.id)), '单篇退役正常撤销恢复')
assert(retirement.sorted.some((x) => x.id === rtS.id && !x.batchId), '全部记录中仍可查到无批次单篇退役单')
assert(retirement.initiatedBy(owner.id).some((x) => x.id === rtS.id), '我发起的列表兼容单篇退役单')

// ---------- 13. 批次整体取消（审批前）仍可用 ----------
console.log('\n[13] 批次整体取消待审批申请')
const e1 = await mkDoc(); const e2 = await mkDoc(); const erep = await mkDoc()
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: e1.id, replacementDocId: erep.id }, { docId: e2.id, replacementDocId: erep.id }]
}, owner)
const eb = r.batch
r = await retirement.cancelRetirementBatch(eb.id, other)
assert(r.status === 'denied', '非发起人/管理员不能整体取消批次')
r = await retirement.cancelRetirementBatch(eb.id, owner)
assert(r.status === 'ok' && r.cancelled.length === 2, '整体取消两篇待审批申请')
assert(retirement.batchStatusById[eb.id] === RETIRE_BATCH.RESOLVED, '全取消后批次 resolved')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
