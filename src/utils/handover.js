// 知识责任交接：状态常量、派生计算、并发变更校验、权限判定与留痕工具（均为纯函数，便于复用与测试）
// 流程：负责人在同一批交接中逐篇指定接任者（每篇文档可交接给不同成员）→ 各接任者按篇独立
// 确认或谢绝 → 管理员按确认结果分批批准（已确认篇可先批先转，谢绝/待确认篇不参与本批）→
// 批准篇在同一事务内执行转移：所有权（保留历史归属）、待办审批、保鲜责任一并转移，
// 并按交接决定保留/收回原负责人权限。批准执行时以发起快照逐篇复核并发变更：
// 校验与回退均以「篇」为单位，冲突篇标记失败（failed），不影响同批其他篇的确认与转移；
// 单篇转移写入异常由 Dexie 事务整体回滚，不产生部分写入。
import { ROLE, isGuestUser } from './permission'

// 交接篇（单篇文档）状态：交接流转的最小单元
export const HO_ITEM = {
  PENDING_CONFIRM: 'pending_confirm', // 待接任者确认：负责人已发起，等待该篇接任者接受
  CONFIRMED: 'confirmed', // 已确认：接任者已接受，等待管理员批准执行
  COMPLETED: 'completed', // 已完成：所有权/待办审批/保鲜责任已转移
  DECLINED: 'declined', // 已谢绝：接任者拒绝接收
  REJECTED: 'rejected', // 已驳回：管理员不批准该篇交接
  CANCELLED: 'cancelled', // 已取消：发起人（或管理员）在流转中取消
  FAILED: 'failed' // 已失败回退：执行时校验到并发变更/异常，未产生任何转移
}

// 交接单（批次）整体状态：由逐篇状态派生（PARTIAL 仅派生展示，不会出现在篇状态上）
export const HANDOVER = {
  PENDING_CONFIRM: 'pending_confirm', // 仍有篇待接任者确认
  PENDING_APPROVAL: 'pending_approval', // 无待确认篇，但有已确认篇待管理员批准
  COMPLETED: 'completed', // 全部篇均已完成转移
  PARTIAL: 'partial', // 部分完成：全部篇已终态且结果不一（有的转移、有的谢绝/驳回/失败等）
  DECLINED: 'declined', // 全部篇被谢绝
  REJECTED: 'rejected', // 全部篇被驳回
  CANCELLED: 'cancelled', // 全部篇被取消
  FAILED: 'failed' // 全部篇失败回退
}

// 原负责人权限处理（发起时选定的交接决定）
export const REVOKE_MODE = {
  KEEP: 'keep', // 保留协作权限：原负责人留在协作成员中，可继续编辑
  REVOKE: 'revoke' // 收回全部权限：移出协作成员，并撤销其在文档上的有效限时授权
}

// 批次整体状态派生：先看是否仍在流转（有待确认/待批准篇），全部终态后按篇结果汇总
export function handoverStatusOf(h) {
  const items = h?.items || []
  if (!items.length) return HANDOVER.PENDING_CONFIRM
  const ss = items.map((i) => i.status)
  if (ss.some((s) => s === HO_ITEM.PENDING_CONFIRM)) return HANDOVER.PENDING_CONFIRM
  if (ss.some((s) => s === HO_ITEM.CONFIRMED)) return HANDOVER.PENDING_APPROVAL
  if (ss.every((s) => s === HO_ITEM.COMPLETED)) return HANDOVER.COMPLETED
  if (ss.every((s) => s === HO_ITEM.DECLINED)) return HANDOVER.DECLINED
  if (ss.every((s) => s === HO_ITEM.REJECTED)) return HANDOVER.REJECTED
  if (ss.every((s) => s === HO_ITEM.CANCELLED)) return HANDOVER.CANCELLED
  if (ss.every((s) => s === HO_ITEM.FAILED)) return HANDOVER.FAILED
  return HANDOVER.PARTIAL
}

// 单篇是否仍在流转中（可确认/可审批/可取消）
export function isItemOpen(item) {
  return !!item && (item.status === HO_ITEM.PENDING_CONFIRM || item.status === HO_ITEM.CONFIRMED)
}

// 交接单是否仍在流转中（任一篇待确认或待批准）
export function isHandoverOpen(h) {
  const st = handoverStatusOf(h)
  return st === HANDOVER.PENDING_CONFIRM || st === HANDOVER.PENDING_APPROVAL
}

export function handoverStatusLabel(status) {
  return {
    pending_confirm: '待接任者确认',
    pending_approval: '待管理员批准',
    completed: '已完成',
    partial: '部分完成',
    declined: '已谢绝',
    rejected: '已驳回',
    cancelled: '已取消',
    failed: '已失败回退'
  }[status] || status
}

export function handoverStatusCls(status) {
  return {
    pending_confirm: 'st-pending',
    pending_approval: 'st-wait',
    completed: 'st-ok',
    partial: 'st-ok',
    declined: 'st-off',
    rejected: 'st-no',
    cancelled: 'st-off',
    failed: 'st-fail'
  }[status] || ''
}

// 篇级状态标签（交接单内逐篇展示）
export function handoverItemLabel(status) {
  return {
    pending_confirm: '待确认',
    confirmed: '待批准',
    completed: '已转移',
    declined: '已谢绝',
    rejected: '已驳回',
    cancelled: '已取消',
    failed: '转移失败'
  }[status] || status
}

export function handoverItemCls(status) {
  return {
    pending_confirm: 'st-pending',
    confirmed: 'st-wait',
    completed: 'st-ok',
    declined: 'st-off',
    rejected: 'st-no',
    cancelled: 'st-off',
    failed: 'st-fail'
  }[status] || ''
}

export function revokeModeLabel(mode) {
  return mode === REVOKE_MODE.REVOKE ? '收回原负责人全部权限' : '保留原负责人协作权限'
}

// 该交接单中指定某用户为接任者、且待其确认的篇
export function pendingItemsFor(h, userId) {
  return (h?.items || []).filter((i) => i.status === HO_ITEM.PENDING_CONFIRM && i.toUserId === userId)
}

// 该交接单中已确认、待管理员批准的篇（管理员分批批准的范围）
export function confirmedItemsOf(h) {
  return (h?.items || []).filter((i) => i.status === HO_ITEM.CONFIRMED)
}

// 文档保鲜配置签名：周期/到期点/轮次/流转中复核单任一变化都视为并发变更
export function freshnessSig(doc) {
  const f = doc?.freshness
  if (!f) return '-'
  return [f.cycleDays, f.nextDueAt, f.round, f.activeTicket || ''].join('|')
}

// 发起交接时的文档快照：批准执行时据此逐篇复核「交接期间是否发生并发变更」
export function handoverSnapshotOf(doc) {
  return {
    ownerId: doc.ownerId,
    updatedAt: doc.updatedAt,
    activeReviewId: doc.activeReviewId || null,
    freshnessSig: freshnessSig(doc)
  }
}

// 并发变更校验（纯函数）：以发起快照对比库中最新文档，返回不一致清单。
// 负责人变更、内容更新、评审状态变化、保鲜配置变化、文档被删除均视为冲突；
// 返回空数组表示这些篇可安全执行转移。
export function checkHandoverConflicts(items, docMap) {
  const failures = []
  for (const item of items || []) {
    const doc = docMap[item.docId]
    if (!doc) {
      failures.push({ docId: item.docId, title: item.title, fields: ['文档已删除'] })
      continue
    }
    const snap = item.snapshot || {}
    const fields = []
    if (doc.ownerId !== snap.ownerId) fields.push('负责人已变更')
    if (doc.updatedAt !== snap.updatedAt) fields.push('内容已更新')
    if ((doc.activeReviewId || null) !== (snap.activeReviewId || null)) fields.push('评审状态已变化')
    if (freshnessSig(doc) !== snap.freshnessSig) fields.push('保鲜配置已变化')
    if (fields.length) failures.push({ docId: item.docId, title: doc.title, fields })
  }
  return failures
}

// 发起交接：登录成员且为全部所选文档的负责人（具体文档归属在 store 事务内逐篇复核）
export function canInitiateHandover(userId) {
  return !isGuestUser(userId)
}

// 接任者确认/谢绝某一篇：仅该篇指定的接任者，且该篇处于待确认状态
export function canConfirmItem(item, userId) {
  return !!item && item.status === HO_ITEM.PENDING_CONFIRM && !isGuestUser(userId) && item.toUserId === userId
}

// 管理员批准/驳回某一篇：仅管理员，且该篇已确认待批准
export function canDecideItem(item, userId, role) {
  return !!item && item.status === HO_ITEM.CONFIRMED && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 管理员分批批准入口：仅管理员，且批次内存在已确认待批准的篇
export function canDecideHandover(h, userId, role) {
  return !!h && (h.items || []).some((i) => i.status === HO_ITEM.CONFIRMED) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 取消交接：发起人或管理员，且交接单仍在流转中
export function canCancelHandover(h, userId, role) {
  return isHandoverOpen(h) && !isGuestUser(userId) && (h.fromUserId === userId || role === ROLE.ADMIN)
}

// 交接留痕动作文案（交接单 timeline 全程保留；逐篇动作在 note 中带《篇名》）
export function handoverTimelineLabel(action) {
  return {
    initiate: '发起批量交接',
    confirm: '接任者确认接收',
    decline: '接任者谢绝交接',
    cancel: '取消交接',
    approve: '管理员批准 · 完成转移',
    reject: '管理员驳回',
    fail: '并发变更 · 转移未执行'
  }[action] || action
}
