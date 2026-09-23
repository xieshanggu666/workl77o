// 知识责任交接端到端回归（fake-indexeddb + 真实 store）
// 覆盖：v10 迁移（旧整单接任者 → 逐篇接任者/状态）→ 负责人在同一批中逐篇指定接任者
// （权限/快照/重复发起校验）→ 各接任者按篇独立确认/谢绝 → 管理员按确认结果分批批准
// （先确认先批、未确认不批）→ 批准篇统一转移（所有权 + 历史归属 + 评审待办 + 保鲜责任 +
// 待审批访问申请 + 按决定收回权限）→ 交接期间并发变更：冲突篇失败回退、同批一致篇正常转移；
// 驳回 / 取消 / 多次交接历史累积 / 批次状态派生纯函数。
// 运行：npm run test:handover
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db, KnowledgeDB } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useHandoverStore } from '@/stores/handover'
import { uid } from '@/utils/format'
import {
  HO_ITEM, HANDOVER, REVOKE_MODE, isHandoverOpen, handoverStatusOf, checkHandoverConflicts
} from '@/utils/handover'
import { canDecideAccess, ACCESS, isGrantActive } from '@/utils/access'
import { PUBLISH } from '@/utils/review'

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const nowIso = () => new Date().toISOString()

// ---------- 0. v10 迁移：旧格式交接单升级为逐篇接任者 ----------
console.log('\n[0] v10 迁移：整单接任者/状态映射到每一篇')
class OldDB extends Dexie {
  constructor(name) {
    super(name)
    this.version(1).stores({
      users: 'id, name, role, email', categories: 'id, name', tags: 'id, name',
      docs: 'id, title, categoryId, visibility, ownerId, updatedAt, createdAt, *tagIds',
      comments: 'id, docId, authorId, createdAt', shares: 'id, docId, token',
      favorites: 'id, [userId+docId], docId', recentViews: 'id, [userId+docId], docId, viewedAt',
      ratings: 'id, [docId+slug]'
    })
    this.version(2).stores({ reviews: 'id, docId, status, submittedBy, submittedAt, decidedBy, decidedAt', comments: 'id, docId, authorId, createdAt, reviewId' })
    this.version(3).stores({ gapTickets: 'id, status, createdBy, claimedBy, docId, reviewId, createdAt' })
    this.version(4).stores({ accessRequests: 'id, docId, applicantId, status, requestedPermission, createdAt, decidedAt, expiresAt, revokedAt' })
    this.version(5).stores({ gapTickets: 'id, status, createdBy, claimedBy, docId, reviewId, groupId, createdAt' })
    this.version(6).stores({ freshnessTickets: 'id, docId, status, round, dueAt, createdAt' })
    this.version(7).stores({ handovers: 'id, status, fromUserId, toUserId, createdAt, decidedAt' })
    this.version(8).stores({ retirements: 'id, status, docId, replacementDocId, initiatedBy, decidedBy, createdAt, decidedAt' })
    this.version(9).stores({ freshnessPolicies: 'id, categoryId, updatedAt' })
  }
}
const old = new OldDB('knowbase-ho-mig')
await old.handovers.bulkAdd([
  {
    id: 'ho-old-1', status: 'pending_approval',
    fromUserId: 'u1', toUserId: 'u2', docIds: ['dx1', 'dx2'], revokeMode: 'keep', note: '',
    items: [
      { docId: 'dx1', title: 'X1', snapshot: { ownerId: 'u1' }, result: null },
      { docId: 'dx2', title: 'X2', snapshot: { ownerId: 'u1' }, result: null }
    ],
    createdAt: nowIso(), confirmedAt: nowIso(), decidedBy: null, decidedAt: null, decideNote: '',
    completedAt: null, failReason: '', timeline: []
  },
  {
    id: 'ho-old-2', status: 'completed',
    fromUserId: 'u1', toUserId: 'u3', docIds: ['dx3'], revokeMode: 'revoke', note: '',
    items: [{ docId: 'dx3', title: 'X3', snapshot: { ownerId: 'u1' }, result: { reviewIds: [], freshTicketId: null, accessPending: 0, revokedGrants: 0 } }],
    createdAt: nowIso(), confirmedAt: nowIso(), decidedBy: 'u-admin', decidedAt: nowIso(), decideNote: '同意',
    completedAt: nowIso(), failReason: '', timeline: []
  }
])
await old.close()
const mig = new KnowledgeDB('knowbase-ho-mig')
await mig.open()
const m1 = await mig.handovers.get('ho-old-1')
assert(m1.items.every((it) => it.toUserId === 'u2'), '迁移：每篇接任者取自单级 toUserId')
assert(m1.items.every((it) => it.status === HO_ITEM.CONFIRMED), '迁移：待批准单的每篇映射为已确认待批准')
assert(m1.items[0].confirmedAt === m1.confirmedAt, '迁移：单级确认时间同步到篇')
const m2 = await mig.handovers.get('ho-old-2')
assert(m2.items[0].status === HO_ITEM.COMPLETED && m2.items[0].toUserId === 'u3', '迁移：已完成单的篇状态与接任者同步')
assert(m2.items[0].decideNote === '同意' && m2.items[0].completedAt === m2.completedAt, '迁移：单级审批备注/完成时间同步到篇')
await mig.close()

// ---------- 主流程（真实 store） ----------
const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const auth = useAuthStore(pinia)
const review = useReviewStore(pinia)
const access = useAccessStore(pinia)
const freshness = useFreshnessStore(pinia)
const handover = useHandoverStore(pinia)

const owner = { id: 'u-owner', name: '原负责人', role: 'editor', avatar: 'YZ' }
const next = { id: 'u-next', name: '接任者', role: 'editor', avatar: 'JR' }
const third = { id: 'u-third', name: '第三成员', role: 'editor', avatar: 'DS' }
const admin = { id: 'u-admin', name: '管理员', role: 'admin', avatar: 'GL' }
const viewer = { id: 'u-viewer', name: '只读', role: 'viewer', avatar: 'ZD' }

await db.users.bulkAdd([owner, next, third, admin, viewer].map((u) => ({ ...u, email: '', title: '' })))

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '交接文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>正文 v1</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: { title: '', body: '<p>正文 v1</p>', categoryId: 'c', tagIds: [], visibility: 'public' } }],
    ...extra
  }
  d.versions[0].snapshot.title = d.title
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}
const getDoc = (id) => db.docs.get(id)
const getHo = (id) => db.handovers.get(id)
const itemOf = (h, docId) => (h.items || []).find((i) => i.docId === docId)

// ---------- 1. 发起校验 ----------
console.log('\n[1] 发起交接的权限与参数校验')
const d1 = await mkDoc()
let r = await handover.initiateHandover({ items: [{ docId: d1.id, toUserId: next.id }], revokeMode: 'keep', note: '' }, null)
assert(r.status === 'guest', '访客不能发起交接')
r = await handover.initiateHandover({ items: [], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'no-docs', '未选择文档被拒绝')
r = await handover.initiateHandover({ items: [{ docId: d1.id, toUserId: '' }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'bad-target', '每篇都必须指定接任者')
r = await handover.initiateHandover({ items: [{ docId: d1.id, toUserId: owner.id }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'bad-target', '接任者不能是自己')
r = await handover.initiateHandover({ items: [{ docId: d1.id, toUserId: 'u-ghost' }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'bad-target', '接任者必须是已注册成员')
r = await handover.initiateHandover({ items: [{ docId: 'doc-ghost', toUserId: next.id }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'missing', '文档不存在被拒绝')
r = await handover.initiateHandover({ items: [{ docId: d1.id, toUserId: next.id }], revokeMode: 'keep', note: '' }, third)
assert(r.status === 'denied', '非负责人不能交接他人文档')
r = await handover.initiateHandover({ items: [{ docId: d1.id, toUserId: next.id }, { docId: d1.id, toUserId: third.id }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'ok' && r.handover.items.length === 1 && r.handover.items[0].toUserId === next.id, '同一文档重复指定去重（先出现的为准）')
r = await handover.cancelHandover(r.handover.id, owner)
assert(r.status === 'ok', '清理：发起人取消该交接单')

// ---------- 2. 同一批逐篇指定接任者，各接任者独立确认/谢绝 ----------
console.log('\n[2] 逐篇指定接任者，独立确认与谢绝')
const dA = await mkDoc()
const dB = await mkDoc()
r = await handover.initiateHandover({ items: [{ docId: dA.id, toUserId: next.id }, { docId: dB.id, toUserId: third.id }], revokeMode: 'keep', note: '轮岗交接' }, owner)
assert(r.status === 'ok' && r.handover.status === HANDOVER.PENDING_CONFIRM, '同一批逐篇指定不同接任者，发起成功')
const ho1 = r.handover
assert(itemOf(ho1, dA.id).toUserId === next.id && itemOf(ho1, dB.id).toUserId === third.id, '每篇接任者随篇记录')
assert(ho1.items.every((i) => i.status === HO_ITEM.PENDING_CONFIRM), '每篇初始均为待确认')
assert(itemOf(ho1, dA.id).snapshot.ownerId === owner.id && itemOf(ho1, dA.id).snapshot.updatedAt === dA.updatedAt, '发起时为每篇打并发校验快照')
r = await handover.initiateHandover({ items: [{ docId: dA.id, toUserId: third.id }], revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'in-handover', '同一文档存在流转中交接篇时不可重复发起')
assert(handover.activeHandoverOfDoc(dA.id)?.id === ho1.id, '文档可查到流转中的交接单')
assert(handover.activeItemOfDoc(dB.id)?.item.toUserId === third.id, '文档可查到流转中的交接篇及其接任者')
assert(handover.pendingConfirmFor(next.id).some((h) => h.id === ho1.id) && handover.pendingConfirmFor(third.id).some((h) => h.id === ho1.id), '两位接任者各自看到待确认事项')

r = await handover.confirmHandover(ho1.id, [dA.id], third)
assert(r.status === 'denied', '非该篇接任者不能确认')
r = await handover.confirmHandover(ho1.id, [dA.id], next)
assert(r.status === 'ok' && r.count === 1, '接任者确认自己的篇')
let ho1Cur = await getHo(ho1.id)
assert(itemOf(ho1Cur, dA.id).status === HO_ITEM.CONFIRMED, 'docA 篇进入待批准')
assert(itemOf(ho1Cur, dB.id).status === HO_ITEM.PENDING_CONFIRM, 'docB 篇不受影响仍待确认')
assert(ho1Cur.status === HANDOVER.PENDING_CONFIRM, '批次整体仍待接任者确认')
r = await handover.confirmHandover(ho1.id, [dA.id], next)
assert(r.status === 'changed', '重复确认被拒绝')

r = await handover.declineHandover(ho1.id, dB.id, '排期已满', next)
assert(r.status === 'denied', '非该篇接任者不能谢绝')
r = await handover.declineHandover(ho1.id, dB.id, '近期排期已满，暂不接收', third)
assert(r.status === 'ok', '接任者谢绝自己的篇')
ho1Cur = await getHo(ho1.id)
assert(itemOf(ho1Cur, dB.id).status === HO_ITEM.DECLINED, 'docB 篇已谢绝')
assert(itemOf(ho1Cur, dB.id).decideNote.includes('排期已满'), '谢绝备注随篇留痕')
assert(ho1Cur.status === HANDOVER.PENDING_APPROVAL, '批次整体转为待管理员批准')
assert((await getDoc(dB.id)).ownerId === owner.id, '被谢绝篇文档保持原状')

// ---------- 3. 管理员按确认结果分批批准 ----------
console.log('\n[3] 分批批准：先确认先批，未确认/已谢绝不参与')
r = await handover.decideHandover(ho1.id, [dB.id], 'approve', '', admin)
assert(r.status === 'changed', '未确认的篇不能批准')
r = await handover.decideHandover(ho1.id, [dA.id], 'approve', '先批已确认的', third)
assert(r.status === 'denied', '非管理员不能批准')
r = await handover.decideHandover(ho1.id, [dA.id], 'approve', '先批已确认的', admin)
assert(r.status === 'ok' && r.done === 1 && !r.failures.length, '管理员分批批准：先批已确认篇')
assert((await getDoc(dA.id)).ownerId === next.id, 'docA 所有权已转移给该篇接任者')
ho1Cur = await getHo(ho1.id)
assert(itemOf(ho1Cur, dA.id).status === HO_ITEM.COMPLETED, 'docA 篇已完成')
assert(itemOf(ho1Cur, dB.id).status === HO_ITEM.DECLINED, 'docB 篇保持已谢绝')
assert(ho1Cur.status === HANDOVER.PARTIAL, '全部篇终态且结果不一 → 批次部分完成')

// ---------- 4. 批准执行：全要素统一转移（revoke 模式，逐篇接任者） ----------
console.log('\n[4] 批准执行：所有权/待办审批/保鲜责任统一转移，按决定收回权限')
// docA2：负责人名下有待审批的评审单（待办审批转移）→ 接任者 next
const docA2 = await mkDoc()
const revA = {
  id: uid('rev'), docId: docA2.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: docA2.title, body: docA2.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
}
await db.reviews.add(revA)
await db.docs.update(docA2.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: revA.id })
// docB2：保鲜复核单流转中 + 待审批访问申请 + 原负责人的历史有效授权 → 接任者 third
const docB2 = await mkDoc({ editors: [owner.id, third.id] })
const frB = {
  id: uid('fr'), docId: docB2.id, round: 1, status: 'open', cycleDays: 30, dueAt: nowIso(),
  reviewId: null, submittedBy: owner.id, submittedAt: null, decidedBy: null, decidedAt: null,
  decisionNote: '', createdAt: nowIso(), timeline: []
}
await db.freshnessTickets.add(frB)
await db.docs.update(docB2.id, { freshness: { cycleDays: 30, nextDueAt: new Date(Date.now() + 86400000).toISOString(), round: 1, activeTicket: frB.id } })
const accPending = {
  id: uid('acc'), docId: docB2.id, applicantId: next.id, status: ACCESS.PENDING, requestedPermission: 'read',
  reason: '申请阅读', createdAt: nowIso(), decidedBy: null, decidedAt: null, decisionNote: '', grant: null, timeline: []
}
const accGrant = {
  id: uid('acc'), docId: docB2.id, applicantId: owner.id, status: ACCESS.APPROVED, requestedPermission: 'collab',
  reason: '历史授权', createdAt: nowIso(), decidedBy: admin.id, decidedAt: nowIso(), decisionNote: '',
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null,
  grant: { permission: 'collab', grantedAt: nowIso(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null },
  timeline: []
}
await db.accessRequests.bulkAdd([accPending, accGrant])
await Promise.all([kb.reloadDocs(), review.reload(), access.reload(), freshness.reload()])

r = await handover.initiateHandover({ items: [{ docId: docA2.id, toUserId: next.id }, { docId: docB2.id, toUserId: third.id }], revokeMode: REVOKE_MODE.REVOKE, note: '整体交接' }, owner)
assert(r.status === 'ok', '批量发起成功（含评审中/保鲜中文档）')
const ho2 = r.handover
r = await handover.decideHandover(ho2.id, [docA2.id, docB2.id], 'approve', '', admin)
assert(r.status === 'changed', '未经接任者确认不能批准执行')
r = await handover.confirmHandover(ho2.id, [docA2.id, docB2.id], next)
assert(r.status === 'denied', '不能代其他接任者确认其篇')
r = await handover.confirmHandover(ho2.id, [docA2.id], next)
assert(r.status === 'ok', 'next 确认自己的篇')
r = await handover.confirmHandover(ho2.id, [docB2.id], third)
assert(r.status === 'ok', 'third 确认自己的篇')
r = await handover.decideHandover(ho2.id, [docA2.id, docB2.id], 'approve', '同意交接', admin)
assert(r.status === 'ok' && r.done === 2 && !r.failures.length, '两篇均已确认，同批一次批准')

const ho2Done = await getHo(ho2.id)
assert(ho2Done.status === HANDOVER.COMPLETED && ho2Done.items.every((i) => i.completedAt), '全部篇完成 → 批次已完成')
const docA21 = await getDoc(docA2.id)
assert(docA21.ownerId === next.id, 'docA2 所有权转移给该篇接任者')
assert(docA21.ownerHistory.length === 1 && docA21.ownerHistory[0].ownerId === owner.id && docA21.ownerHistory[0].handoverId === ho2.id, 'docA2 保留原负责人历史归属')
assert(docA21.editors.includes(next.id) && !docA21.editors.includes(owner.id), 'revoke 模式：接任者加入协作、原负责人移出')
const revA1 = await db.reviews.get(revA.id)
assert(revA1.submittedBy === next.id, 'docA2 待办评审改挂该篇接任者')
assert(revA1.timeline.some((t) => t.action === 'handover'), '评审单留有交接转移痕迹')
const docB21 = await getDoc(docB2.id)
assert(docB21.ownerId === third.id && docB21.freshness.activeTicket === frB.id, 'docB2 所有权与保鲜责任一并转移')
const frB1 = await db.freshnessTickets.get(frB.id)
assert(frB1.submittedBy === third.id && frB1.timeline.some((t) => t.action === 'handover'), '流转中复核单改挂送审人并留痕')
const accP1 = await db.accessRequests.get(accPending.id)
assert(accP1.status === ACCESS.PENDING, '待审批访问申请保留（审批责任随新负责人）')
assert(canDecideAccess(accP1, docB21, third.id, third.role) === true, '接任者作为新负责人可审批该申请')
const accG1 = await db.accessRequests.get(accGrant.id)
assert(accG1.status === ACCESS.REVOKED && !isGrantActive(accG1), '原负责人的有效授权按交接决定收回')
assert(itemOf(ho2Done, docB2.id).result.accessPending === 1 && itemOf(ho2Done, docB2.id).result.revokedGrants === 1, '转移结果逐篇留档（待审批 1 项、收回授权 1 项）')
assert(itemOf(ho2Done, docA2.id).result.reviewIds.includes(revA.id), '转移结果记录改挂的评审单')
assert(ho2Done.timeline.filter((t) => t.action === 'approve').length === 2, '每篇批准均留痕')

// ---------- 5. keep 模式：保留原负责人协作权限 ----------
console.log('\n[5] keep 模式保留原负责人协作权限')
const docC = await mkDoc()
r = await handover.initiateHandover({ items: [{ docId: docC.id, toUserId: next.id }], revokeMode: REVOKE_MODE.KEEP, note: '' }, owner)
await handover.confirmHandover(r.handover.id, [docC.id], next)
r = await handover.decideHandover(r.handover.id, [docC.id], 'approve', '', admin)
assert(r.status === 'ok', 'keep 模式交接完成')
const docC1 = await getDoc(docC.id)
assert(docC1.ownerId === next.id && docC1.editors.includes(owner.id), '所有权转移但原负责人保留协作成员身份')

// ---------- 6. 并发变更：冲突篇失败回退，同批一致篇正常转移 ----------
console.log('\n[6] 交接期间并发变更 → 逐篇回退、篇间独立')
const docD = await mkDoc()
const docE = await mkDoc()
r = await handover.initiateHandover({ items: [{ docId: docD.id, toUserId: next.id }, { docId: docE.id, toUserId: next.id }], revokeMode: 'revoke', note: '' }, owner)
const ho6 = r.handover
await handover.confirmHandover(ho6.id, [docD.id, docE.id], next)
// 交接流转期间，docE 被（另一窗口）并发编辑保存
await kb.updateDoc(docE.id, { body: '<p>交接期间的并发修改</p>' }, owner, '并发编辑')
r = await handover.decideHandover(ho6.id, [docD.id, docE.id], 'approve', '', admin)
assert(r.status === 'ok' && r.done === 1 && r.failures.length === 1, '同批批准：一致篇转移、冲突篇回退')
assert(r.failures[0].docId === docE.id && r.failures[0].fields.includes('内容已更新'), '冲突篇标注「内容已更新」')
const ho6Done = await getHo(ho6.id)
assert(itemOf(ho6Done, docD.id).status === HO_ITEM.COMPLETED, '未冲突的 docD 正常转移')
assert(itemOf(ho6Done, docE.id).status === HO_ITEM.FAILED && itemOf(ho6Done, docE.id).failReason.includes('并发变更'), '冲突的 docE 标记失败回退并记录原因')
assert(ho6Done.status === HANDOVER.PARTIAL, '批次部分完成')
assert((await getDoc(docD.id)).ownerId === next.id, 'docD 所有权已转移')
const docE1 = await getDoc(docE.id)
assert(docE1.ownerId === owner.id && docE1.body.includes('并发修改'), 'docE 所有权未动、并发内容保留')

// 评审状态并发变化同样触发该篇回退
const docF = await mkDoc()
const revF = {
  id: uid('rev'), docId: docF.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: docF.title, body: docF.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
}
await db.reviews.add(revF)
await db.docs.update(docF.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: revF.id })
await kb.reloadDocs()
r = await handover.initiateHandover({ items: [{ docId: docF.id, toUserId: next.id }], revokeMode: 'keep', note: '' }, owner)
const ho7 = r.handover
await handover.confirmHandover(ho7.id, [docF.id], next)
await review.decideReview(revF.id, 'approve', '先审结', admin) // 交接期间评审被审批
r = await handover.decideHandover(ho7.id, [docF.id], 'approve', '', admin)
assert(r.status === 'ok' && r.done === 0 && r.failures[0].fields.includes('评审状态已变化'), '评审状态并发变化触发该篇回退')
assert((await getDoc(docF.id)).ownerId === owner.id, 'docF 所有权未转移')
assert((await getHo(ho7.id)).status === HANDOVER.FAILED, '唯一篇失败 → 批次已失败回退')

// ---------- 7. 驳回与取消 ----------
console.log('\n[7] 驳回与取消')
const docG = await mkDoc()
r = await handover.initiateHandover({ items: [{ docId: docG.id, toUserId: next.id }], revokeMode: 'keep', note: '' }, owner)
const ho8 = r.handover
await handover.confirmHandover(ho8.id, [docG.id], next)
r = await handover.decideHandover(ho8.id, [docG.id], 'reject', '交接范围待确认', admin)
assert(r.status === 'ok' && r.approved === false, '管理员驳回已确认篇')
assert(itemOf(await getHo(ho8.id), docG.id).status === HO_ITEM.REJECTED, '该篇已驳回')
assert((await getDoc(docG.id)).ownerId === owner.id, '驳回后所有权保持原状')

const docH = await mkDoc()
const docI = await mkDoc()
r = await handover.initiateHandover({ items: [{ docId: docH.id, toUserId: next.id }, { docId: docI.id, toUserId: third.id }], revokeMode: 'keep', note: '' }, owner)
const ho9 = r.handover
await handover.confirmHandover(ho9.id, [docH.id], next)
r = await handover.cancelHandover(ho9.id, third)
assert(r.status === 'denied', '无关成员不能取消')
r = await handover.cancelHandover(ho9.id, owner)
assert(r.status === 'ok', '发起人取消交接')
const ho9Done = await getHo(ho9.id)
assert(ho9Done.items.every((i) => i.status === HO_ITEM.CANCELLED), '待确认与已确认篇一并取消')
assert(ho9Done.status === HANDOVER.CANCELLED, '批次已取消')

// ---------- 8. 多次交接的历史归属累积 ----------
console.log('\n[8] 多次交接的历史归属累积')
// docC 已完成 owner→next；再由 next 交接给 third，历史归属累积
r = await handover.initiateHandover({ items: [{ docId: docC.id, toUserId: third.id }], revokeMode: 'revoke', note: '二次交接' }, next)
assert(r.status === 'ok', '新负责人可再次发起交接')
await handover.confirmHandover(r.handover.id, [docC.id], third)
r = await handover.decideHandover(r.handover.id, [docC.id], 'approve', '', admin)
assert(r.status === 'ok', '二次交接完成')
const docC2 = await getDoc(docC.id)
assert(docC2.ownerId === third.id, '二次交接后所有权归第三成员')
assert(docC2.ownerHistory.length === 2 && docC2.ownerHistory[0].ownerId === owner.id && docC2.ownerHistory[1].ownerId === next.id, '历任负责人全程保留（2 段任期）')
assert(!docC2.editors.includes(next.id) && docC2.editors.includes(third.id), '二次交接按 revoke 决定收回上一任权限')

// ---------- 9. 纯函数：并发校验与批次状态派生 ----------
console.log('\n[9] 并发变更校验与批次状态派生纯函数')
const snapItems = [
  { docId: 'x1', title: 'X1', snapshot: { ownerId: 'a', updatedAt: 't1', activeReviewId: null, freshnessSig: '-' } },
  { docId: 'x2', title: 'X2', snapshot: { ownerId: 'a', updatedAt: 't2', activeReviewId: 'r1', freshnessSig: '30|d|1|' } }
]
let cf = checkHandoverConflicts(snapItems, { x1: { ownerId: 'a', updatedAt: 't1' }, x2: { ownerId: 'a', updatedAt: 't2', activeReviewId: 'r1', freshness: { cycleDays: 30, nextDueAt: 'd', round: 1, activeTicket: null } } })
assert(cf.length === 0, '快照一致时无冲突')
cf = checkHandoverConflicts(snapItems, { x1: null, x2: { ownerId: 'b', updatedAt: 't2', activeReviewId: null, freshness: { cycleDays: 90, nextDueAt: 'd', round: 1, activeTicket: 'fr' } } })
assert(cf.length === 2 && cf[0].fields.includes('文档已删除'), '删除/负责人/评审/保鲜变化均被识别')
assert(cf[1].fields.includes('负责人已变更') && cf[1].fields.includes('评审状态已变化') && cf[1].fields.includes('保鲜配置已变化'), '冲突字段逐项标注')

const mk = (...ss) => ({ items: ss.map((s) => ({ status: s })) })
assert(handoverStatusOf(mk('pending_confirm', 'confirmed')) === HANDOVER.PENDING_CONFIRM, '有待确认篇 → 待接任者确认')
assert(handoverStatusOf(mk('confirmed', 'declined')) === HANDOVER.PENDING_APPROVAL, '无待确认但有已确认篇 → 待管理员批准')
assert(handoverStatusOf(mk('completed', 'completed')) === HANDOVER.COMPLETED, '全部完成 → 已完成')
assert(handoverStatusOf(mk('completed', 'declined')) === HANDOVER.PARTIAL, '完成与谢绝混合 → 部分完成')
assert(handoverStatusOf(mk('declined', 'declined')) === HANDOVER.DECLINED, '全部谢绝 → 已谢绝')
assert(handoverStatusOf(mk('failed')) === HANDOVER.FAILED, '全部失败 → 已失败回退')
assert(isHandoverOpen(mk('pending_confirm')) && isHandoverOpen(mk('confirmed')) && !isHandoverOpen(mk('completed')), '流转中判定')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
