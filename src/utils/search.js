// 全文检索 + 命中高亮 + 相关片段抽取
export function tokenize(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export function stripHtml(html = '') {
  const el = document.createElement('div')
  el.innerHTML = html
  return (el.textContent || '').replace(/\s+/g, ' ').trim()
}

// 在纯文本中用关键词高亮，返回可 v-html 的安全 HTML
export function highlightText(text, tokens) {
  if (!tokens || tokens.length === 0) return escapeHtml(text)
  let result = escapeHtml(text)
  for (const t of tokens) {
    const re = new RegExp('(' + escapeRegExp(t) + ')', 'gi')
    result = result.replace(re, '<mark>$1</mark>')
  }
  return result
}

// 抽取首次命中的上下文片段
export function extractSnippet(html, tokens, maxLen = 120) {
  const text = stripHtml(html)
  const lower = text.toLowerCase()
  let idx = -1
  for (const t of tokens) {
    const i = lower.indexOf(t)
    if (i >= 0 && (idx === -1 || i < idx)) idx = i
    if (idx === 0) break
  }
  let slice
  if (idx < 0) {
    slice = text.slice(0, maxLen)
  } else {
    const start = Math.max(0, idx - 40)
    slice = (start > 0 ? '…' : '') + text.slice(start, start + maxLen) + '…'
  }
  return slice
}

// 标题命中高亮
export function highlightTitle(title, tokens) {
  return highlightText(String(title || ''), tokens)
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}