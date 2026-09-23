// 共享链接：统一的链接生成与状态判定
// 查看 / 编辑 / 撤销 / 过期 四处共用，保证链接状态与文档访问权限始终一致

const base = typeof location !== 'undefined' ? location.origin + location.pathname : ''

// 文档正常访问链接（详情页）
export function docUrl(docId) {
  return base + '#/docs/' + docId
}

// 共享链接（凭 token 访问）
export function shareUrl(token) {
  return base + '#/share/' + token
}

// 链接状态：active 有效 | expired 已过期 | revoked 已撤销 | invalid 不存在
export function shareStatus(share, now = new Date()) {
  if (!share) return 'invalid'
  if (share.revokedAt) return 'revoked'
  if (share.expiresAt && new Date(share.expiresAt) <= now) return 'expired'
  return 'active'
}

export function isShareActive(share, now) {
  return shareStatus(share, now) === 'active'
}

// 只有「有效且权限为 edit」的链接才可编辑文档
export function canShareEdit(share, now) {
  return isShareActive(share, now) && share.permission === 'edit'
}

export function shareStatusLabel(status) {
  return { active: '有效', expired: '已过期', revoked: '已撤销', invalid: '无效' }[status] || status
}
