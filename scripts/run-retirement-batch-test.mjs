// 知识退役批量送审端到端回归（fake-indexeddb + 真实 store）
// 覆盖：负责人一次为多篇文档分别指定替代文档并统一送审（逐篇校验/批次内替代链冲突/
// 文档间替代冲突/评审交接占用/权限）→ 管理员逐篇批准/驳回（共享撤销、问答引用停止、
// 缺口工单答案来源改挂按篇独立生效）→ 批次状态随逐篇结论派生 →
// 批次整体取消（审批前）/ 批量撤销（生效后逐篇独立、单篇被另行处理不阻塞他篇）→
// 无 batchId 的单篇退役记录全程兼容。
// 运行：npm run test:retirement-batch
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useGapStore } from '@/stores/gap'
import { useRetirementStore } from '@/stores/retirement'
import { useHandoverStore } from '@/stores/handover'
import { uid, makeToken } from '@/utils/format'
import {
  RETIRE, RETIRE_BATCH, isDocRetired, isDocSearchable, isDocRetireCitable,
  retirementBatchStatusOf, retirementBatchProgress, checkRetirementBatch, retireRowErrorLabel
} from '@/utils/retirement'
import { isShareActive } from '@/utils/share'
import { GAP } from '@/utils/gap'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const auth = useAuthStore(pinia)
const gap = useGapStore(pinia)
const retirement = useRetirementStore(pinia)
const handover = useHandoverStore(pinia)

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

// ---------- 1. 统一送审：权限/参数 ----------
console.log('\n[1] 批量送审的入口校验')
let r = await retirement.initiateRetirementBatch({ rows: [] }, null)
assert(r.status === 'guest', '访客不能批量送审')
r = await retirement.initiateRetirementBatch({ rows: [{ docId: 'x', replacementDocId: 'y' }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'missing', '文档不存在逐行返回 missing')
const a1 = await mkDoc()
const b1 = await mkDoc({ ownerId: other.id })
const rep = await mkDoc({ title: '公共替代文档' })
r = await retirement.initiateRetirementBatch({ rows: [{ docId: a1.id, replacementDocId: rep.id }, { docId: b1.id, replacementDocId: rep.id }] }, owner)
assert(r.status === 'invalid' && r.rows.find((x) => x.docId === b1.id)?.error === 'denied', '非负责人/管理员拥有的文档逐行返回 denied')
assert(retirement.openRetirementOfDoc(a1.id) === null, '整体失败：未产生任何退役单（a1 无在途单）')

// ---------- 2. 批次内替代链冲突 + 自替代 + 替代已退役 ----------
console.log('\n[2] 批次内替代冲突逐行拦截')
const a2 = await mkDoc(); const b2 = await mkDoc(); const c2 = await mkDoc()
r = await retirement.initiateRetirementBatch({
  rows: [
    { docId: a2.id, replacementDocId: b2.id }, // A⇒B
    { docId: b2.id, replacementDocId: c2.id }  // B 也在本批退役 → 替代链冲突
  ]
}, owner)
assert(r.status === 'invalid', '批次内 A⇒B 且 B 同批退役：整体送审失败')
assert(r.rows.find((x) => x.docId === a2.id)?.error === 'replacement-in-batch', 'A 行标记 replacement-in-batch')
assert(!!retireRowErrorLabel('replacement-in-batch', r.rows.find((x) => x.docId === a2.id)), '冲突行可生成中文原因')
assert(retirement.openRetirementOfDoc(a2.id) === null && retirement.openRetirementOfDoc(b2.id) === null, '冲突整体失败：两篇均无在途退役单')

r = await retirement.initiateRetirementBatch({ rows: [{ docId: a2.id, replacementDocId: a2.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'bad-replacement', '替代文档不能是文档自身')

// 同一文档重复出现
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: a2.id, replacementDocId: c2.id }, { docId: a2.id, replacementDocId: c2.id }]
}, owner)
assert(r.status === 'invalid' && r.rows.some((x) => x.error === 'duplicate-doc'), '同批重复文档被拦截')

// 替代文档已退役（先让 c2 退役）
const repDone = await mkDoc()
await retirement.initiateRetirementBatch({ rows: [{ docId: c2.id, replacementDocId: repDone.id }] }, owner)
const c2Open = retirement.openRetirementOfDoc(c2.id)
await retirement.decideRetirement(c2Open.id, 'approve', '', admin)
r = await retirement.initiateRetirementBatch({ rows: [{ docId: a2.id, replacementDocId: c2.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'replacement-retired', '替代文档已退役逐行拦截')

// ---------- 3. 文档间替代冲突：旧文档正作为他人替代文档 ----------
console.log('\n[3] 被用作替代文档的文档不可退役/删除')
const x3 = await mkDoc(); const y3 = await mkDoc(); const z3 = await mkDoc()
r = await retirement.initiateRetirementBatch({ rows: [{ docId: x3.id, replacementDocId: y3.id }] }, owner)
assert(r.status === 'ok', '前置：X⇒Y 在途退役单')
// y3 再发起退役（单篇与批量两条路径都拦）
r = await retirement.initiateRetirement({ docId: y3.id, replacementDocId: z3.id }, owner)
assert(r.status === 'used-as-replacement', '单篇：作为在途退役替代文档的 Y 不可退役')
r = await retirement.initiateRetirementBatch({ rows: [{ docId: y3.id, replacementDocId: z3.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'used-as-replacement', '批量：作为在途退役替代文档的 Y 逐行拦截')
assert(!!retirement.openRetirementUsingAsReplacement(y3.id), 'store 可查到 Y 被在途单用作替代')
r = await kb.deleteDoc(y3.id, admin)
assert(r.status === 'is-replacement', '作为在途退役替代文档的文档不可删除')
// 取消在途单后 Y 可退役
await retirement.cancelRetirement(retirement.openRetirementOfDoc(x3.id).id, owner)
r = await retirement.initiateRetirement({ docId: y3.id, replacementDocId: z3.id }, owner)
assert(r.status === 'ok', '在途退役取消后，Y 可发起退役')
await retirement.cancelRetirement(r.retirement.id, owner)

// ---------- 4. 评审/交接占用逐行拦截 ----------
console.log('\n[4] 评审中/交接中的文档不可批量送审')
const a4 = await mkDoc(); const rep4 = await mkDoc()
await db.reviews.add({
  id: uid('rev'), docId: a4.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: a4.title, body: a4.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
})
await db.docs.update(a4.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: 'dummy' })
r = await retirement.initiateRetirementBatch({ rows: [{ docId: a4.id, replacementDocId: rep4.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'in-review', '评审中文档逐行返回 in-review')
await db.reviews.where('docId').equals(a4.id).delete()
await db.docs.update(a4.id, { publishState: PUBLISH.PUBLISHED, activeReviewId: null })

const a5 = await mkDoc()
r = await handover.initiateHandover({ items: [{ docId: a5.id, toUserId: other.id }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'ok', '前置：交接发起成功')
r = await retirement.initiateRetirementBatch({ rows: [{ docId: a5.id, replacementDocId: rep4.id }] }, owner)
assert(r.status === 'invalid' && r.rows[0].error === 'in-handover', '交接中文档逐行返回 in-handover')

// ---------- 5. 成功统一送审：生成批次 + N 张待审批单 ----------
console.log('\n[5] 统一送审成功，批次与逐篇退役单建立')
const dA = await mkDoc({ title: '旧文档A' })
const dB = await mkDoc({ title: '旧文档B' })
const dC = await mkDoc({ title: '旧文档C' })
const repA = await mkDoc({ title: '新文档RA' })
const repB = await mkDoc({ title: '新文档RB' })
// dC 与 dA 共用同一替代文档（允许）
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
assert(batch.status === RETIRE_BATCH.ACTIVE && batch.total === 3, '批次初始为待逐篇审批，共 3 篇')
assert(r.retirements.every((x) => x.batchId === batch.id && x.status === RETIRE.PENDING), '每张退役单挂载 batchId 且待审批')
assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.ACTIVE, 'store 派生批次状态 active')
assert(retirement.itemsOfBatch(batch.id).map((x) => x.docId).join() === [dA.id, dB.id, dC.id].join(), '批次内退役单按送审顺序排列')
assert(retirement.pendingApprovalFor('admin').length >= 3, '三篇进入管理员待审批列表（逐篇可见）')
assert(retirement.pendingCountFor('admin') >= 3, '管理员角标计入批次待审批篇数')
// 篇级原因优先，未填则回退批次统一原因
assert(r.retirements[0].reason === 'A 篇级原因', '篇级退役原因保留')
assert(r.retirements[1].reason === '批次统一退役原因' && r.retirements[2].reason === '批次统一退役原因', '未填篇级原因时回退批次统一原因')
assert(r.retirements[0].timeline.some((t) => t.action === 'batch-submit'), '退役单留有随批次送审痕迹')

// ---------- 6. 管理员逐篇批准/驳回：联动按篇独立 ----------
console.log('\n[6] 管理员逐篇处理，共享撤销/问答引用/工单改挂按篇独立生效')
const items = retirement.itemsOfBatch(batch.id)
const [rtA, rtB, rtC] = items

// 先驳回 B
r = await retirement.decideRetirement(rtB.id, 'reject', 'B 暂缓', admin)
assert(r.status === 'ok' && r.approved === false, '管理员逐篇驳回 B')
assert((await getDoc(dB.id)).retirement === undefined && isDocSearchable(await getDoc(dB.id)), '驳回的 B 保持原状仍可搜索')
assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.ACTIVE, '仍有 A/C 待审批，批次仍 active')

// 批准 A：A 停引用、撤链接、改挂工单
r = await retirement.decideRetirement(rtA.id, 'approve', '', admin)
assert(r.status === 'ok' && r.approved === true, '管理员逐篇批准 A 生效')
const dAAfter = await getDoc(dA.id)
assert(isDocRetired(dAAfter) && !isDocSearchable(dAAfter) && !isDocRetireCitable(dAAfter), 'A 已退役并停止搜索/问答引用')
const sA2 = await db.shares.get(sA.id)
assert(sA2.revokedAt && sA2.revokeReason === 'retirement:' + rtA.id && !isShareActive(sA2), 'A 的有效共享链接随本篇退役撤销')
const gA2 = await db.gapTickets.get(gA.id)
assert(gA2.docId === repA.id, 'A 的已解决工单答案来源改挂 RA')
// B 被驳回，其链接/工单不受 A 批准影响
const sB2 = await db.shares.get(sB.id)
assert(isShareActive(sB2), 'B 的共享链接不受 A 篇批准影响')
assert((await db.gapTickets.get(gB.id)).docId === dB.id, 'B 的工单答案来源不受 A 篇批准影响')
// C 仍待审批，批次状态
assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.ACTIVE, 'A 批准、B 驳回、C 仍待审批 → 批次仍 active')

// 批准 C（与 A 共用替代文档 RA）：两张退役单可同时指向同一替代文档
r = await retirement.decideRetirement(rtC.id, 'approve', '', admin)
assert(r.status === 'ok', '管理员逐篇批准 C 生效（与 A 共用替代文档 RA）')
assert(isDocRetired(await getDoc(dC.id)), 'C 已退役')
assert(retirement.batchStatusById[batch.id] === RETIRE_BATCH.ACTIVE_RETIRED, '无待审批且有生效篇 → active-retired')
const prog = retirementBatchProgress(retirement.itemsOfBatch(batch.id))
assert(prog.approved === 2 && prog.rejected === 1 && prog.pending === 0 && prog.done === 3, '批次进度：2 生效 / 1 驳回 / 0 待审批')

// 纯函数：批次状态派生与进度
assert(retirementBatchStatusOf([{ status: RETIRE.PENDING }]) === RETIRE_BATCH.ACTIVE, '纯函数：含待审批即 active')
assert(retirementBatchStatusOf([{ status: RETIRE.REJECTED }, { status: RETIRE.CANCELLED }]) === RETIRE_BATCH.RESOLVED, '纯函数：全结案无生效 → resolved')
assert(retirementBatchStatusOf([{ status: RETIRE.APPROVED }, { status: RETIRE.REJECTED }]) === RETIRE_BATCH.ACTIVE_RETIRED, '纯函数：有生效篇 → active-retired')
assert(retirementBatchStatusOf([{ status: RETIRE.REVOKED }, { status: RETIRE.REVOKED }]) === RETIRE_BATCH.REVERTED, '纯函数：曾生效全撤销 → reverted')

// 纯函数：checkRetirementBatch 批次内成环（A⇒B, B⇒A）
const ck = checkRetirementBatch(
  [
    { docId: 'A', replacementDocId: 'B' },
    { docId: 'B', replacementDocId: 'A' }
  ],
  {
    docOf: (id) => ({ id, title: id, ownerId: owner.id }),
    openRetirementOfDoc: () => null, activeRetirementOfDoc: () => null,
    openUsingAsReplacement: () => null, activeUsingAsReplacement: () => null,
    pendingReviewOfDoc: () => null, openHandoverOfDoc: () => null
  }
)
assert(ck.rows.every((x) => x.error === 'replacement-in-batch'), '纯函数：批次内成环两篇均被拦截')

// ---------- 7. 审批期间并发替代冲突：批准兜底（跨标签页/历史脏数据防御） ----------
console.log('\n[7] 审批期间旧文档变为他人替代文档，批准兜底拦截')
const m1 = await mkDoc(); const m2 = await mkDoc()
r = await retirement.initiateRetirementBatch({ rows: [{ docId: m1.id, replacementDocId: m2.id }] }, owner)
const rtM1 = r.retirements[0]
// 正常流程下双向守卫已使「M1 在途退役且被他单当替代」不可达；此处直接插入冲突在途单，
// 模拟跨标签页并发/历史数据：另一篇 M4⇒M1 待审批
const m4 = await mkDoc()
await db.retirements.add({
  id: uid('rt'), status: RETIRE.PENDING, docId: m4.id, docTitle: m4.title,
  replacementDocId: m1.id, replacementTitle: m1.title, replacementOwnerId: m1.ownerId,
  initiatedBy: admin.id, reason: '', createdAt: nowIso(), decidedBy: null, decidedAt: null,
  decideNote: '', approvedAt: null, revokedBy: null, revokedAt: null, revokeNote: '',
  batchId: null, effects: null, timeline: []
})
await retirement.reload()
r = await retirement.decideRetirement(rtM1.id, 'approve', '', admin)
assert(r.status === 'used-as-replacement', '批准兜底：M1 已被他单用作替代，不允许生效')
assert(!isDocRetired(await getDoc(m1.id)), '兜底拦截后 M1 未退役')
// 冲突单被取消（脏数据解除）后，M1 篇可正常批准
await db.retirements.delete(retirement.openRetirementOfDoc(m4.id).id)
await retirement.reload()
r = await retirement.decideRetirement(rtM1.id, 'approve', '', admin)
assert(r.status === 'ok', '冲突在途单解除后，M1 篇可正常批准')

// ---------- 8. 批次整体取消（审批前） ----------
console.log('\n[8] 批次整体取消待审批申请')
const e1 = await mkDoc(); const e2 = await mkDoc(); const erep = await mkDoc(); const erep2 = await mkDoc()
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: e1.id, replacementDocId: erep.id }, { docId: e2.id, replacementDocId: erep2.id }]
}, owner)
assert(r.status === 'ok', '前置：两篇统一送审成功')
const eb = r.batch
const ebRetirements = r.retirements
// 非发起人/管理员不可整体取消
r = await retirement.cancelRetirementBatch(eb.id, other)
assert(r.status === 'denied', '非发起人/管理员不能整体取消批次')
// 先批准其中一篇，再整体取消：仅待审批篇被取消，已生效篇不动
await retirement.decideRetirement(ebRetirements[0].id, 'approve', '', admin)
r = await retirement.cancelRetirementBatch(eb.id, owner)
assert(r.status === 'ok' && r.cancelled.length === 1, '整体取消：仅 1 篇仍在待审批被取消')
const ebItems = retirement.itemsOfBatch(eb.id)
assert(ebItems[0].status === RETIRE.APPROVED && ebItems[1].status === RETIRE.CANCELLED, '已批准篇保持生效，待审批篇被取消')
assert(retirement.batchStatusById[eb.id] === RETIRE_BATCH.ACTIVE_RETIRED, '整体取消后批次有生效篇 → active-retired')
assert(!isDocRetired(await getDoc(e2.id)) && isDocSearchable(await getDoc(e2.id)), '被取消的 e2 恢复可退役/可搜索状态')
// 无待审批篇再次取消返回 changed
r = await retirement.cancelRetirementBatch(eb.id, owner)
assert(r.status === 'changed', '批次无待审批篇时整体取消返回 changed')

// ---------- 9. 批量撤销已生效退役：逐篇独立、聚合结果 ----------
console.log('\n[9] 批量撤销已生效退役，逐篇独立恢复')
const f1 = await mkDoc(); const f2 = await mkDoc(); const frep = await mkDoc()
const gf1 = await mkResolvedGap(f1.id, 'F1 问题'); const gf2 = await mkResolvedGap(f2.id, 'F2 问题')
const sf1 = await mkShare(f1.id)
r = await retirement.initiateRetirementBatch({
  rows: [{ docId: f1.id, replacementDocId: frep.id }, { docId: f2.id, replacementDocId: frep.id }]
}, owner)
const fb = r.batch
for (const x of r.retirements) await retirement.decideRetirement(x.id, 'approve', '', admin)
assert(retirement.itemsOfBatch(fb.id).every((x) => x.status === RETIRE.APPROVED), '前置：两篇均生效')
assert((await db.gapTickets.get(gf1.id)).docId === frep.id && (await db.gapTickets.get(gf2.id)).docId === frep.id, '两张工单均改挂 frep')

// f1 的工单在退役期间被另行退回处理 → 撤销时不回挂（不阻塞 f2）
await db.gapTickets.update(gf1.id, {
  status: GAP.CLAIMED, docId: null,
  timeline: [...(await db.gapTickets.get(gf1.id)).timeline, { action: 'return', by: other.id, note: '退回处理', at: nowIso() }]
})
await gap.reload()

r = await retirement.revokeRetirementBatch(fb.id, '旧体系并行恢复', owner)
assert(r.status === 'ok' && r.done === 2 && r.failed === 0, '批量撤销两篇均完成（逐篇独立事务）')
const f1b = await getDoc(f1.id); const f2b = await getDoc(f2.id)
assert(!isDocRetired(f1b) && !isDocRetired(f2b) && isDocSearchable(f1b) && isDocSearchable(f2b), '两篇旧文档均解除退役、恢复搜索引用')
const sf1b = await db.shares.get(sf1.id)
assert(isShareActive(sf1b), 'f1 撤销退役后其共享链接恢复')
const gf1b = await db.gapTickets.get(gf1.id); const gf2b = await db.gapTickets.get(gf2.id)
assert(gf1b.status === GAP.CLAIMED && gf1b.docId === null, 'f1 被另行处理的工单不强行回挂')
assert(gf2b.docId === f2.id, 'f2 工单答案来源正常回挂，不受 f1 异常篇阻塞')
assert(retirement.batchStatusById[fb.id] === RETIRE_BATCH.REVERTED, '两篇均撤销退役 → 批次 reverted')
assert(retirement.itemsOfBatch(fb.id).every((x) => x.status === RETIRE.REVOKED), '批次内退役单均为 revoked')

// 无生效篇再批量撤销
r = await retirement.revokeRetirementBatch(fb.id, '', owner)
assert(r.status === 'changed', '批次无生效篇时批量撤销返回 changed')
// 权限
r = await retirement.revokeRetirementBatch(batch.id, '', other)
assert(r.status === 'denied', '非发起人/管理员不能批量撤销批次')

// ---------- 10. 单篇退役记录兼容（无 batchId） ----------
console.log('\n[10] 无 batchId 的单篇退役记录兼容')
const s1 = await mkDoc(); const srep = await mkDoc()
r = await retirement.initiateRetirement({ docId: s1.id, replacementDocId: srep.id, reason: '单篇退役' }, owner)
assert(r.status === 'ok' && !r.retirement.batchId, '单篇发起退役单无 batchId')
const rtS = r.retirement
await retirement.decideRetirement(rtS.id, 'approve', '', admin)
assert(isDocRetired(await getDoc(s1.id)), '单篇退役正常生效')
r = await retirement.revokeRetirement(rtS.id, '', owner)
assert(r.status === 'ok' && isDocSearchable(await getDoc(s1.id)), '单篇退役正常撤销恢复')
// 批次视图不收录单篇；单篇退役单不出现在任何批次下
assert(retirement.batches.every((b) => b.id !== rtS.batchId), '单篇退役单不生成批次记录')
assert(retirement.sorted.some((x) => x.id === rtS.id && !x.batchId), '全部记录中仍可查到无批次单篇退役单')
assert(retirement.initiatedBy(owner.id).some((x) => x.id === rtS.id), '我发起的列表兼容单篇退役单')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
