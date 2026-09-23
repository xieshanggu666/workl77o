// 文档版本与并发保存：版本号读取、旧数据兼容、三方字段合并、版本快照对比与恢复边界
// 供 kb store 的乐观锁冲突检测与 review store 的恢复评审使用，均为纯函数便于测试

// 当前版本号。旧数据没有 versions 字段时视为 1 个版本（与 ensureVersions 的补全逻辑一致）
export function docVersion(doc) {
  if (!doc) return 0
  return Array.isArray(doc.versions) && doc.versions.length ? doc.versions.length : 1
}

// 从文档字段提取可比较的内容快照（版本记录与恢复评审共用的结构）
export function docSnapshot(doc) {
  return {
    title: doc?.title || '',
    body: doc?.body || '',
    categoryId: doc?.categoryId || null,
    tagIds: [...(doc?.tagIds || [])],
    visibility: doc?.visibility || 'public'
  }
}

// 兼容已有文档：缺失/损坏的 versions 记录补一条初始版本，保证后续追加不丢历史。
// 补全的初始版本以当前内容为快照——该文档此前未留版本，当前内容即其唯一已知状态
export function ensureVersions(doc, now) {
  if (Array.isArray(doc.versions) && doc.versions.length) return doc.versions
  return [{
    version: 1,
    savedAt: doc.createdAt || doc.updatedAt || now,
    savedBy: doc.ownerId || 'u-guest',
    note: '初始版本',
    snapshot: docSnapshot(doc)
  }]
}

function sameVal(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// 三方合并：以 base（编辑器打开时的快照）为基准，把 patch 合并到 latest（库中最新）上
// - latest 相对 base 未变的字段：采用我方 patch 值
// - 我方相对 base 未变的字段：保留 latest（对方）值
// - 双方都改了同一字段：记入 conflicts，由调用方决定（默认保留 latest，等待用户选择）
// 返回 { fields, autoMerged, conflicts }
export function mergeDocFields(latest, base, patch) {
  const fields = {}
  const autoMerged = []
  const conflicts = []
  for (const key of Object.keys(patch)) {
    const mine = patch[key]
    const theirs = latest?.[key]
    const origin = base?.[key]
    const otherChanged = !sameVal(theirs, origin)
    const mineChanged = !sameVal(mine, origin)
    if (!otherChanged || !mineChanged) {
      // 只有一方改过（或都没改）：安全取值；双方都改时才可能冲突
      fields[key] = mineChanged ? mine : theirs
      if (otherChanged && !mineChanged) autoMerged.push(key)
    } else if (sameVal(mine, theirs)) {
      fields[key] = mine // 双方改成一样的值，不算冲突
    } else {
      conflicts.push(key)
      fields[key] = theirs // 冲突字段先保留库中最新，等待用户决策
    }
  }
  return { fields, autoMerged, conflicts }
}

// 可编辑字段的中文名，用于冲突提示
export const DOC_FIELD_LABELS = {
  title: '标题', categoryId: '分类', tagIds: '标签', visibility: '可见性', body: '正文'
}

export function fieldLabels(keys) {
  return (keys || []).map((k) => DOC_FIELD_LABELS[k] || k)
}

// ---- 版本快照对比 ----

// 两个内容快照的字段级差异（title/body/categoryId/tagIds/visibility）
export function diffVersionFields(snapA, snapB) {
  const changed = []
  if ((snapA?.title || '') !== (snapB?.title || '')) changed.push('title')
  if ((snapA?.body || '') !== (snapB?.body || '')) changed.push('body')
  if ((snapA?.categoryId || null) !== (snapB?.categoryId || null)) changed.push('categoryId')
  if (JSON.stringify(snapA?.tagIds || []) !== JSON.stringify(snapB?.tagIds || [])) changed.push('tagIds')
  if ((snapA?.visibility || 'public') !== (snapB?.visibility || 'public')) changed.push('visibility')
  return changed
}

// 正文 HTML → 文本行：块级标签视为换行，便于做行级差异对比
function htmlToLines(html) {
  return String(html || '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// 正文行级差异（LCS）：返回 [{ type: 'same' | 'add' | 'del', text }]
// 语义为「before → after」：del 表示 before 有而 after 没有，add 表示 after 新增
export function diffBodyLines(bodyA, bodyB) {
  const a = htmlToLines(bodyA)
  const b = htmlToLines(bodyB)
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++ }
    else { out.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < m) { out.push({ type: 'del', text: a[i] }); i++ }
  while (j < n) { out.push({ type: 'add', text: b[j] }); j++ }
  return out
}

// ---- 恢复边界 ----

// 恢复评审通过时重标版本边界：
// - fromVersion 之后的版本：其修改被本次恢复回滚，标记 supersededBy = 新版本号
// - fromVersion 及之前的版本：其内容随恢复重新生效，清除既有的被覆盖标记
// 返回新的版本数组（不修改入参）
export function applyRestoreBoundary(versions, fromVersion, newVersion, at) {
  return versions.map((v) => {
    if (v.version > fromVersion) {
      return { ...v, supersededBy: { version: newVersion, at } }
    }
    if (v.supersededBy) {
      const { supersededBy, ...rest } = v
      return rest
    }
    return v
  })
}

// 计算恢复将回滚的版本：
// rolledBack —— fromVersion 之后、当前之前的全部版本（含并发修改）
// rolledBackConcurrent —— 其中在恢复评审提交之后（baseVersion 之后）并发产生的版本
export function restoreRollbackInfo(versions, fromVersion, baseVersion) {
  const rolledBack = versions.filter((v) => v.version > fromVersion).map((v) => v.version)
  const rolledBackConcurrent = versions.filter((v) => v.version > baseVersion).map((v) => v.version)
  return { rolledBack, rolledBackConcurrent }
}

// 文档最新版本是否为一次恢复（问答引用角标等场景使用）
export function latestRestoreInfo(doc) {
  const vs = doc?.versions
  if (!Array.isArray(vs) || !vs.length) return null
  return vs[vs.length - 1].restore || null
}

// 版本号列表的区间展示：单个版本显示「v2」，多个显示「v2–v5」
export function versionRangeText(versions) {
  if (!versions || !versions.length) return ''
  if (versions.length === 1) return 'v' + versions[0]
  return 'v' + versions[0] + '–v' + versions[versions.length - 1]
}
