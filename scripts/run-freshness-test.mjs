// 知识保鲜端到端回归（fake-indexeddb + 真实 store）
// 覆盖：负责人设置复核周期（权限）→ 到期自动生成复核单并暂停问答引用（响应式调度器）→
//       编辑者修订送审（复用评审锁定通道）→ 管理员批准恢复引用、重算周期、追加保鲜版本 →
//       驳回继续整改、重新送审；确认无需修订（noChange 不产生新版本）；关闭保鲜作废复核单。
// 运行：npm run test:freshness
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useReviewStore } from '@/stores/review'
import { useFreshnessStore } from '@/stores/freshness'
import { uid } from '@/utils/format'
import { FRESH, isDocCitable, calcDueAt, canManageFreshness, DAY_MS } from '@/utils/freshness'
import { REVIEW, PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const review = useReviewStore(pinia)
const freshness = useFreshnessStore(pinia)

const owner = { id: 'u-owner', role: 'editor', name: '负责人' }
const editor = { id: 'u-editor', role: 'editor', name: '编辑乙' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }
const viewer = { id: 'u-viewer', role: 'viewer', name: '只读' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '保鲜文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>原始正文 v1</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id, editor.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: { title: '', body: '<p>原始正文 v1</p>', categoryId: 'c', tagIds: [], visibility: 'public' } }],
    ...extra
  }
  d.versions[0].snapshot.title = d.title
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}

// ---------- 1. 周期设置权限 ----------
console.log('\n[1] 仅拥有者/管理员可设置复核周期')
const d1 = await mkDoc()
assert(canManageFreshness(d1, owner.id, owner.role) === true, '拥有者可设置')
assert(canManageFreshness(d1, editor.id, editor.role) === false, '非负责编辑者不可设置')
assert(canManageFreshness(d1, viewer.id, viewer.role) === false, '只读成员不可设置')
let r = await freshness.setFreshCycle(d1.id, 30, editor)
assert(r.status === 'denied', '非负责人设置被事务拒绝')
r = await freshness.setFreshCycle(d1.id, 30, owner)
assert(r.status === 'ok', '拥有者设置 30 天周期成功')
const d1After = await db.docs.get(d1.id)
assert(d1After.freshness && d1After.freshness.cycleDays === 30 && d1After.freshness.nextDueAt, 'freshness 配置与到期点已写入')
assert(isDocCitable(d1After, null, new Date()) === true, '周期内文档问答引用正常')

// 流转中有复核单时不可改周期（待第 3 步验证）

// ---------- 2. 到期自动生成复核单并暂停引用（调度器） ----------
console.log('\n[2] 周期到点自动生成复核单并暂停问答引用')
const d2 = await mkDoc({ body: '<p>密钥每 90 天轮换</p>' })
// 直接落一个即将到期（300ms）的保鲜配置，模拟负责人刚设置的短周期
await db.docs.update(d2.id, { freshness: { cycleDays: 30, nextDueAt: new Date(Date.now() + 300).toISOString(), round: 0, activeTicket: null } })
await kb.reloadDocs()
await freshness.reload()
assert(isDocCitable(await db.docs.get(d2.id), null, new Date()) === true, '到期前仍可引用')
assert(freshness.pausedCount === 0, '到期前无暂停文档')
await sleep(900)
const t2 = freshness.activeTicketOf(d2.id)
assert(!!t2 && t2.status === FRESH.OPEN, '到点自动生成 open 复核单')
assert(t2.round === 1, '首轮复核 round=1')
assert((t2.timeline || []).some((x) => x.action === 'due'), '复核单含「周期到点」自动留痕')
assert(freshness.pausedCount >= 1, '暂停引用计数 +1')
assert(isDocCitable(await db.docs.get(d2.id), t2, new Date()) === false, '到期后问答引用被暂停')
// 幂等：再次 sweep 不会为同周期重复建单
await freshness.sweepDue()
const open2 = await db.freshnessTickets.where('docId').equals(d2.id).toArray()
assert(open2.filter((x) => x.status === FRESH.OPEN).length === 1, '重复扫描不产生重复复核单')

// 流转中不可改周期
r = await freshness.setFreshCycle(d2.id, 90, owner)
assert(r.status === 'has-open', '存在流转复核单时调整周期被拒绝')

// ---------- 3. 修订送审 → 管理员批准 → 恢复引用并重算周期 ----------
console.log('\n[3] 修订送审与管理员批准')
const patch = { title: d2.title, body: '<p>密钥每 30 天轮换，并启用两步验证</p>', categoryId: 'c', tagIds: [], visibility: 'public' }
r = await freshness.submitFreshReview(d2.id, patch, '按最新基线收紧轮换周期', false, editor)
assert(r.status === 'ok', '编辑者保鲜修订送审成功')
let t2b = freshness.activeTicketOf(d2.id)
assert(t2b.status === FRESH.SUBMITTED && !!t2b.reviewId, '复核单转为送审中并关联评审单')
const d2Locked = await db.docs.get(d2.id)
assert(d2Locked.publishState === PUBLISH.IN_REVIEW, '送审后文档锁定（评审中）')
assert(isDocCitable(d2Locked, t2b, new Date()) === false, '送审期间引用继续暂停')
// 重复送审拒绝
r = await freshness.submitFreshReview(d2.id, patch, '', false, editor)
assert(r.status === 'duplicate', '已送审时重复送审被拒绝')
// 只读/访客不可送审
const d3 = await mkDoc()
r = await freshness.submitFreshReview(d3.id, {}, '', false, viewer)
assert(r.status === 'no-ticket', '无复核单返回 no-ticket')

// 非管理员不能批准
r = await review.decideReview(t2b.reviewId, 'approve', '', editor)
assert(r.status === 'denied', '非管理员批准被拒绝')

// 管理员批准
const beforeVersions = (await db.docs.get(d2.id)).versions.length
r = await review.decideReview(t2b.reviewId, 'approve', '轮换策略已对齐，通过。', admin)
assert(r.status === 'ok', '管理员复核批准成功')
const d2Approved = await db.docs.get(d2.id)
assert(d2Approved.body.includes('每 30 天轮换'), '修订正文已回写')
assert(d2Approved.publishState === PUBLISH.PUBLISHED && !d2Approved.activeReviewId, '文档解除锁定')
assert(d2Approved.versions.length === beforeVersions + 1, '追加了一个保鲜通过版本')
const newVer = d2Approved.versions[d2Approved.versions.length - 1]
assert(newVer.freshReview && newVer.freshReview.round === 1, '新版本带保鲜第 1 轮标记')
const t2Done = (await db.freshnessTickets.where('docId').equals(d2.id).toArray()).find((x) => x.id === t2.id)
assert(t2Done.status === FRESH.APPROVED, '复核单已通过')
assert(!!t2Done.nextDueAt && new Date(t2Done.nextDueAt) > new Date(), '周期已重算（下次到期在未来）')
assert(isDocCitable(d2Approved, null, new Date()) === true, '批准后问答引用恢复')
assert(freshness.activeTicketOf(d2.id) === null, '流转中复核单已清空')

// ---------- 4. 下一轮到期：驳回 → 继续整改 → 重新送审 ----------
console.log('\n[4] 第二轮到期：驳回继续整改、重新送审')
await db.docs.update(d2.id, { 'freshness.nextDueAt': new Date(Date.now() + 300).toISOString() })
await kb.reloadDocs()
await freshness.reload()
await sleep(900)
const t4 = freshness.activeTicketOf(d2.id)
assert(!!t4 && t4.round === 2, '第二轮复核单 round=2')
r = await freshness.submitFreshReview(d2.id, { ...patch, body: '<p>密钥每 30 天轮换（二次修订）</p>' }, '二次修订', false, owner)
assert(r.status === 'ok', '第二轮修订送审成功')
const t4b = freshness.activeTicketOf(d2.id)
r = await review.decideReview(t4b.reviewId, 'reject', '仍需补充离线场景说明。', admin)
assert(r.status === 'ok', '管理员驳回成功')
const t4c = freshness.activeTicketOf(d2.id)
assert(t4c.status === FRESH.REJECTED && !t4c.reviewId, '复核单回到已驳回待整改，解除评审关联')
const d2Rejected = await db.docs.get(d2.id)
assert(d2Rejected.publishState === PUBLISH.PUBLISHED, '驳回后文档解锁可继续整改')
assert(isDocCitable(d2Rejected, t4c, new Date()) === false, '驳回后问答引用仍暂停')
// 重新送审
r = await freshness.submitFreshReview(d2.id, { ...patch, body: '<p>密钥每 30 天轮换；离线场景见附录。</p>' }, '补充离线说明', false, owner)
assert(r.status === 'ok' && freshness.activeTicketOf(d2.id).status === FRESH.SUBMITTED, '整改后可在同一复核单上重新送审')
assert((freshness.activeTicketOf(d2.id).timeline || []).some((x) => x.action === 'resubmit'), '重新送审留痕 resubmit')
// 撤回送审 → 回到待整改
const rvId = freshness.activeTicketOf(d2.id).reviewId
r = await review.withdrawReview(rvId, owner)
assert(r.status === 'ok', '发起人撤回送审成功')
assert(freshness.activeTicketOf(d2.id).status === FRESH.OPEN, '撤回后复核单回到待整改')

// ---------- 5. 确认无需修订（noChange）：批准后不产生新版本 ----------
console.log('\n[5] 确认内容有效直接送复核（noChange）')
const d5 = await mkDoc({ body: '<p>稳定内容，无需修订</p>' })
await db.docs.update(d5.id, { freshness: { cycleDays: 30, nextDueAt: new Date(Date.now() + 300).toISOString(), round: 0, activeTicket: null } })
await kb.reloadDocs()
await freshness.reload()
await sleep(900)
const t5 = freshness.activeTicketOf(d5.id)
assert(!!t5, 'd5 复核单已生成')
const v5Before = (await db.docs.get(d5.id)).versions.length
r = await freshness.submitFreshReview(d5.id, {}, '内容无变化，确认有效', true, owner)
assert(r.status === 'ok', 'noChange 送审成功')
const rv5 = freshness.activeTicketOf(d5.id).reviewId
r = await review.decideReview(rv5, 'approve', '确认有效。', admin)
assert(r.status === 'ok', 'noChange 复核批准成功')
const d5After = await db.docs.get(d5.id)
assert(d5After.versions.length === v5Before, 'noChange 批准不产生新版本')
assert(d5After.body === '<p>稳定内容，无需修订</p>', '正文保持不变')
assert(isDocCitable(d5After, null, new Date()) === true, 'noChange 批准后引用恢复、周期重算')

// ---------- 6. 关闭保鲜 ----------
console.log('\n[6] 负责人关闭知识保鲜')
const d6 = await mkDoc()
await db.docs.update(d6.id, { freshness: { cycleDays: 30, nextDueAt: new Date(Date.now() + 300).toISOString(), round: 0, activeTicket: null } })
await kb.reloadDocs()
await freshness.reload()
await sleep(900)
assert(!!freshness.activeTicketOf(d6.id), 'd6 复核单已生成')
r = await freshness.disableFreshness(d6.id, editor)
assert(r.status === 'denied', '非负责人关闭被拒绝')
r = await freshness.disableFreshness(d6.id, owner)
assert(r.status === 'ok', '拥有者关闭保鲜成功')
const d6After = await db.docs.get(d6.id)
assert(!d6After.freshness, 'freshness 配置已清除')
assert(isDocCitable(d6After, null, new Date()) === true, '关闭后引用恢复')
const t6List = await db.freshnessTickets.where('docId').equals(d6.id).toArray()
assert(t6List.every((x) => x.status === FRESH.CANCELLED || x.status === FRESH.APPROVED), '复核单保留且为已取消状态')

// ---------- 7. 每轮复核与版本记录完整保留 ----------
console.log('\n[7] 每轮复核记录保留')
const d2Tickets = await db.freshnessTickets.where('docId').equals(d2.id).toArray()
assert(d2Tickets.length >= 2, 'd2 保留多轮复核单（第 1、2 轮）')
const d2Doc = await db.docs.get(d2.id)
assert(d2Doc.versions.some((v) => v.freshReview), '版本历史中保留保鲜标记版本')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
