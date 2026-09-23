// 知识退役替代：状态常量、退役/引用/搜索闸门、权限判定与留痕工具（均为纯函数，便于复用与测试）
// 流程：文档负责人发起退役并指定替代文档（pending）→ 管理员批准（approved）后同事务：
// 旧文档停止搜索命中与问答引用、共享链接批量撤销（记录保留）、已解决缺口工单的答案来源改挂替代文档；
// 管理员可驳回（rejected）、发起人可在审批前撤销（cancelled）；退役生效后可由发起人/管理员撤销退役
// （revoked：恢复搜索引用、恢复共享链接、答案来源回挂旧文档）。退役单与时间线全程保留。
import { ROLE, isGuestUser } from './permission'

// 退役单状态
export const RETIRE = {
  PENDING: 'pending', // 待审批：负责人已发起，等待管理员处理
  APPROVED: 'approved', // 已生效：旧文档已退役，搜索/问答引用已停止，答案来源改挂替代文档
  REJECTED: 'rejected', // 已驳回：管理员不批准本次退役，文档保持原状
  CANCELLED: 'cancelled', // 已撤销：发起人在审批前主动撤销
  REVOKED: 'revoked' // 已撤销退役：生效后被发起人/管理员撤销，旧文档恢复，记录保留
}

export function retireStatusLabel(status) {
  return {
    pending: '待管理员审批',
    approved: '已退役',
    rejected: '已驳回',
    cancelled: '已撤销',
    revoked: '已撤销退役'
  }[status] || status
}

export function retireStatusCls(status) {
  return {
    pending: 'st-pending',
    approved: 'st-retired',
    rejected: 'st-no',
    cancelled: 'st-off',
    revoked: 'st-restore'
  }[status] || ''
}

// 退役单是否仍在审批流转中（可驳回/可由发起人撤销）
export function isRetirementOpen(r) {
  return !!r && r.status === RETIRE.PENDING
}

// 退役已生效（旧文档处于退役态；可撤销退役）
export function isRetirementActive(r) {
  return !!r && r.status === RETIRE.APPROVED
}

// ---- 文档退役闸门 ----

// 文档是否已退役（doc.retirement 指向一条生效退役）。
// 生效退役的文档保留可读详情，但退出搜索与问答引用、禁止编辑/删除
export function isDocRetired(doc, activeRetirement) {
  if (activeRetirement) return true
  return !!doc?.retirement && doc.retirement.status === RETIRE.APPROVED
}

// 文档是否可被搜索/问答检索：已退役文档一律不可
export function isDocSearchable(doc, activeRetirement) {
  return !!doc && !isDocRetired(doc, activeRetirement)
}

// 文档是否可被问答引用：已退役文档一律不可
export function isDocRetireCitable(doc, activeRetirement) {
  return !!doc && !isDocRetired(doc, activeRetirement)
}

// ---- 发起/审批/撤销资格 ----

// 发起退役：登录成员且为文档负责人（拥有者）或管理员；
// 退役中（流转单）、已退役、评审中、交接中的文档不可发起；
// 本文档正作为他人在途/生效退役的替代文档时也不可发起（避免替代链断裂/成环）；
// 替代文档必须与旧文档不同且未退役
export function canInitiateRetirement(doc, userId, role, ctx = {}) {
  if (!doc || isGuestUser(userId)) return false
  if (doc.ownerId !== userId && role !== ROLE.ADMIN) return false
  if (isDocRetired(doc, ctx.activeRetirement)) return false
  if (ctx.openRetirement) return false
  if (ctx.usedAsReplacement) return false
  if (ctx.pendingReview) return false
  if (ctx.activeHandover) return false
  return true
}

// 替代文档合法性（纯函数）：必须存在、与旧文档不同、自身未退役、不在退役中
export function isValidReplacement(oldDoc, replacementDoc, ctx = {}) {
  if (!oldDoc || !replacementDoc) return false
  if (replacementDoc.id === oldDoc.id) return false
  if (isDocRetired(replacementDoc, ctx.activeRetirementOf?.(replacementDoc.id))) return false
  if (ctx.openRetirementOf?.(replacementDoc.id)) return false
  return true
}

// 管理员审批（批准/驳回）：仅管理员，且退役单仍待处理
export function canDecideRetirement(r, userId, role) {
  return isRetirementOpen(r) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 发起人在审批前撤销退役申请
export function canCancelRetirement(r, userId, role) {
  if (!isRetirementOpen(r) || isGuestUser(userId)) return false
  return r.initiatedBy === userId || role === ROLE.ADMIN
}

// 撤销已生效的退役：发起人本人或管理员
export function canRevokeRetirement(r, userId, role) {
  if (!isRetirementActive(r) || isGuestUser(userId)) return false
  return r.initiatedBy === userId || role === ROLE.ADMIN
}

// 退役留痕动作文案（退役单 timeline 全程保留）
export function retireTimelineLabel(action) {
  return {
    initiate: '发起文档退役',
    'batch-submit': '随批次统一送审',
    approve: '管理员批准 · 退役生效',
    reject: '管理员驳回',
    cancel: '发起人撤销退役申请',
    'batch-cancel': '随批次整体撤销申请',
    revoke: '撤销退役 · 恢复旧文档',
    'batch-revoke': '随批次撤销退役 · 恢复旧文档',
    // 退役生效时的联动结果
    'gap-repoint': '已解决缺口工单答案来源改挂替代文档',
    'share-revoke': '共享链接随退役批量撤销',
    // 撤销退役时的联动结果
    'gap-restore': '答案来源回挂旧文档',
    'share-restore': '共享链接随撤销退役恢复',
    // 编排作业（可重试分批编排）
    'batch-job': '分批编排作业',
    'batch-approve-all': '批量批准编排',
    'batch-revoke-all': '批量撤销恢复编排'
  }[action] || action
}

// ---- 批量送审 ----

// 批次整体状态（由各篇退役单派生，不单独存储）：
// active  = 尚有篇在待审批；resolved = 全部结案但无一篇生效（全驳回/撤销申请）；
// active-retired = 无待审批但至少一篇已生效（其余可能被驳回/撤销）；reverted = 曾生效但已全部撤销
export const RETIRE_BATCH = {
  ACTIVE: 'active',
  RESOLVED: 'resolved',
  ACTIVE_RETIRED: 'active-retired',
  REVERTED: 'reverted'
}

const TERMINAL = new Set([RETIRE.REJECTED, RETIRE.CANCELLED, RETIRE.REVOKED])

// 根据批次内退役单状态派生批次状态；空批次视为 resolved
export function retirementBatchStatusOf(items) {
  const list = items || []
  if (list.some((r) => r.status === RETIRE.PENDING)) return RETIRE_BATCH.ACTIVE
  if (list.some((r) => r.status === RETIRE.APPROVED)) return RETIRE_BATCH.ACTIVE_RETIRED
  if (list.length && list.every((r) => r.status === RETIRE.REVOKED)) return RETIRE_BATCH.REVERTED
  if (list.length && list.every((r) => TERMINAL.has(r.status))) return RETIRE_BATCH.RESOLVED
  return RETIRE_BATCH.RESOLVED
}

export function retirementBatchStatusLabel(status) {
  return {
    active: '待逐篇审批',
    resolved: '已结案（无生效篇）',
    'active-retired': '部分/全部已退役',
    reverted: '已全部撤销退役'
  }[status] || status
}

export function retirementBatchProgress(items) {
  const counts = { total: (items || []).length, pending: 0, approved: 0, rejected: 0, cancelled: 0, revoked: 0 }
  for (const r of items || []) {
    if (counts[r.status] !== undefined) counts[r.status]++
  }
  counts.done = counts.approved + counts.rejected + counts.cancelled + counts.revoked
  return counts
}

// 批次是否还有待审批篇（可整体取消申请）
export function isRetirementBatchActive(batch, items) {
  return retirementBatchStatusOf(items) === RETIRE_BATCH.ACTIVE
}

// 批次是否还有已生效篇（可批量撤销退役）
export function retirementBatchActiveItems(items) {
  return (items || []).filter((r) => isRetirementActive(r))
}

// 批量送审逐篇校验（纯函数；ctx 由 store 在事务内统一读出，避免并发窗口）：
// rows: [{ docId, replacementDocId, reason? }]，已按 docId 去重（重复篇返回 duplicate-doc）
// ctx: {
//   docOf(id) -> doc|null（库中最新）， userId, role,
//   openRetirementOfDoc(id) -> open 退役单|null（跨批次/单篇在途占用），
//   activeRetirementOfDoc(id) -> active 退役单|null,
//   openUsingAsReplacement(id) -> 以该文档为替代文档的在途退役单|null,
//   activeUsingAsReplacement(id) -> 以该文档为替代文档的生效退役单|null,
//   pendingReviewOfDoc(id) -> 评审单|null, openHandoverOfDoc(id) -> 交接单|null
// }
// 返回 { rows: [{ ...row, error: null|'missing'|'denied'|'in-retirement'|'bad-replacement'
//                 |'replacement-retired'|'used-as-replacement'|'in-review'|'in-handover'|'replacement-in-batch',
//               title, replacementTitle? }] }
// 批次级错误：'guest' | 'no-docs' | 'duplicate-doc'（随 rows 返回）；全部合法时 rows 无 error
export function checkRetirementBatch(rawRows, ctx) {
  const rows = []
  const oldIds = new Set()
  for (const row of rawRows || []) {
    const docId = row?.docId || null
    const replacementDocId = row?.replacementDocId || null
    if (!docId) continue // 空行忽略
    const base = { docId, replacementDocId, reason: String(row.reason || '').trim(), error: null, title: '', replacementTitle: '' }
    if (oldIds.has(docId)) {
      rows.push({ ...base, error: 'duplicate-doc' })
      continue
    }
    oldIds.add(docId)
    const doc = ctx.docOf(docId)
    if (!doc) { rows.push({ ...base, error: 'missing' }); continue }
    base.title = doc.title

    const replacement = replacementDocId ? ctx.docOf(replacementDocId) : null
    if (replacement) base.replacementTitle = replacement.title
    if (!replacementDocId || replacementDocId === docId || !replacement) {
      rows.push({ ...base, error: 'bad-replacement' })
      continue
    }
    if (ctx.activeRetirementOfDoc(docId) || doc.retirement?.status === RETIRE.APPROVED) {
      rows.push({ ...base, error: 'in-retirement' })
      continue
    }
    if (ctx.openRetirementOfDoc(docId)) { rows.push({ ...base, error: 'in-retirement' }); continue }
    // 文档间替代冲突：本文档正作为他人在途/生效退役的替代文档，退役它会让替代链断裂或成环
    const usedActive = ctx.activeUsingAsReplacement(docId)
    const usedOpen = ctx.openUsingAsReplacement(docId)
    if (usedActive || usedOpen) {
      const guard = usedActive || usedOpen
      rows.push({ ...base, error: 'used-as-replacement', usedByTitle: guard.docTitle || '' })
      continue
    }
    // 替代文档自身已退役/在退役流程中
    if (ctx.activeRetirementOfDoc(replacementDocId) || replacement.retirement?.status === RETIRE.APPROVED
      || ctx.openRetirementOfDoc(replacementDocId)) {
      rows.push({ ...base, error: 'replacement-retired' })
      continue
    }
    if (ctx.pendingReviewOfDoc(docId)) { rows.push({ ...base, error: 'in-review' }); continue }
    if (ctx.openHandoverOfDoc(docId)) { rows.push({ ...base, error: 'in-handover' }); continue }
    rows.push(base)
  }

  // 批次内替代冲突：某篇的替代文档正是同批待退役文档（A⇒B 且 B 也在本批退役，含同批成环）
  // 逐篇批准会造成先批的篇把引用改挂到一篇随后也将退役的文档，统一送审阶段直接拦截
  for (const row of rows) {
    if (row.error || !row.replacementDocId) continue
    if (oldIds.has(row.replacementDocId)) {
      const rep = rows.find((x) => x.docId === row.replacementDocId)
      row.error = 'replacement-in-batch'
      row.replacementTitle = rep?.title || row.replacementTitle
    }
  }
  return { rows }
}

// 批量送审逐篇错误文案（供发起对话框逐行提示）
export function retireRowErrorLabel(error, row) {
  switch (error) {
    case 'duplicate-doc': return '同一文档在本批中重复出现'
    case 'missing': return '文档不存在或已被删除'
    case 'denied': return '仅文档负责人或管理员可发起'
    case 'in-retirement': return '该文档已退役或存在流转中的退役单'
    case 'bad-replacement': return '请选择不同于本文档、且仍存在的替代文档'
    case 'replacement-retired': return '替代文档已退役或在退役流程中'
    case 'used-as-replacement': return '本文档正作为' + (row?.usedByTitle ? '《' + row.usedByTitle + '》' : '另一篇文档') + '的替代文档，需先处理该退役'
    case 'in-review': return '文档评审中，请待评审完结'
    case 'in-handover': return '文档责任交接中，请先完成或取消交接'
    case 'replacement-in-batch': return '替代文档《' + (row?.replacementTitle || '') + '》也在本批退役中，会形成替代链冲突'
    default: return ''
  }
}
