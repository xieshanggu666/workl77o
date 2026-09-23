// 文档访问申请：状态常量、授权判定、申请/审批权限与留痕工具（均为纯函数，便于复用与测试）
// 流程：成员访问受限文档 → 申请限时阅读(read)/协作(collab)权限 → 拥有者（或管理员）审批 →
// 通过后授权记录在有效期内生效；撤销或到期后同步收回详情、搜索、问答与编辑权限。
// 申请单与授权变更记录全程保留在同一条记录的 timeline 中。

// 申请单状态
export const ACCESS = {
  PENDING: 'pending', // 待审批：成员已申请，等待拥有者处理
  APPROVED: 'approved', // 已通过：授权在 expiresAt 前有效（可被提前撤销）
  REJECTED: 'rejected', // 已驳回：不授权，可重新申请
  CANCELLED: 'cancelled', // 已取消：申请人主动撤回
  REVOKED: 'revoked' // 已撤销：拥有者提前收回授权
}

// 申请的权限类型（授权快照 grant 同样使用）
export const ACCESS_PERM = {
  READ: 'read', // 限时阅读：可查看详情、被搜索/问答检索
  COLLAB: 'collab' // 限时协作：在阅读基础上可编辑该文档
}

// 授权时长选项（天）；0 视为未设置
export const ACCESS_DURATIONS = [
  { value: 1, label: '1 天' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' }
]

export function accessStatusLabel(status) {
  return { pending: '待审批', approved: '已授权', rejected: '已驳回', cancelled: '已取消', revoked: '已撤销' }[status] || status
}

export function accessPermLabel(perm) {
  return { read: '限时阅读', collab: '限时协作' }[perm] || perm
}

// 授权记录当前是否有效（审批通过、未撤销、未到期）。
// 到期是惰性生效：记录状态仍为 approved，只在判定与扫描时视为失效，不依赖定时器。
// 到期时间以授权快照 grant.expiresAt 为准；顶层 expiresAt 仅用于库索引，保持同源
export function isGrantActive(req, now = new Date()) {
  if (!req || req.status !== ACCESS.APPROVED || req.revokedAt) return false
  const expiresAt = req.grant?.expiresAt || req.expiresAt
  if (expiresAt && new Date(expiresAt) <= now) return false
  return true
}

// 申请单是否仍在流转中（可取消 / 可审批）
export function isAccessOpen(req) {
  return !!req && req.status === ACCESS.PENDING
}

// 发起申请：登录成员对无法访问（或仅有阅读、想升级协作）的文档申请；
// 拥有者/固定协作成员无需申请，管理员可直接查看，也不走申请通道
export function canRequestAccess(doc, userId, role) {
  if (!doc || !userId) return false
  if (doc.ownerId === userId) return false
  if (doc.editors && doc.editors.includes(userId)) return false
  if (role === 'admin') return false
  return true
}

// 审批申请：文档拥有者或管理员，且申请仍待处理
export function canDecideAccess(req, doc, userId, role) {
  if (!isAccessOpen(req) || !doc) return false
  return role === 'admin' || doc.ownerId === userId
}

// 撤销授权：拥有者或管理员，且授权当前有效
export function canRevokeAccess(req, doc, userId, role, now) {
  if (!isGrantActive(req, now)) return false
  if (!doc) return false
  return role === 'admin' || doc.ownerId === userId
}

// 申请人取消自己的待审批申请
export function canCancelAccess(req, userId) {
  return isAccessOpen(req) && req.applicantId === userId
}

// 计算到期时间
export function calcExpiresAt(days, from = new Date()) {
  const n = Number(days)
  if (!n || n <= 0) return null
  return new Date(from.getTime() + n * 86400000).toISOString()
}

// 授权剩余描述
export function grantExpireText(req, now = new Date()) {
  if (!req) return ''
  if (req.status === ACCESS.REVOKED) return '已于 ' + fmt(req.revokedAt) + ' 撤销'
  if (req.expiresAt) {
    const expired = new Date(req.expiresAt) <= now
    return (expired ? '已于 ' : '有效期至 ') + fmt(req.expiresAt)
  }
  return '长期有效'
}

function fmt(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function accessStatusCls(status) {
  return { pending: 'st-pending', approved: 'st-ok', rejected: 'st-no', cancelled: 'st-off', revoked: 'st-revoked' }[status] || ''
}

// 生成一条申请/授权变更留痕，timeline 全程保留（申请与授权记录不删除）
export function buildAccessTimelineEntry(action, userId, note, now = new Date().toISOString()) {
  return { action, by: userId, note: note || '', at: now }
}

export function accessTimelineLabel(action) {
  return {
    apply: '提交访问申请',
    approve: '审批通过 · 生成授权',
    reject: '审批驳回',
    revoke: '撤销授权',
    cancel: '取消申请',
    expire: '授权到期 · 自动收回'
  }[action] || action
}
