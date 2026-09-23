// 文档编辑/评审权限统一校验：端到端安全回归（fake-indexeddb + 真实 store）
// 覆盖：访客写入、共享链接（只读/可编辑/撤销/过期/评审锁定）、限时协作授权（有效/撤销/到期）、
//       编辑者角色越权、管理员边界、送审/恢复送审/缺口送审身份校验、
//       审批管理员校验与工单联动结案、评论/删除/新建/认领边界。
// 运行：npm run test:perm（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useReviewStore } from '@/stores/review'
import { useGapStore } from '@/stores/gap'
import { useAccessStore } from '@/stores/access'
import { uid, makeToken } from '@/utils/format'
import { ACCESS, ACCESS_PERM } from '@/utils/access'
import { REVIEW, PUBLISH } from '@/utils/review'
import { GAP } from '@/utils/gap'
import { shareStatus } from '@/utils/share'
import {
  canEditDoc, canDeleteDoc, canViewDoc, GUEST_ID, ROLE
} from '@/utils/permission'
import {
  canSubmitReview, canReviewDecision, canCommentReview, canWithdrawReview
} from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const review = useReviewStore(pinia)
const gap = useGapStore(pinia)
const access = useAccessStore(pinia)

const guest = null
const viewer = { id: 'u-view', role: ROLE.VIEWER, name: '只读甲' }
const editor = { id: 'u-edit', role: ROLE.EDITOR, name: '编辑甲' }
const editor2 = { id: 'u-edit2', role: ROLE.EDITOR, name: '编辑乙' }
const admin = { id: 'u-admin', role: ROLE.ADMIN, name: '管理员' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

const now = new Date().toISOString()
async function mkDoc(owner = editor, extra = {}) {
  const d = {
    id: uid('doc'), title: '文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>正文</p>', categoryId: 'c', tagIds: [], visibility: 'private',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: now, updatedAt: now,
    versions: [{ version: 1, savedAt: now, savedBy: owner.id, note: '初始' }],
    ...extra
  }
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}

async function mkShare(docId, permission, extra = {}) {
  const s = {
    id: uid('sh'), docId, token: makeToken(), permission,
    createdBy: 'u-owner', createdAt: now, expiresAt: null, revokedAt: null, ...extra
  }
  await db.shares.add(s)
  return s
}

async function mkGrant(docId, applicant, permission, { revoked = false, expired = false } = {}) {
  const expiresAt = expired
    ? new Date(Date.now() - 86400000).toISOString()
    : new Date(Date.now() + 7 * 86400000).toISOString()
  const req = {
    id: uid('acc'), docId, applicantId: applicant.id, status: ACCESS.APPROVED,
    requestedPermission: permission, reason: '', createdAt: now,
    decidedBy: 'u-admin', decidedAt: now, decisionNote: '',
    expiresAt, revokedAt: revoked ? now : null,
    grant: { permission, grantedAt: now, expiresAt, revokedAt: revoked ? now : null },
    timeline: []
  }
  await db.accessRequests.add(req)
  await access.reload()
  return req
}

const patch = (d) => ({ title: d.title, body: '<p>新正文</p>', categoryId: d.categoryId, tagIds: [], visibility: d.visibility })

// ---------- 0. 可见性：team 文档必须登录，访客仅能看 public / 凭有效共享链接 ----------
console.log('\n[0] team 可见性的登录身份校验（侧边栏/搜索/详情/问答统一入口）')
const dPub = await mkDoc(admin, { visibility: 'public' })
const dTeam = await mkDoc(admin, { visibility: 'team' })
const dTeam2 = await mkDoc(admin, { visibility: 'team' })
const dTeamShare = await mkShare(dTeam2.id, 'view')
const dTeamShareRevoked = await mkShare(dTeam2.id, 'view', { revokedAt: now, token: makeToken() })
assert(canViewDoc(dPub, null) === true, '公开文档：访客可见')
assert(canViewDoc(dPub, viewer.id) === true, '公开文档：登录成员可见')
assert(canViewDoc(dTeam, null) === false, '团队文档：未登录访客不可见（修复越权泄露）')
assert(canViewDoc(dTeam, GUEST_ID) === false, '团队文档：GUEST_ID 访客不可见')
assert(canViewDoc(dTeam, viewer.id) === true, '团队文档：登录只读成员可见')
assert(canViewDoc(dTeam, admin.id) === true, '团队文档：管理员可见')
assert(canViewDoc(dTeam2, null, dTeamShare) === true, '团队文档：访客持有效共享链接可看')
assert(canViewDoc(dTeam2, null, dTeamShareRevoked) === false, '团队文档：访客持已撤销链接不可看')
assert(canViewDoc(dTeam, viewer.id, null, null) === true, '团队文档可见性不依赖授权记录')

// ---------- 1. 访客：无任何凭证不可写 ----------
console.log('\n[1] 访客写入边界：无链接 / 只读链接 / 他人文档')
const d1 = await mkDoc()
assert(canEditDoc(d1, { userId: GUEST_ID }) === false, '纯函数：访客无凭证不可写')
let r = await kb.updateDoc(d1.id, { body: 'x' }, guest)
assert(r.status === 'guest', 'store：未登录直接保存被拒（guest），正文未写')
assert((await db.docs.get(d1.id)).body === '<p>正文</p>', '被拒保存不改动正文')
const viewShare = await mkShare(d1.id, 'view')
r = await kb.updateDoc(d1.id, { body: 'x' }, guest, '', { shareToken: viewShare.token })
assert(r.status === 'guest', '只读共享链接不授予写权限')

// ---------- 2. 访客：可编辑共享链接 ----------
console.log('\n[2] 访客持有效可编辑链接可写；撤销/过期后立即收回')
const d2 = await mkDoc()
const editShare = await mkShare(d2.id, 'edit')
assert(canEditDoc(d2, { userId: GUEST_ID, share: editShare }) === true, '纯函数：访客+有效 edit 链接可写')
r = await kb.updateDoc(d2.id, { body: '<p>访客改</p>' }, guest, '共享编辑', { shareToken: editShare.token })
assert(r.status === 'saved', 'store：访客凭 edit 链接保存成功')
assert((await db.docs.get(d2.id)).body === '<p>访客改</p>', '访客编辑已落库')

// 伪造 token / 他人文档 token 不可用
r = await kb.updateDoc(d2.id, { body: 'y' }, guest, '', { shareToken: makeToken() })
assert(r.status === 'guest', '伪造 token 被拒')
const otherDoc = await mkDoc()
r = await kb.updateDoc(otherDoc.id, { body: 'y' }, guest, '', { shareToken: editShare.token })
assert(r.status === 'guest', 'A 文档的链接不能用于写 B 文档')

await db.shares.update(editShare.id, { revokedAt: now })
r = await kb.updateDoc(d2.id, { body: 'z' }, guest, '', { shareToken: editShare.token })
assert(r.status === 'guest', '链接撤销后保存立即被拒')
const expiredShare = await mkShare(otherDoc.id, 'edit', { expiresAt: new Date(Date.now() - 1000).toISOString() })
assert(shareStatus(expiredShare) === 'expired', '过期链接状态为 expired')
r = await kb.updateDoc(otherDoc.id, { body: 'z' }, guest, '', { shareToken: expiredShare.token })
assert(r.status === 'guest', '过期链接不再授予写权限')

// ---------- 3. 评审锁定：协作者/访客/链接一律锁；管理员可并发写 ----------
console.log('\n[3] 评审锁定边界')
const d3 = await mkDoc(editor2)
const lockShare = await mkShare(d3.id, 'edit')
r = await review.submitReview(d3.id, patch(d3), '送审', editor2)
assert(r.status === 'ok', '编辑乙对自己的文档发起评审成功')
const locked = await db.docs.get(d3.id)
assert(locked.publishState === PUBLISH.IN_REVIEW && locked.body === '<p>正文</p>', '文档锁定且旧正文保持可见')

assert(canEditDoc(locked, { userId: editor2.id, role: ROLE.EDITOR }) === false, '发起人评审中不能直接改')
assert(canEditDoc(locked, { userId: GUEST_ID, share: lockShare }) === false, '访客链接在评审中同样锁定')
assert(canEditDoc(locked, { userId: admin.id, role: ROLE.ADMIN }) === true, '管理员评审中可并发修改')
r = await kb.updateDoc(d3.id, { body: '<p>锁中直写</p>' }, editor2)
assert(r.status === 'review-locked', '编辑者锁定期保存被拒')
r = await kb.updateDoc(d3.id, { body: '<p>锁中链接写</p>' }, guest, '', { shareToken: lockShare.token })
assert(r.status === 'review-locked', '共享链接锁定期保存被拒（库内 pending 复核）')
r = await kb.updateDoc(d3.id, { body: '<p>管理员并发</p>' }, admin, '管理员并发修改')
assert(r.status === 'saved', '管理员锁定期可直接保存（审批是独立写入通道）')
assert((await db.docs.get(d3.id)).versions.length === 2, '管理员并发修改记录为新版本')

// ---------- 4. 角色不越权：编辑者不能写/删/送审他人私有文档 ----------
console.log('\n[4] 编辑者角色不等于任意文档写入权')
const d4 = await mkDoc(editor2)
assert(canEditDoc(d4, { userId: editor.id, role: ROLE.EDITOR }) === false, '编辑甲不能写编辑乙的私有文档')
assert(canDeleteDoc(d4, { userId: editor.id, role: ROLE.EDITOR }) === false, '编辑甲不能删除编辑乙的文档')
assert(canSubmitReview(d4, { userId: editor.id, role: ROLE.EDITOR }) === false, '编辑甲不能对乙的文档发起评审')
assert(canEditDoc(d4, { userId: admin.id, role: ROLE.ADMIN }) === true, '管理员可治理任意文档')
r = await kb.updateDoc(d4.id, { body: '越权' }, editor)
assert(r.status === 'access-denied', 'store：编辑甲直接保存乙私有文档被拒')
r = await kb.deleteDoc(d4.id, editor)
assert(r.status === 'forbidden', 'store：编辑甲删除乙文档被拒')
r = await review.submitReview(d4.id, patch(d4), '', editor)
assert(r.status === 'denied', 'store：编辑甲对乙文档发起评审被拒')
assert((await db.docs.get(d4.id)).body === '<p>正文</p>', '越权操作未改动文档')

// ---------- 5. 限时协作授权：有效期内可写可删；撤销/到期即时收回 ----------
console.log('\n[5] 限时协作授权边界（只读角色协作）')
const d5 = await mkDoc(editor2)
const g = await mkGrant(d5.id, viewer, ACCESS_PERM.COLLAB)
assert(canViewDoc(d5, viewer.id, null, g), '有效授权可读')
assert(canEditDoc(d5, { userId: viewer.id, role: ROLE.VIEWER, grant: g }), '持协作授权的只读成员可编辑')
assert(canSubmitReview(d5, { userId: viewer.id, role: ROLE.VIEWER, grant: g }) === false, '协作授权不授予评审发起权')
r = await kb.updateDoc(d5.id, { body: '<p>授权协作</p>' }, viewer)
assert(r.status === 'saved', '有效期内协作者保存成功')
r = await review.submitReview(d5.id, patch(d5), '', viewer)
assert(r.status === 'denied', '只读成员不能发起评审（即使持协作授权）')

await access.revokeGrant(g.id, '收回', editor2)
await access.reload()
const revokedReq = await db.accessRequests.get(g.id)
assert(canEditDoc(await db.docs.get(d5.id), { userId: viewer.id, role: ROLE.VIEWER, grant: revokedReq }) === false, '撤销后立即失去编辑资格')
r = await kb.updateDoc(d5.id, { body: 'x' }, viewer)
assert(r.status === 'access-denied', '撤销后保存被拒')

const g2 = await mkGrant(d5.id, viewer, ACCESS_PERM.COLLAB, { expired: true })
assert(canViewDoc(d5, viewer.id, null, g2) === false, '到期授权不可读（私有文档）')
r = await kb.updateDoc(d5.id, { body: 'x' }, viewer)
assert(r.status === 'access-denied', '到期授权保存被拒')
const readGrant = await mkGrant(d5.id, { id: 'u-view2', role: ROLE.VIEWER }, ACCESS_PERM.READ)
assert(canViewDoc(d5, 'u-view2', null, readGrant) === true, '阅读授权可读')
assert(canEditDoc(d5, { userId: 'u-view2', role: ROLE.VIEWER, grant: readGrant }) === false, '阅读授权不可编辑')

// ---------- 6. 审批：仅管理员；非管理员不能发布待审内容或联动工单 ----------
console.log('\n[6] 审批管理员边界 + 缺口工单联动')
const pendingRev = (await db.reviews.where('docId').equals(d3.id).filter((x) => x.status === REVIEW.PENDING).first())
assert(canReviewDecision(ROLE.EDITOR, pendingRev, editor2.id) === false, '纯函数：编辑者不能审批')
assert(canReviewDecision(ROLE.ADMIN, pendingRev, admin.id) === true, '纯函数：管理员可审批')
assert(canReviewDecision(ROLE.ADMIN, pendingRev, GUEST_ID) === false, '访客即便伪装 admin 角色也不可审批')

r = await review.decideReview(pendingRev.id, 'approve', '', editor2)
assert(r.status === 'denied', 'store：编辑者直接调用审批被拒')
assert((await db.docs.get(d3.id)).publishState === PUBLISH.IN_REVIEW, '越权审批未发布内容')
r = await review.decideReview(pendingRev.id, 'approve', '', guest)
assert(r.status === 'guest', 'store：访客审批被拒')

// 缺口工单联动：送审 → 非管理员审批不得结案
const tk = await gap.createTicket({ question: '权限联动问题' }, viewer)
await gap.claimTicket(tk.ticket.id, editor)
const d6 = await mkDoc(editor)
r = await review.submitGapReview(tk.ticket.id, d6.id, patch(d6), '', editor)
assert(r.status === 'ok', '认领人关联送审成功')
const tkRev = r.review
let t = await db.gapTickets.get(tk.ticket.id)
assert(t.status === GAP.IN_REVIEW && t.reviewId === tkRev.id, '工单进入送审中并关联评审单')
r = await review.decideReview(tkRev.id, 'approve', '', editor)
assert(r.status === 'denied', '非管理员不能审批缺口送审')
t = await db.gapTickets.get(tk.ticket.id)
assert(t.status === GAP.IN_REVIEW, '越权审批未联动结案，工单仍送审中')
r = await review.decideReview(tkRev.id, 'approve', '通过', admin)
assert(r.status === 'ok' && r.approved, '管理员审批通过')
t = await db.gapTickets.get(tk.ticket.id)
assert(t.status === GAP.RESOLVED && !!t.resolvedAt, '审批通过后同事务联动工单结案并回填')
const published6 = await db.docs.get(d6.id)
assert(published6.publishState === PUBLISH.PUBLISHED && published6.body === '<p>新正文</p>', '待审内容仅在管理员审批后发布')

// 驳回联动：工单退回处理中
const tk2 = await gap.createTicket({ question: '驳回联动问题' }, viewer)
await gap.claimTicket(tk2.ticket.id, editor)
const d7 = await mkDoc(editor)
r = await review.submitGapReview(tk2.ticket.id, d7.id, patch(d7), '', editor)
assert(r.status === 'ok', '新工单关联新文档送审成功')
await review.decideReview(r.review.id, 'reject', '内容不足', admin)
t = await db.gapTickets.get(tk2.ticket.id)
assert(t.status === GAP.CLAIMED && !t.reviewId, '驳回后同事务退回处理中')

// ---------- 7. 撤回 / 评论身份边界 ----------
console.log('\n[7] 撤回与评审意见身份边界')
const d8 = await mkDoc(editor)
r = await review.submitReview(d8.id, patch(d8), '', editor)
assert(r.status === 'ok', '发起第三篇评审')
const rv8 = r.review
r = await review.withdrawReview(rv8.id, editor2)
assert(r.status === 'denied', '非发起人不能撤回')
r = await review.withdrawReview(rv8.id, guest)
assert(r.status === 'guest', '访客不能撤回')
r = await review.withdrawReview(rv8.id, editor)
assert(r.status === 'ok', '发起人可撤回')
assert((await db.docs.get(d8.id)).publishState === PUBLISH.PUBLISHED, '撤回后文档解锁')

const d9 = await mkDoc(editor)
r = await review.submitReview(d9.id, patch(d9), '', editor)
const rv9 = r.review
const cmt = await review.addReviewComment(rv9.id, '意见', [], viewer)
assert(cmt && cmt.id, '登录成员（含只读）可发表评审意见')
assert(canCommentReview(ROLE.VIEWER, rv9, viewer.id) === true, '纯函数：只读成员可评论')
const gCmt = await review.addReviewComment(rv9.id, '访客意见', [], guest)
assert(gCmt?.status === 'guest', '访客评论被拒')
const commentsCount = await db.comments.where('reviewId').equals(rv9.id).count()
assert(commentsCount === 1, '访客意见未写入（仍只有登录成员的一条）')
assert(canWithdrawReview(rv9, viewer.id) === false, '评论人不是发起人不能撤回')

// ---------- 8. 新建/删除/认领/合并/工单创建的入口校验 ----------
console.log('\n[8] 其余写入口边界')
r = await kb.createDoc({ title: '访客文档', body: '' }, guest)
assert(r.status === 'forbidden', '访客不能新建文档')
r = await kb.createDoc({ title: '只读文档', body: '' }, viewer)
assert(r.status === 'forbidden', '只读角色不能新建文档（路由之外 store 兜底）')
const d10 = await mkDoc(editor2)
r = await kb.deleteDoc(d10.id, guest)
assert(r.status === 'forbidden', '访客不能删除文档（共享链接也不行）')
const delShare = await mkShare(d10.id, 'edit')
r = await kb.deleteDoc(d10.id, guest)
assert(r.status === 'forbidden', '即便持有 edit 链接，访客也不能删除文档')
// 限时协作授权可编辑但不能删除（破坏性操作）
const dg = await mkDoc(editor2)
await mkGrant(dg.id, viewer, ACCESS_PERM.COLLAB)
r = await kb.deleteDoc(dg.id, viewer)
assert(r.status === 'forbidden', '持限时协作授权的只读成员不能删除文档')
r = await kb.updateDoc(dg.id, { body: 'x' }, viewer)
assert(r.status === 'saved', '但同一协作授权仍可编辑正文')

const tkA = await gap.createTicket({ question: '认领边界问题' }, viewer)
r = await gap.claimTicket(tkA.ticket.id, guest)
assert(r.status === 'denied', '访客不能认领工单')
r = await gap.claimTicket(tkA.ticket.id, viewer)
assert(r.status === 'denied', '只读角色不能认领工单')
r = await gap.claimTicket(tkA.ticket.id, editor)
assert(r.status === 'ok', '编辑者可认领')
const tkB = await gap.createTicket({ question: '合并边界问题二' }, viewer)
r = await gap.mergeTickets([tkA.ticket.id, tkB.ticket.id], guest)
assert(r.status === 'denied', '访客不能合并认领')
r = await gap.mergeTickets([tkA.ticket.id, tkB.ticket.id], viewer)
assert(r.status === 'denied', '只读角色不能合并认领')
const tkC = await gap.createTicket({ question: '访客建工单问题' }, viewer)
r = await gap.createTicket({ question: tkC.ticket.question }, guest)
assert(r.status === 'guest', '访客不能创建缺口工单')

// ---------- 9. 恢复评审同样走统一资格 ----------
console.log('\n[9] 恢复评审权限边界')
const d11 = await kb.createDoc({ title: '恢复测试', body: 'v1', categoryId: 'c', tagIds: [], visibility: 'private' }, editor)
await kb.updateDoc(d11.id, { ...d11, body: 'v2', versions: undefined }, editor, '编辑')
const d11f = await db.docs.get(d11.id)
r = await review.submitRestoreReview(d11.id, 1, '', editor2)
assert(['denied', 'no-snapshot'].includes(r.status), '非协作者编辑者不能对他人文档发起恢复评审')
r = await review.submitRestoreReview(d11.id, 1, '', guest)
assert(r.status === 'guest', '访客不能发起恢复评审')
const g3 = await mkGrant(d11.id, viewer, ACCESS_PERM.COLLAB)
r = await review.submitRestoreReview(d11.id, 1, '', viewer)
assert(r.status === 'denied', '持协作授权的只读成员不能发起恢复评审')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
