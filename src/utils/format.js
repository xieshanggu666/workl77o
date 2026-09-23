// 通用格式化工具
export function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  const diff = now - d
  const m = 60 * 1000
  const h = 60 * m
  const day = 24 * h
  if (diff < m) return '刚刚'
  if (diff < h) return Math.floor(diff / m) + ' 分钟前'
  if (diff < day) return Math.floor(diff / h) + ' 小时前'
  if (diff < 7 * day) return Math.floor(diff / day) + ' 天前'
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function formatFull(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function uid(prefix = 'id') {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}

export function makeToken() {
  return 'share-' + Math.random().toString(36).slice(2, 10)
}

export function avatarColor(name = '') {
  const colors = ['#4f6ef7', '#0fb981', '#f7a24f', '#b062f7', '#f2555c', '#28a7e8']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return colors[Math.abs(hash) % colors.length]
}