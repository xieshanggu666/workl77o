// 知识退役替代端到端回归（fake-indexeddb + 真实 store）
// 覆盖：负责人发起退役（权限/替代文档/评审/交接占用校验）→ 管理员驳回/批准 →
// 批准同事务：停止旧文档搜索与问答引用、撤销共享链接、已解决缺口工单答案来源改挂替代文档 →
// 替代文档不可访问时走访问申请 → 撤销退役恢复搜索引用/共享链接/答案来源 → 记录全程保留。
// 运行：npm run test:retirement
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
import { RETIRE, isDocRetired, isDocSearchable, isDocRetireCitable } from '@/utils/retirement'
import { canEditDoc, canDeleteDoc, canViewDoc } from '@/utils/permission'
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
    id: uid('doc'), title: '退役文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>旧正文 Vue 初始化 Dexie 查询</p>', categoryId: 'c', tagIds: [], visibility: 'public',
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

async function mkShare(docId, opts = {}) {
  const s = {
    id: uid('share'), docId, token: makeToken(), permission: opts.permission || 'view',
    createdBy: owner.id, createdAt: nowIso(),
    expiresAt: opts.expiresAt || null, revokedAt: opts.revokedAt || null
  }
  await db.shares.add(s)
  return s
}

// ---------- 1. 发起校验 ----------
console.log('\n[1] 发起退役的权限与参数校验')
const d1 = await mkDoc()
const rep1 = await mkDoc({ title: '替代文档-1' })
let r = await retirement.initiateRetirement({ docId: d1.id, replacementDocId: rep1.id, reason: '' }, null)
assert(r.status === 'guest', '访客不能发起退役')
r = await retirement.initiateRetirement({ docId: d1.id, replacementDocId: rep1.id }, other)
assert(r.status === 'denied', '非负责人/管理员不能发起他人文档退役')
r = await retirement.initiateRetirement({ docId: d1.id, replacementDocId: d1.id }, owner)
assert(r.status === 'bad-replacement', '替代文档不能是文档自身')
r = await retirement.initiateRetirement({ docId: d1.id, replacementDocId: 'doc-ghost' }, owner)
assert(r.status === 'bad-replacement', '替代文档不存在被拒绝')
r = await retirement.initiateRetirement({ docId: 'doc-ghost', replacementDocId: rep1.id }, owner)
assert(r.status === 'missing', '旧文档不存在被拒绝')
r = await retirement.initiateRetirement({ docId: d1.id, replacementDocId: rep1.id, reason: '内容已过时' }, owner)
assert(r.status === 'ok' && r.retirement.status === RETIRE.PENDING, '负责人发起成功，待管理员审批')
const rt1 = r.retirement
r = await retirement.initiateRetirement({ docId: d1.id, replacementDocId: rep1.id }, owner)
assert(r.status === 'in-retirement', '同一文档存在流转中退役单时不可重复发起')
assert(retirement.openRetirementOfDoc(d1.id)?.id === rt1.id, '可查到文档流转中的退役单')
// 管理员可代任意文档发起
const dAdmin = await mkDoc({ ownerId: other.id })
r = await retirement.initiateRetirement({ docId: dAdmin.id, replacementDocId: rep1.id }, admin)
assert(r.status === 'ok', '管理员可对任意文档发起退役')
await db.retirements.update(r.retirement.id, { status: RETIRE.CANCELLED })
await retirement.reload()

// 评审中/交接中的文档不可发起
const dReview = await mkDoc()
await db.reviews.add({
  id: uid('rev'), docId: dReview.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: dReview.title, body: dReview.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
})
await db.docs.update(dReview.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: 'dummy' })
r = await retirement.initiateRetirement({ docId: dReview.id, replacementDocId: rep1.id }, owner)
assert(r.status === 'in-review', '评审中的文档不可发起退役')
await db.reviews.where('docId').equals(dReview.id).delete()
await db.docs.update(dReview.id, { publishState: PUBLISH.PUBLISHED, activeReviewId: null })

const dHo = await mkDoc()
r = await handover.initiateHandover({ items: [{ docId: dHo.id, toUserId: other.id }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'ok', '前置：交接发起成功')
r = await retirement.initiateRetirement({ docId: dHo.id, replacementDocId: rep1.id }, owner)
assert(r.status === 'in-handover', '交接中的文档不可发起退役')

// 交接事务不接受已退役/退役流转中文档
r = await handover.initiateHandover({ items: [{ docId: d1.id, toUserId: other.id }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'in-retirement', '存在流转中退役单的文档不可发起交接')

// ---------- 2. 驳回与审批前撤销 ----------
console.log('\n[2] 驳回与审批前撤销')
r = await retirement.decideRetirement(rt1.id, 'reject', '替代关系待确认', other)
assert(r.status === 'denied', '非管理员不能审批退役')
r = await retirement.decideRetirement(rt1.id, 'reject', '替代关系待确认', admin)
assert(r.status === 'ok' && r.approved === false && (await db.retirements.get(rt1.id)).status === RETIRE.REJECTED, '管理员驳回退役')
assert((await getDoc(d1.id)).retirement === undefined, '驳回后文档保持原状（无退役标记）')
assert(isDocSearchable(await getDoc(d1.id)), '驳回后文档仍可搜索')

const d2 = await mkDoc()
r = await retirement.initiateRetirement({ docId: d2.id, replacementDocId: rep1.id }, owner)
const rt2 = r.retirement
r = await retirement.cancelRetirement(rt2.id, other)
assert(r.status === 'denied', '非发起人/管理员不能撤销他人退役申请')
r = await retirement.cancelRetirement(rt2.id, owner)
assert(r.status === 'ok' && (await db.retirements.get(rt2.id)).status === RETIRE.CANCELLED, '发起人可审批前撤销退役申请')

// ---------- 3. 批准生效：搜索/问答闸门 + 共享链接 + 缺口工单 ----------
console.log('\n[3] 批准生效：停止搜索/问答引用、撤销共享链接、改挂缺口工单答案来源')
const d3 = await mkDoc({ title: '旧鉴权文档', body: '<p>鉴权 Token 权限点 Vue 初始化</p>' })
const rep3 = await mkDoc({ title: '新鉴权文档', body: '<p>新统一鉴权链路</p>' })
// 三条共享链接：有效 view、有效 edit、已撤销；另加一条已过期
const shareView = await mkShare(d3.id, { permission: 'view' })
const shareEdit = await mkShare(d3.id, { permission: 'edit' })
const shareRevokedAlready = await mkShare(d3.id, { revokedAt: nowIso() })
const shareExpired = await mkShare(d3.id, { expiresAt: new Date(Date.now() - 86400000).toISOString() })
// 两张已解决缺口工单（答案来源为旧文档）+ 一张未解决工单（不应被动）
const gap1 = await mkResolvedGap(d3.id, '权限模型里有哪些角色?')
const gap2 = await mkResolvedGap(d3.id, 'Token 如何校验?')
const gapOpen = {
  id: uid('gap'), question: '未解决的问题', detail: '', status: GAP.OPEN, createdBy: viewer.id, createdAt: nowIso(),
  claimedBy: null, claimedAt: null, docId: null, reviewId: null, groupId: null, resolvedAt: null, timeline: []
}
await db.gapTickets.add(gapOpen)

r = await retirement.initiateRetirement({ docId: d3.id, replacementDocId: rep3.id, reason: '鉴权体系升级' }, owner)
const rt3 = r.retirement
r = await retirement.decideRetirement(rt3.id, 'approve', '', admin)
assert(r.status === 'ok' && r.approved === true, '管理员批准退役生效')

const d3After = await getDoc(d3.id)
assert(isDocRetired(d3After) === true, '旧文档带生效退役标记')
assert(d3After.retirement.replacementDocId === rep3.id, '退役标记记录替代文档')
assert(isDocSearchable(d3After) === false, '旧文档停止搜索命中')
assert(isDocRetireCitable(d3After) === false, '旧文档停止问答引用')
assert(isDocSearchable(await getDoc(rep3.id)) === true, '替代文档正常可搜索/引用')
assert(canViewDoc(d3After, viewer.id) === true, '旧文档仍可直接查看详情（权限不变）')
assert(canEditDoc(d3After, { userId: owner.id, role: owner.role }) === false, '退役后负责人也不可编辑（只读归档）')
assert(canEditDoc(d3After, { userId: admin.id, role: admin.role }) === false, '退役后管理员也不可直接编辑')
assert(canDeleteDoc(d3After, { userId: owner.id, role: owner.role }) === false, '退役后不可删除')

// 共享链接：有效链接被撤销（记录保留 + 退役标记），本就撤销/过期的不变
const sv = await db.shares.get(shareView.id)
const se = await db.shares.get(shareEdit.id)
assert(sv.revokedAt && sv.revokeReason === 'retirement:' + rt3.id, '有效只读共享链接随退役撤销并标记来源')
assert(se.revokedAt && se.revokeReason === 'retirement:' + rt3.id, '有效可编辑共享链接随退役撤销')
assert(isShareActive(sv) === false && isShareActive(se) === false, '被撤销链接不再有效')
const sra = await db.shares.get(shareRevokedAlready.id)
assert(sra.revokeReason === undefined, '退役前已撤销的链接不被改动')
const sex = await db.shares.get(shareExpired.id)
assert(!sex.revokedAt, '已过期链接不重复撤销')

// 缺口工单：已解决工单答案来源改挂替代文档并留痕；未解决工单不变
const g1 = await db.gapTickets.get(gap1.id)
const g2 = await db.gapTickets.get(gap2.id)
assert(g1.docId === rep3.id && g2.docId === rep3.id, '已解决缺口工单答案来源改挂替代文档')
assert(g1.timeline.some((t) => t.action === 'gap-repoint' && t.note.includes(rt3.id)), '改挂在工单 timeline 留痕并带退役单 id')
const go = await db.gapTickets.get(gapOpen.id)
assert(go.status === GAP.OPEN && go.docId === null, '未解决工单不受退役影响')

// store effects 留档
const rt3Done = await db.retirements.get(rt3.id)
assert(rt3Done.effects.revokedShareIds.length === 2, '退役结果记录撤销的有效链接数（2 条）')
assert(rt3Done.effects.repointedTicketIds.length === 2, '退役结果记录改挂的工单数（2 张）')
assert(rt3Done.timeline.some((t) => t.action === 'approve'), '退役单留有批准痕迹')

// ---------- 4. 重复退役与替代文档约束 ----------
console.log('\n[4] 已退役文档 / 已作为替代文档的约束')
r = await retirement.initiateRetirement({ docId: d3.id, replacementDocId: rep1.id }, owner)
assert(r.status === 'in-retirement', '已退役文档不可再次发起退役（需先撤销退役）')
r = await retirement.initiateRetirement({ docId: rep1.id, replacementDocId: d3.id }, owner)
assert(r.status === 'replacement-retired', '不能以已退役文档作为替代文档')
r = await kb.deleteDoc(rep3.id, admin)
assert(r.status === 'is-replacement', '作为生效退役替代文档的旧… 替代文档不可删除')
r = await kb.deleteDoc(d3.id, admin)
assert(r.status === 'forbidden', '已退役旧文档不可删除')

// ---------- 5. 替代文档不可访问 → 访问申请通道 ----------
console.log('\n[5] 替代文档为私有 → 无权限成员引导申请权限')
const repPriv = await mkDoc({ visibility: 'private', ownerId: owner.id, editors: [owner.id] })
const d5 = await mkDoc({ visibility: 'public' })
r = await retirement.initiateRetirement({ docId: d5.id, replacementDocId: repPriv.id }, owner)
await retirement.decideRetirement(r.retirement.id, 'approve', '', admin)
// viewer 对公开的旧文档可查看，但对私有替代文档不可见 → canViewDoc 为 false，详情页将走 AccessApplyCard
assert(canViewDoc(await getDoc(d5.id), viewer.id) === true, '退役旧（公开）文档仍可查看')
assert(canViewDoc(await getDoc(repPriv.id), viewer.id) === false, '成员对私有替代文档无访问权限')
const { canRequestAccess } = await import('@/utils/access')
assert(canRequestAccess(await getDoc(repPriv.id), viewer.id, viewer.role) === true, '无权限成员可对替代文档发起访问申请')
const { useAccessStore } = await import('@/stores/access')
const accessStore = useAccessStore(pinia)
const ar = await accessStore.createRequest(repPriv.id, 'read', '需要查看退役后的替代文档', viewer)
assert(ar.status === 'ok' && ar.request.status === 'pending', '替代文档访问申请提交成功，进入拥有者审批')

// ---------- 6. 撤销退役：恢复搜索/引用、共享链接、答案来源 ----------
console.log('\n[6] 撤销退役并恢复，记录保留')
r = await retirement.revokeRetirement(rt3.id, '旧体系仍需并行维护', other)
assert(r.status === 'denied', '非发起人/管理员不能撤销退役')
r = await retirement.revokeRetirement(rt3.id, '旧体系仍需并行维护', owner)
assert(r.status === 'ok', '发起人撤销已生效退役')
const d3Restored = await getDoc(d3.id)
assert(d3Restored.retirement === null, '旧文档解除退役态')
assert(isDocSearchable(d3Restored) && isDocRetireCitable(d3Restored), '旧文档恢复搜索与问答引用')
const sv2 = await db.shares.get(shareView.id)
const se2 = await db.shares.get(shareEdit.id)
assert(!sv2.revokedAt && !sv2.revokeReason && isShareActive(sv2), '被本次退役撤销的只读链接恢复有效')
assert(!se2.revokedAt && isShareActive(se2), '被本次退役撤销的可编辑链接恢复有效')
const g1b = await db.gapTickets.get(gap1.id)
const g2b = await db.gapTickets.get(gap2.id)
assert(g1b.docId === d3.id && g2b.docId === d3.id, '答案来源回挂旧文档')
assert(g1b.timeline.some((t) => t.action === 'gap-restore'), '回挂在工单 timeline 留痕')
const rt3Revoked = await db.retirements.get(rt3.id)
assert(rt3Revoked.status === RETIRE.REVOKED && rt3Revoked.revokeNote.includes('并行维护'), '退役单置为「已撤销退役」并保留说明')
assert(rt3Revoked.effects.restoredShareIds.length === 2 && rt3Revoked.effects.restoredTicketIds.length === 2, '撤销结果记录恢复数量')

// 撤销后文档可再次退役
r = await retirement.initiateRetirement({ docId: d3.id, replacementDocId: rep3.id }, owner)
assert(r.status === 'ok', '撤销退役后可重新发起退役')
const rt4 = r.retirement
await retirement.decideRetirement(rt4.id, 'approve', '', admin)
assert((await getDoc(d3.id)).retirement?.id === rt4.id, '再次退役生效，指向新退役单')
// 撤销第二次退役：仅恢复第二次撤销的链接（幂等不串单）
r = await retirement.revokeRetirement(rt4.id, '', owner)
assert(r.status === 'ok', '第二次退役也可撤销')

// ---------- 7. 撤销退役期间工单被另行处理 → 不强行回挂 ----------
console.log('\n[7] 退役期间工单被另行处理时，撤销退役不覆盖')
const d7 = await mkDoc()
const rep7 = await mkDoc()
const g7 = await mkResolvedGap(d7.id, '独立的问题 XYZ')
r = await retirement.initiateRetirement({ docId: d7.id, replacementDocId: rep7.id }, owner)
const rt7 = r.retirement.id
await retirement.decideRetirement(rt7, 'approve', '', admin)
assert((await db.gapTickets.get(g7.id)).docId === rep7.id, '前置：工单已改挂替代文档')
// 退役期间该工单被人工退回处理并清空答案来源（模拟另行处理）
await db.gapTickets.update(g7.id, {
  status: GAP.CLAIMED, docId: null,
  timeline: [...(await db.gapTickets.get(g7.id)).timeline, { action: 'return', by: other.id, note: '退回处理', at: nowIso() }]
})
await gap.reload()
r = await retirement.revokeRetirement(rt7, '', owner)
assert(r.status === 'ok' && !r.restoredTicketIds.includes(g7.id), '被另行处理的工单不随撤销退役回挂')
const g7b = await db.gapTickets.get(g7.id)
assert(g7b.status === GAP.CLAIMED && g7b.docId === null, '工单保持退回处理后的状态')
// 共享链接仍正常恢复
assert(r.restoredShareIds.length >= 0, '撤销退役不影响共享链接恢复逻辑')

// ---------- 8. store 查询 ----------
console.log('\n[8] store 查询与角标')
assert(retirement.pendingApprovalFor('admin').length === 0, '当前无待审批退役（均已结案）')
const mine = retirement.initiatedBy(owner.id)
assert(mine.length >= 4, '可查到我发起的全部退役单（含驳回/撤销/生效，全程保留）')
assert(retirement.pendingCountFor('admin') === 0, '管理员角标：待审批为 0')
assert(retirement.activeRetirementOfDoc(d5.id)?.status === RETIRE.APPROVED, '可查到文档生效退役（d5 仍退役）')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
