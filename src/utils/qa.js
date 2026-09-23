// 用于问答的规则/关键词匹配
export function buildStopwords() {
  return new Set(
    '的，了，吗，呢，是，在，和，与，一个，怎么，如何，什么，哪个，请，告诉我，我，你，这个，那个，介绍，给我，下，etc.'.split(/[，。,.:：]/).filter(Boolean)
  )
}
// 其实中文无需停用词细拆，保留弱词集合做降权即可
export const WEAK_WORDS = new Set(['如何', '怎么', '什么', '哪些', '请问', '请', '一下', '了', '的'])

export function extractKeywords(query) {
  return String(query || '')
    .replace(/[？?！!。，,、；;：:]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !WEAK_WORDS.has(w))
}

// 对候选文档打分：标题命中权重>标签命中>正文命中
export function scoreDoc(doc, keywords, tagNames = [], bodyText) {
  let score = 0
  const title = String(doc.title || '').toLowerCase()
  const body = String(bodyText).toLowerCase()
  const tagHits = (doc.tagIds || []).filter((id) =>
    tagNames.some((tn) => tn && String(tn.name).toLowerCase().includes(keywords.join(' ')))
  )
  for (const kw of keywords) {
    const k = kw.toLowerCase()
    if (title.includes(k)) score += 5
    if ((doc.tagIds || []).some((tid) => (tagNames.find((t) => t.id === tid)?.name || '').toLowerCase().includes(k))) score += 3
    if (body.includes(k)) score += 2
  }
  return score
}