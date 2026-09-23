// 知识缺口工单：状态常量、权限判定与文案（均为纯函数，便于复用与测试）
// 工单流转：open 待认领 → claimed 处理中 → in_review 送审中 → resolved 已解决
// 评审驳回/撤回时退回 claimed；关联文档被删除时也退回 claimed 并清空关联
// 合并认领：编辑者可把多个同类问题（open 或自己处理中的 claimed 独立工单）合并为一组，
// 组内工单各自保留 question/detail/timeline，共用一个认领人与一次文档送审；
// groupId 即组内主工单 id（主工单自身也带 groupId），旧工单无 groupId，按独立工单处理。
import { ROLE, canEditContent } from './permission'

// 工单状态
export const GAP = {
  OPEN: 'open', // 待认领：成员已提交补写需求
  CLAIMED: 'claimed', // 处理中：编辑者已认领，补写/关联文档中
  IN_REVIEW: 'in_review', // 送审中：已关联文档并发起评审，等待管理员审批
  RESOLVED: 'resolved' // 已解决：审批通过，答案来源已自动回填
}

export function gapStatusLabel(status) {
  return { open: '待认领', claimed: '处理中', in_review: '送审中', resolved: '已解决' }[status] || status
}

export function gapStatusCls(status) {
  return { open: 'st-open', claimed: 'st-claimed', in_review: 'st-review', resolved: 'st-resolved' }[status] || ''
}

// 问题归一化：去空白转小写后比较，用于同问题工单去重
export function normalizeQuestion(q) {
  return String(q || '').trim().replace(/\s+/g, '').toLowerCase()
}

// ---- 合并组 ----

// 是否已并入某个合并组（主工单自身也算组成员）
export function isInGroup(ticket) {
  return !!ticket && !!ticket.groupId
}

// 是否为组的主工单：groupId 指向自身。主工单承载组级操作（送审/解散）
export function isGroupPrimary(ticket) {
  return !!ticket && !!ticket.groupId && ticket.groupId === ticket.id
}

// 工单能否参与合并勾选：
// - 仅编辑者/管理员可操作
// - 仅 open，或「自己处理中」的 claimed 独立工单可被合并
// - 已在组内、送审中、已解决的工单不可再合并（组的生命周期锁定）
export function canMergeTicket(role, ticket, userId) {
  if (!ticket || !canEditContent(role)) return false
  if (isInGroup(ticket)) return false
  if (ticket.status === GAP.OPEN) return true
  if (ticket.status === GAP.CLAIMED) return ticket.claimedBy === userId || role === ROLE.ADMIN
  return false
}

// 在已勾选集合中，目标工单是否可与其它已选工单一起提交合并：
// 所有已选工单各自可合并，且数量 ≥ 2，且不存在完全相同的问题（重复问题创建时本就去重，兜底）
export function canCommitMerge(role, selectedTickets, userId) {
  const list = selectedTickets || []
  if (list.length < 2) return false
  if (!list.every((t) => canMergeTicket(role, t, userId))) return false
  const qs = new Set(list.map((t) => normalizeQuestion(t.question)))
  return qs.size === list.length
}

// 认领工单：编辑者/管理员，且工单处于待认领且未并入组
export function canClaimTicket(role, ticket) {
  return !!ticket && ticket.status === GAP.OPEN && !isInGroup(ticket) && canEditContent(role)
}

// 是否为工单当前处理人（认领人本人或管理员）。合并组内工单统一以组认领人为准
export function isTicketOwner(ticket, userId, role) {
  return !!ticket && (ticket.claimedBy === userId || role === ROLE.ADMIN)
}

// 取消认领：处理中、独立工单、且为处理人。组工单的「取消认领」即解散整组（见 canDissolveGroup）
export function canReleaseTicket(role, ticket, userId) {
  return !!ticket && ticket.status === GAP.CLAIMED && !isInGroup(ticket) && isTicketOwner(ticket, userId, role)
}

// 关联文档送审：独立工单与组主工单均可，需处理中且为处理人；组成员工单不单独送审
export function canSubmitGapReview(role, ticket, userId) {
  if (!ticket || ticket.status !== GAP.CLAIMED || !isTicketOwner(ticket, userId, role)) return false
  return !isInGroup(ticket) || isGroupPrimary(ticket)
}

// 把组成员移出本组（拆回独立工单）：处理中阶段、处理人操作。
// 主工单不可直接移出（解散整组用 canDissolveGroup）；送审/已解决阶段组已锁定不可拆
export function canRemoveFromGroup(role, ticket, userId) {
  return !!ticket && ticket.status === GAP.CLAIMED && isInGroup(ticket) &&
    !isGroupPrimary(ticket) && isTicketOwner(ticket, userId, role)
}

// 解散合并组：处理中阶段、组主工单的处理人；解散后成员全部退回待认领
export function canDissolveGroup(role, primary, userId) {
  return !!primary && isGroupPrimary(primary) && primary.status === GAP.CLAIMED &&
    isTicketOwner(primary, userId, role)
}

// 工单处理记录的动作文案（timeline 全程保留）
export function gapTimelineLabel(action) {
  return {
    create: '创建工单',
    claim: '认领工单',
    release: '取消认领',
    merge: '合并认领',
    unmerge: '移出合并组',
    dissolve: '解散合并组',
    submit: '关联文档送审',
    resolve: '审批通过 · 回填答案来源',
    return: '退回处理',
    reset: '关联文档已删除'
  }[action] || action
}
