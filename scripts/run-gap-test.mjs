// 缺口工单合并认领：端到端冒烟测试（fake-indexeddb + 真实 store）
// 运行：npm run test:gap（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useGapStore } from '@/stores/gap'
import { useReviewStore } from '@/stores/review'
import { useKbStore } from '@/stores/kb'
import { GAP } from '@/utils/gap'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const gap = useGapStore(pinia)
const review = useReviewStore(pinia)
const kb = useKbStore(pinia)

const editor = { id: 'u-edit', role: 'editor', name: '编辑甲' }
const editor2 = { id: 'u-edit2', role: 'editor', name: '编辑乙' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
function isPrimary(t) { return t.groupId && t.groupId === t.id }

async function mkTicket(q, extra = {}) {
  const r = await gap.createTicket({ question: q, detail: extra.detail || '' }, extra.user || { id: 'u-m', role: 'member' })
  return r.ticket
}

// 准备一篇可送审文档
async function mkDoc(title) {
  const doc = {
    id: 'doc-' + Math.random().toString(36).slice(2, 8),
    title, body: '<p>正文</p>', categoryId: 'c-dev', tagIds: [],
    visibility: 'team', ownerId: editor.id, publishState: PUBLISH.PUBLISHED,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    versions: [{ version: 1, savedAt: new Date().toISOString(), savedBy: editor.id, note: '初始' }]
  }
  await db.docs.add(doc)
  await kb.reloadDocs()
  return doc
}

const patch = (doc) => ({ title: doc.title, body: doc.body, categoryId: doc.categoryId, tagIds: [], visibility: 'team' })

// ---------- 1. 合并认领基础链路 ----------
console.log('\n[1] 合并认领：open + open → 全组 claimed，主工单沿用最早创建')
const t1 = await mkTicket('如何导出 PDF？')
const t2 = await mkTicket('如何导出 Word？')
const t3 = await mkTicket('导出水印怎么设置？')
let r = await gap.mergeTickets([t1.id, t2.id, t3.id], editor)
assert(r.status === 'ok', '合并成功')
await gap.reload()
const m1 = await db.gapTickets.get(t1.id)
const m2 = await db.gapTickets.get(t2.id)
const m3 = await db.gapTickets.get(t3.id)
assert(m1.groupId === t1.id && m2.groupId === t1.id && m3.groupId === t1.id, 'groupId 全部指向主工单 id')
assert(m1.status === GAP.CLAIMED && m2.status === GAP.CLAIMED && m3.status === GAP.CLAIMED, '全组进入处理中')
assert(m1.claimedBy === 'u-edit' && m2.claimedBy === 'u-edit', '共用同一认领人')
assert((m2.timeline || []).some((e) => e.action === 'merge'), '成员保留各自 timeline 且追加合并留痕')
assert(m2.question === '如何导出 Word？', '成员提问原样保留')
assert(gap.groupMembers(t1.id).length === 3, 'groupMembers 返回 3 个成员')

// ---------- 2. open + 自己的 claimed 合并 ----------
console.log('\n[2] open + 自己已认领的 claimed → 主工单沿用已认领工单与认领时间')
const t4 = await mkTicket('自己的 claimed 问题')
await gap.claimTicket(t4.id, editor)
const claimedAtBefore = (await db.gapTickets.get(t4.id)).claimedAt
const t5 = await mkTicket('又一个待认领问题')
r = await gap.mergeTickets([t4.id, t5.id], editor)
assert(r.status === 'ok', '混合合并成功')
const p = await db.gapTickets.get(t4.id)
assert(p.groupId === t4.id && isPrimary(p), '已认领工单成为主工单')
assert(p.claimedAt === claimedAtBefore, '主工单保留原认领时间')

// ---------- 3. 非法合并被拒 ----------
console.log('\n[3] 非法合并：组内工单 / 他人 claimed / 不足 2 个 / 相同问题')
r = await gap.mergeTickets([t1.id, t2.id], editor)
assert(r.status === 'changed', '已在组内的工单不可再合并')
const t6 = await mkTicket('别人认领的问题')
await gap.claimTicket(t6.id, editor2)
r = await gap.mergeTickets([t6.id, t3.id], editor)
assert(r.status === 'changed', '他人处理中的工单不可被合并（非管理员）')
const onlyOne = await mkTicket('只有一张的合并')
r = await gap.mergeTickets([onlyOne.id], editor)
assert(r.status === 'too-few', '少于 2 个工单拒绝合并')
const dupBase = await mkTicket('完全相同的问题XYZ')
// createTicket 对同问题去重，这里直接造第二张同问题工单模拟历史数据
await db.gapTickets.add({
  id: 'gap-dup2', question: '完全相同的问题XYZ', detail: '', status: GAP.OPEN,
  createdBy: 'u-m', createdAt: new Date().toISOString(),
  claimedBy: null, claimedAt: null, docId: null, reviewId: null, groupId: null, resolvedAt: null,
  timeline: []
})
await gap.reload()
r = await gap.mergeTickets([dupBase.id, 'gap-dup2'], editor)
assert(r.status === 'duplicate-question', '相同问题拒绝合并')

// ---------- 4. 并发认领 vs 合并：事务重读拦截 ----------
console.log('\n[4] 并发：合并进行中他人抢先认领其中一张 → 合并整体回滚')
const c1 = await mkTicket('并发问题一')
const c2 = await mkTicket('并发问题二')
// 模拟竞争：合并事务校验前，另一会话已把 c1 认领走（无 groupId、claimedBy 变为他人）
await db.gapTickets.update(c1.id, {
  status: GAP.CLAIMED, claimedBy: 'u-edit2', claimedAt: new Date().toISOString()
})
r = await gap.mergeTickets([c1.id, c2.id], editor)
assert(r.status === 'changed', '合并检测到并发认领并回滚')
const c2fresh = await db.gapTickets.get(c2.id)
assert(!c2fresh.groupId && c2fresh.status === GAP.OPEN, '另一张工单未被污染，仍待认领')

// ---------- 5. 组内工单不可单独认领/取消认领 ----------
console.log('\n[5] 组成员的单独认领/释放被拒')
r = await gap.claimTicket(t2.id, editor2)
assert(r.status === 'grouped', '组内成员不可单独认领')
r = await gap.releaseTicket(t1.id, editor)
assert(r.status === 'grouped', '组工单不走单独取消认领')

// ---------- 6. 移出成员 / 自动解散 ----------
console.log('\n[6] 移出成员：保留认领拆为独立；剩 1 人时自动解散')
r = await gap.removeFromGroup(t3.id, editor)
assert(r.status === 'ok', '成员移出成功')
const t3fresh = await db.gapTickets.get(t3.id)
assert(!t3fresh.groupId && t3fresh.status === GAP.CLAIMED && t3fresh.claimedBy === 'u-edit', '移出后仍为自己处理中的独立工单')
assert(gap.groupMembers(t1.id).length === 2, '组内剩余 2 人')
await gap.removeFromGroup(t2.id, editor)
const t1fresh = await db.gapTickets.get(t1.id)
assert(!t1fresh.groupId, '仅剩主工单时自动解散，主工单 groupId 清空')
assert(t1fresh.status === GAP.CLAIMED && t1fresh.claimedBy === 'u-edit', '自动解散后主工单仍保留认领继续处理')

// ---------- 7. 解散整组 ----------
console.log('\n[7] 解散合并组：全部退回待认领')
const d1 = await mkTicket('解散问题一')
const d2 = await mkTicket('解散问题二')
await gap.mergeTickets([d1.id, d2.id], editor)
r = await gap.dissolveGroup(d1.id, editor)
assert(r.status === 'ok', '解散成功')
for (const id of [d1.id, d2.id]) {
  const x = await db.gapTickets.get(id)
  assert(!x.groupId && x.status === GAP.OPEN && !x.claimedBy, id + ' 退回待认领且清空 groupId')
  assert((x.timeline || []).some((e) => e.action === 'dissolve'), id + ' 保留解散留痕')
}
const d3 = await mkTicket('权限问题一')
const d4 = await mkTicket('权限问题二')
await gap.mergeTickets([d3.id, d4.id], editor)
r = await gap.dissolveGroup(d3.id, editor2)
assert(r.status === 'denied', '非处理人不能解散他人的组')

// ---------- 8. 组合并送审 → 审批通过全组解决 ----------
console.log('\n[8] 合并送审：共用一次评审；通过后全组 resolved + 回填同一文档')
const g1 = await mkTicket('送审问题一')
const g2 = await mkTicket('送审问题二')
await gap.mergeTickets([g1.id, g2.id], editor)
const doc = await mkDoc('导出操作手册')
r = await review.submitGapReview(g1.id, doc.id, patch(doc), '补写合并组', editor)
assert(r.status === 'ok', '合并送审成功（单评审单）')
const rev = r.review
const reviewsForDoc = await db.reviews.where('docId').equals(doc.id).toArray()
assert(reviewsForDoc.length === 1, '只创建了一个评审单')
for (const id of [g1.id, g2.id]) {
  const x = await db.gapTickets.get(id)
  assert(x.status === GAP.IN_REVIEW && x.reviewId === rev.id && x.docId === doc.id, id + ' 关联同一评审单与文档')
}
r = await review.submitGapReview(g2.id, doc.id, patch(doc), '', editor)
assert(r.status === 'ticket-changed', '组成员工单不能单独发起送审')
r = await review.decideReview(rev.id, 'approve', '覆盖到位', admin)
assert(r.status === 'ok', '审批通过')
for (const id of [g1.id, g2.id]) {
  const x = await db.gapTickets.get(id)
  assert(x.status === GAP.RESOLVED && x.docId === doc.id && !!x.resolvedAt, id + ' 已解决并回填答案来源')
  assert(!!x.groupId, id + ' 解决后仍保留合并组关系')
}

// ---------- 9. 驳回全组退回，组关系与文档保留 ----------
console.log('\n[9] 合并送审被驳回：全组退回处理中，保留组与文档关联')
const k1 = await mkTicket('驳回问题一')
const k2 = await mkTicket('驳回问题二')
await gap.mergeTickets([k1.id, k2.id], editor)
const doc2 = await mkDoc('被驳回的手册')
r = await review.submitGapReview(k1.id, doc2.id, patch(doc2), '', editor)
assert(r.status === 'ok', '第二组送审成功')
await review.decideReview(r.review.id, 'reject', '内容不全', admin)
for (const id of [k1.id, k2.id]) {
  const x = await db.gapTickets.get(id)
  assert(x.status === GAP.CLAIMED && !x.reviewId, id + ' 退回处理中并解除评审单关联')
  assert(x.groupId === k1.id && x.docId === doc2.id, id + ' 保留组关系与文档，便于修改后重新送审')
}

// ---------- 10. 送审中撤回 → 全组退回 ----------
console.log('\n[10] 送审中发起人撤回：全组退回处理中')
const w1 = await mkTicket('撤回问题一')
const w2 = await mkTicket('撤回问题二')
await gap.mergeTickets([w1.id, w2.id], editor)
const doc3 = await mkDoc('撤回的手册')
r = await review.submitGapReview(w1.id, doc3.id, patch(doc3), '', editor)
await review.withdrawReview(r.review.id, editor)
for (const id of [w1.id, w2.id]) {
  const x = await db.gapTickets.get(id)
  assert(x.status === GAP.CLAIMED && !x.reviewId && x.groupId === w1.id, id + ' 撤回后退回处理中且仍在组内')
}

// ---------- 11. 送审中文档删除 → 全组退回并清空关联 ----------
console.log('\n[11] 关联文档删除：全组退回处理中，docId/reviewId 清空，组关系保留')
const z1 = await mkTicket('删文档问题一')
const z2 = await mkTicket('删文档问题二')
await gap.mergeTickets([z1.id, z2.id], editor)
const doc4 = await mkDoc('会被删除的手册')
r = await review.submitGapReview(z1.id, doc4.id, patch(doc4), '', editor)
await kb.deleteDoc(doc4.id, admin)
for (const id of [z1.id, z2.id]) {
  const x = await db.gapTickets.get(id)
  assert(x.status === GAP.CLAIMED && !x.docId && !x.reviewId, id + ' 文档删除后退回并清空关联')
  assert(x.groupId === z1.id, id + ' 仍保留合并组关系')
}

// ---------- 12. 旧工单兼容（无 groupId 字段）----------
console.log('\n[12] 旧工单兼容：无 groupId 的存量工单按独立工单流转')
await db.gapTickets.add({
  id: 'gap-old', question: '老版本工单', detail: '', status: GAP.OPEN,
  createdBy: 'u-m', createdAt: new Date().toISOString(),
  claimedBy: null, claimedAt: null, docId: null, reviewId: null, resolvedAt: null,
  timeline: [{ action: 'create', by: 'u-m', at: new Date().toISOString(), note: '' }]
})
await gap.reload()
r = await gap.claimTicket('gap-old', editor)
assert(r.status === 'ok', '旧工单可正常认领')
const oldFresh = await db.gapTickets.get('gap-old')
assert(!oldFresh.groupId, '旧工单认领后保持独立（groupId 为空）')

// ---------- 13. 问答页回填去重 ----------
console.log('\n[13] resolvedTicketsMatching 对同文档合并组去重')
await gap.reload()
const hits = gap.resolvedTicketsMatching(['送审问题'])
const docIds = hits.map((t) => t.docId)
assert(docIds.length > 0 && new Set(docIds).size === docIds.length, '同一答案来源不重复出现')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
