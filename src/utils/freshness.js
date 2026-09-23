// 知识保鲜：复核周期、复核单状态、权限判定、到期/引用判定与留痕工具（均为纯函数，便于测试）
// 流转：负责人（拥有者/管理员）设置复核周期（或管理员按分类批量设置策略，文档可单独覆盖）→
// 到期自动生成复核单（open，暂停问答引用）→ 编辑者修订送审（submitted，复用评审单锁定/审批通道）→
// 管理员批准（approved，恢复引用并按当前规则重算周期）/ 驳回（rejected，继续整改，可修订后重新送审）；
// 每轮复核单与 timeline 全程保留；在途复核单持有规则快照，分类策略调整不影响当轮。
import { ROLE } from './permission'

// 复核单状态（每轮一条：驳回不是终态，修订后在同一条复核单上重新送审；approved 为本轮已通过）
export const FRESH = {
  OPEN: 'open', // 待整改：周期到点已生成复核单，问答引用暂停
  SUBMITTED: 'submitted', // 复核送审中：编辑者已修订送审，等待管理员批准
  REJECTED: 'rejected', // 已驳回：管理员驳回，继续整改后重新送审（引用仍暂停）
  APPROVED: 'approved', // 已通过：内容确认有效/已修订，恢复引用并重算周期
  CANCELLED: 'cancelled' // 已取消：负责人关闭保鲜，当前复核单作废（记录保留）
}

// 保鲜配置来源（doc.freshness.source / freshnessTickets.ruleSource）
export const RULE_SOURCE = {
  POLICY: 'policy', // 继承分类复核策略（策略调整时随批量重算）
  DOC: 'doc' // 文档单独设置（覆盖分类策略，不随批量重算）
}

export const DAY_MS = 24 * 3600 * 1000

// 可选复核周期（天）
export const FRESH_CYCLES = [
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天（季度）' },
  { days: 180, label: '180 天（半年）' },
  { days: 365, label: '365 天（年度）' }
]

export function cycleDaysLabel(days) {
  const hit = FRESH_CYCLES.find((c) => c.days === days)
  if (hit) return hit.label
  return days ? days + ' 天' : '未设置'
}

export function freshStatusLabel(status) {
  return { open: '待整改', submitted: '复核送审中', rejected: '已驳回待整改', approved: '已通过', cancelled: '已取消' }[status] || status
}

export function freshStatusCls(status) {
  return { open: 'st-open', submitted: 'st-review', rejected: 'st-no', approved: 'st-ok', cancelled: 'st-off' }[status] || ''
}

// 计算下一次复核到期点：基准时间（批准/设置时刻）+ 周期天数
export function calcDueAt(days, from) {
  const n = Number(days)
  if (!n || n <= 0) return null
  return new Date(new Date(from).getTime() + n * DAY_MS).toISOString()
}

// 文档级覆盖判定：显式继承分类策略（source==='policy'）之外的保鲜配置都视为文档级覆盖；
// 历史数据无 source 字段（v9 迁移前）按覆盖处理，策略批量重算不会误伤既有逐篇配置
export function isDocOverride(freshness) {
  return !!freshness && freshness.source !== RULE_SOURCE.POLICY
}

// 由分类策略物化一份继承配置（写到 doc.freshness）：保留历史轮次与最近通过记录，
// 到期点自当前时刻按策略周期重算；prev 为文档既有 freshness（无则全新继承）
export function materializeFromPolicy(policy, prev, nowIso = new Date().toISOString()) {
  const base = prev || {}
  return {
    ...base,
    cycleDays: Number(policy.cycleDays),
    nextDueAt: calcDueAt(policy.cycleDays, nowIso),
    round: base.round || 0,
    activeTicket: null,
    source: RULE_SOURCE.POLICY,
    policyId: policy.id,
    updatedAt: nowIso
  }
}

// 配置来源文案（继承分类策略 / 文档单独设置；历史数据无 source 视为文档级）
export function ruleSourceLabel(source) {
  return source === RULE_SOURCE.POLICY ? '继承分类策略' : '文档单独设置'
}

// 分类复核策略为平台级治理配置：仅管理员可设置/调整/关闭
export function canManagePolicy(role) {
  return role === ROLE.ADMIN
}

// 文档是否启用了知识保鲜（设置了有效周期）
export function isFreshnessEnabled(doc) {
  return !!doc?.freshness && Number(doc.freshness.cycleDays) > 0
}

// 当前流转中的复核单（open/submitted/rejected 均会暂停问答引用；approved/cancelled 为本轮终态）
export function isFreshTicketOpen(ticket) {
  return !!ticket && (ticket.status === FRESH.OPEN || ticket.status === FRESH.SUBMITTED || ticket.status === FRESH.REJECTED)
}

// 复核周期是否已到点（启用且 nextDueAt <= at）
export function isFreshDue(doc, at = new Date()) {
  if (!isFreshnessEnabled(doc) || !doc.freshness.nextDueAt) return false
  return new Date(doc.freshness.nextDueAt).getTime() <= new Date(at).getTime()
}

// 是否已有流转中的复核单（到期生成前判重，保证一个周期一张单）
export function hasOpenFreshTicket(doc, activeTicket) {
  const t = activeTicket ?? doc?.freshness?.activeTicket
  return isFreshTicketOpen(t)
}

// 是否可被问答引用（核心保鲜闸门）：
// 启用保鲜且「周期已到点」或「存在流转中复核单」时一律暂停引用；
// 未启用保鲜、或本轮已通过（周期已重算）的文档正常引用。
// 暂停只影响问答引用：文档详情、搜索、侧边栏入口仍可正常访问。
export function isDocCitable(doc, activeTicket, at = new Date()) {
  if (!doc) return false
  if (!isFreshnessEnabled(doc)) return true
  if (isFreshTicketOpen(activeTicket ?? doc?.freshness?.activeTicket)) return false
  if (isFreshDue(doc, at)) return false
  return true
}

// 设置/调整复核周期资格：仅文档拥有者或管理员（负责人）。
// 编辑者/只读成员、限时协作者、访客均不能设置他人文档的保鲜周期。
export function canManageFreshness(doc, userId, role) {
  if (!doc || !userId || userId === 'u-guest') return false
  if (role === ROLE.ADMIN) return true
  return doc.ownerId === userId
}

// 关闭保鲜时是否允许同时作废当前复核单（仅负责人；存在流转中复核单时需要确认）
export function canDisableFreshness(doc, userId, role) {
  return canManageFreshness(doc, userId, role)
}

// 保鲜复核单的审批（通过/驳回）复用内容评审的管理员通道，见 utils/review.canReviewDecision

// 保鲜复核留痕：动作 + 操作人 + 说明 + 时间，复核单 timeline 全程保留
export function buildFreshTimelineEntry(action, userId, note, now = new Date().toISOString()) {
  return { action, by: userId, note: note || '', at: now }
}

export function freshTimelineLabel(action) {
  return {
    due: '周期到点 · 自动生成复核单',
    submit: '修订内容送审',
    'submit-nochange': '确认内容无需修订 · 直接送审',
    approve: '复核通过 · 恢复引用并重算周期',
    reject: '复核驳回 · 继续整改',
    resubmit: '修订后重新送审',
    withdraw: '撤回复核送审 · 继续整改',
    setting: '设置复核周期',
    change: '调整复核周期',
    disable: '关闭知识保鲜',
    cancel: '作废复核单',
    'reset-policy': '恢复跟随分类策略',
    'policy-setting': '设置分类复核策略',
    'policy-change': '调整分类复核策略 · 重算到期计划',
    'policy-disable': '关闭分类复核策略 · 退出知识保鲜',
    'policy-convert': '分类策略已关闭 · 按规则快照转为文档级配置',
    handover: '负责人交接 · 保鲜责任转移'
  }[action] || action
}

// 版本记录上的保鲜标记
export function freshVersionBadge(v) {
  if (!v || !v.freshReview) return null
  if (v.freshReview.noChange) return { text: '保鲜确认 v' + v.freshReview.round, cls: 'fresh' }
  return { text: '保鲜修订 v' + v.freshReview.round, cls: 'fresh' }
}

// 距今文案：到期点剩余/逾期描述
export function dueText(doc, activeTicket, at = new Date()) {
  if (!isFreshnessEnabled(doc)) return ''
  const t = isFreshTicketOpen(activeTicket) ? activeTicket : null
  const dueAt = t?.dueAt || doc.freshness.nextDueAt
  if (!dueAt) return ''
  const diff = new Date(dueAt).getTime() - new Date(at).getTime()
  const day = DAY_MS
  const abs = Math.abs(diff)
  const n = Math.floor(abs / day)
  const span = n >= 1 ? n + ' 天' : Math.max(1, Math.floor(abs / (3600 * 1000))) + ' 小时'
  if (t) return '已逾期 ' + span
  return diff <= 0 ? '已到点' : span + '后到期'
}
