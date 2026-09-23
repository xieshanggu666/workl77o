// 权限工具：基于角色、文档关系与凭证（限时授权 / 共享链接）的统一校验。
// 所有内容写入口（普通保存、共享链接保存、删除、发起评审、缺口送审、审批）共用同一套判定，
// 存储层事务内必须用库中最新数据重新校验，防止仅靠前端隐藏入口被多窗口/直接调用 store 绕过。
import { isShareActive, canShareEdit } from './share'
import { isDocInReview } from './review'
import { isGrantActive, ACCESS_PERM } from './access'
import { isDocRetired } from './retirement'

export const ROLE = { ADMIN: 'admin', EDITOR: 'editor', VIEWER: 'viewer' }

// 访客（未登录）用户 id：auth store 中 user 为 null 时各写入口统一落到该 id
export const GUEST_ID = 'u-guest'

export function isGuestUser(userId) {
  return !userId || userId === GUEST_ID
}

// 可新增/编辑/删除的（内容治理角色）
export function canEditContent(role) {
  return role === ROLE.ADMIN || role === ROLE.EDITOR
}

// 文档直接写入资格（普通编辑保存 / 共享链接编辑共用）。
// ctx: { userId, role, grant（限时访问授权记录）, share（共享链接记录）, pendingReview, now }
// 规则：
// - 访客没有任何文档级身份，唯一写入通道是「有效且 permission=edit」的共享链接；链接撤销/过期立即收回；
// - 文档处于评审中时锁定正文：仅管理员可直接改动（审批 decideReview 是独立写入通道，不走本函数），
//   限时协作者与可编辑共享链接同样受锁定约束；
// - 登录成员：拥有者 / 固定协作成员 / 持有效限时协作授权 / 持有效可编辑共享链接可写；
// - 管理员作为内容治理角色可直接修订任意文档（含评审中的并发修改）；
// - 仅凭编辑者角色不能写不属于自己的文档（修复角色级越权）。
export function canEditDoc(doc, ctx = {}) {
  if (!doc) return false
  // 已退役文档为只读归档：任何身份（含管理员、共享链接、限时授权）均不可再改正文，
  // 如需修改须先撤销退役（恢复搜索/引用）后再编辑
  if (isDocRetired(doc, ctx.activeRetirement)) return false
  const locked = isDocInReview(doc, ctx.pendingReview)
  if (isGuestUser(ctx.userId)) {
    // 评审锁定对访客同样生效，不允许借共享链接在锁定期写入
    return !locked && canShareEdit(ctx.share, ctx.now)
  }
  if (locked && ctx.role !== ROLE.ADMIN) return false
  if (doc.ownerId === ctx.userId) return true
  if (Array.isArray(doc.editors) && doc.editors.includes(ctx.userId)) return true
  // 限时协作授权：授权期内放开编辑（只读角色也可协作），撤销/到期由 isGrantActive 判定为失效
  if (isGrantActive(ctx.grant, ctx.now) && ctx.grant.grant?.permission === ACCESS_PERM.COLLAB) return true
  // 登录成员持有效可编辑共享链接同样放行（链接被撤销/过期则收回）
  if (canShareEdit(ctx.share, ctx.now)) return true
  if (ctx.role === ROLE.ADMIN) return true
  return false
}

// 删除文档：破坏性操作，仅限拥有者 / 固定协作成员 / 管理员。
// 限时协作授权与共享链接只授予正文编辑，不授予删除；访客与评审锁定（非管理员）同样拒绝
export function canDeleteDoc(doc, ctx = {}) {
  if (!doc || isGuestUser(ctx.userId)) return false
  // 已退役文档保留作历史归档与替代跳转，不允许删除；需删除先撤销退役
  if (isDocRetired(doc, ctx.activeRetirement)) return false
  if (isDocInReview(doc, ctx.pendingReview) && ctx.role !== ROLE.ADMIN) return false
  if (doc.ownerId === ctx.userId) return true
  if (Array.isArray(doc.editors) && doc.editors.includes(ctx.userId)) return true
  return ctx.role === ROLE.ADMIN
}

// 是否可查看某文档（可见性 + 登录身份 + 拥有者 + 协作成员 + 有效限时授权 + 有效共享链接）
// grant：该用户在该文档上的访问申请记录（approved 且未撤销/未到期才授权）
// 统一登录身份校验：team（团队可见）仅限已登录成员；未登录访客只能看 public，
// 或凭与该文档匹配的有效共享链接访问（含 team/private，链接撤销/过期即收回）
export function canViewDoc(doc, userId, share, grant, now) {
  if (!doc) return false
  if (doc.visibility === 'public') return true
  const guest = isGuestUser(userId)
  // 有效共享链接是访客访问 team/private 文档的唯一凭证（登录成员持链接同样放行）
  if (isShareActive(share, now)) return true
  if (guest) return false
  if (doc.visibility === 'team') {
    // team 指全员可见（演示简化：所有登录成员可见；访客在上方已被拦截）
    return true
  }
  // private：拥有者、固定协作成员、限时授权成员可见
  if (doc.ownerId === userId) return true
  if (doc.editors && doc.editors.includes(userId)) return true
  if (isGrantActive(grant, now)) return true
  return false
}

export function roleLabel(role) {
  return { admin: '管理员', editor: '编辑者', viewer: '只读' }[role] || role
}

// 生成共享链接资格：链接授予的权限不得超过创建者自身对该文档拥有的权限。
// 修复越权链：只读查看者/访客打开分享入口生成「可编辑」链接 → 访客持链接改正文
// （分享管理 → 正文保存的权限升级）。ctx 与 canEditDoc 同源：
// { userId, role, grant, pendingReview, activeRetirement, now }
// - 访客（未登录）不能生成任何共享链接；
// - 已退役文档为只读归档，退役流程已批量撤销共享链接，归档期间禁止再生成新链接；
// - permission='edit'：创建者此刻必须具备正文写入资格（与 canEditDoc 同规则，
//   评审锁定/退役同样拒绝，避免生成锁定期内无法使用的「可编辑」链接）；
// - permission='view'：创建者须能查看该文档（可见性 / 拥有者 / 协作成员 / 有效限时授权）。
export function canCreateShare(doc, permission, ctx = {}) {
  if (!doc || isGuestUser(ctx.userId)) return false
  if (isDocRetired(doc, ctx.activeRetirement)) return false
  if (permission === 'edit') return canEditDoc(doc, ctx)
  if (permission === 'view') return canViewDoc(doc, ctx.userId, null, ctx.grant, ctx.now)
  return false
}

// 撤销共享链接：仅限链接创建者本人、文档拥有者或管理员。
// 防止只读查看者打开分享管理后撤销他人（如拥有者）创建的链接。
export function canRevokeShare(share, doc, userId, role) {
  if (!share || !doc || isGuestUser(userId)) return false
  return share.createdBy === userId || doc.ownerId === userId || role === ROLE.ADMIN
}
