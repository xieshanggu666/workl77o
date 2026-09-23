// 知识文档评审流程：状态常量、权限判定、留痕工具（均为纯函数，便于复用与测试）
import { ROLE, canEditContent, canEditDoc, isGuestUser } from './permission'

// 评审单状态
export const REVIEW = {
  PENDING: 'pending', // 待审批：编辑者已发起，成员可评论，等待管理员处理
  APPROVED: 'approved', // 已通过：待审内容已回写文档
  REJECTED: 'rejected', // 已驳回：文档保持发起前内容，可修改后重新发起
  WITHDRAWN: 'withdrawn' // 已撤回：发起人主动撤回
}

// 文档发布状态（挂在 doc.publishState 上）
export const PUBLISH = {
  PUBLISHED: 'published', // 正常
  IN_REVIEW: 'in_review' // 评审中：有 pending 评审单，正文锁定
}

// 评审单是否仍在流转中
export function isReviewOpen(review) {
  return !!review && review.status === REVIEW.PENDING
}

// 评审单是否为版本恢复评审（snapshot 为历史版本快照，restoreFrom 标记恢复来源）
export function isRestoreReview(review) {
  return !!review?.restoreFrom
}

// 评审单是否为知识保鲜复核（freshTicketId 关联当轮复核单；noChange 表示确认内容无需修订）
export function isFreshReview(review) {
  return !!review?.freshTicketId
}

// 保鲜复核是否为「确认内容有效、无需修订」直接送审（通过后不回写正文）
export function isFreshNoChangeReview(review) {
  return isFreshReview(review) && !!review.freshNoChange
}

// 文档是否处于评审中（存在待审批评审单时锁定正文）
export function isDocInReview(doc, pendingReview) {
  if (!doc) return false
  if (pendingReview) return true
  return doc.publishState === PUBLISH.IN_REVIEW
}

export function reviewStatusLabel(status) {
  return { pending: '待审批', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' }[status] || status
}

export function publishStateLabel(state) {
  return state === PUBLISH.IN_REVIEW ? '评审中' : '已发布'
}

// 发起评审资格：
// - 访客（未登录）一律不可发起；
// - 文档已有流转中评审单时不可发起；
// - 必须对该文档具备直接写入资格（拥有者/固定协作成员/管理员/持有效限时协作授权）。
//   仅凭编辑者角色与他人文档无关时不可发起（修复角色级越权）；持限时阅读授权不可发起。
// ctx: { userId, role, grant }
export function canSubmitReview(doc, ctx = {}, pendingReview) {
  if (!doc || isGuestUser(ctx.userId)) return false
  if (!canEditContent(ctx.role)) return false
  if (isDocInReview(doc, pendingReview)) return false
  return canEditDoc(doc, ctx)
}

// 撤回评审：仅发起人本人（管理员可在评审中心直接处理，不提供撤回）
export function canWithdrawReview(review, userId) {
  return isReviewOpen(review) && !isGuestUser(userId) && review.submittedBy === userId
}

// 审批（通过/驳回）：仅管理员、已登录，且评审单仍在流转中。
// 审批是评审中的唯一写入通道，联动正文回写与缺口工单结案必须先过此校验，
// 防止非管理员直接调用 store 完成「未授权内容发布 / 工单结案」。
export function canReviewDecision(role, review, userId) {
  return role === ROLE.ADMIN && !isGuestUser(userId) && isReviewOpen(review)
}

// 评审意见：任何登录成员都可以在评审单下评论；未登录访客不可
export function canCommentReview(role, review, userId) {
  return isReviewOpen(review) && !!userId && !!role && !isGuestUser(userId)
}

// 评审中是否允许直接编辑/保存正文：与 canEditDoc 的锁定段保持一致（管理员可并发修改）
export function canEditDocDuringReview(role, doc, pendingReview) {
  if (!isDocInReview(doc, pendingReview)) return true
  return role === ROLE.ADMIN
}

// 版本记录上的评审标记
export function versionReviewBadge(v) {
  if (!v || !v.reviewStatus) return null
  if (v.reviewStatus === REVIEW.APPROVED) return { text: '审批通过', cls: 'ok' }
  if (v.reviewStatus === REVIEW.REJECTED) return { text: '审批驳回', cls: 'no' }
  if (v.reviewStatus === REVIEW.PENDING) return { text: '待审批', cls: 'wait' }
  return null
}

// 版本记录上的恢复标记（可能同时存在）：
// - restore：该版本是一次恢复（恢复自 vN）
// - supersededBy：该版本的修改已被 vN 的恢复回滚（恢复边界之外的旧记录）
export function versionRestoreBadges(v) {
  const out = []
  if (v?.restore) out.push({ text: '恢复自 v' + v.restore.fromVersion, cls: 'restore' })
  if (v?.supersededBy) out.push({ text: '已被 v' + v.supersededBy.version + ' 恢复覆盖', cls: 'superseded' })
  return out
}

// 生成一条审批留痕（意见 + 操作人 + 时间），评审单的 timeline 全程保留
export function buildTimelineEntry(action, userId, note, now = new Date().toISOString()) {
  return { action, by: userId, note: note || '', at: now }
}

export function timelineActionLabel(action) {
  return {
    submit: '发起评审',
    'restore-submit': '发起恢复评审',
    'fresh-submit': '保鲜复核送审（修订）',
    'fresh-submit-nochange': '保鲜复核送审（确认无需修订）',
    comment: '发表评审意见',
    approve: '审批通过',
    reject: '审批驳回',
    withdraw: '撤回评审',
    handover: '负责人交接 · 评审待办转移'
  }[action] || action
}
