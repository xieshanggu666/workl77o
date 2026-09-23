// 文档版本恢复：端到端冒烟测试（fake-indexeddb + 真实 store）
// 覆盖：版本快照、恢复评审、并发修改边界标记、二次恢复重标、幂等与边界条件
// 运行：npm run test:restore（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useReviewStore } from '@/stores/review'
import { useKbStore } from '@/stores/kb'
import { diffVersionFields, diffBodyLines, applyRestoreBoundary, latestRestoreInfo } from '@/utils/version'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const review = useReviewStore(pinia)
const kb = useKbStore(pinia)

const editor = { id: 'u-edit', role: 'editor', name: '编辑甲' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

// 创建文档并保存多个版本（v1 由 createDoc 建立，v2..vN 由 updateDoc 追加，正文互不相同）
async function mkDocWithVersions(title, bodies) {
  const doc = await kb.createDoc({ title, body: bodies[0], categoryId: 'c-dev', tagIds: [], visibility: 'team' }, editor)
  for (let i = 1; i < bodies.length; i++) {
    const res = await kb.updateDoc(doc.id, { title, body: bodies[i], categoryId: 'c-dev', tagIds: [], visibility: 'team' }, editor, '编辑文档')
    if (res.status !== 'saved') throw new Error('保存失败: ' + res.status)
  }
  return db.docs.get(doc.id)
}

// ---------- 1. 基础恢复链路 + 并发修改边界 ----------
console.log('\n[1] v1-v4 → 恢复 v2 → 评审期间并发 v5 → 通过后 v6 恢复并标记边界')
const doc = await mkDocWithVersions('测试文档', ['v1 内容', 'v2 内容', 'v3 内容', 'v4 内容'])
assert(doc.versions.length === 4, '文档有 4 个版本')
assert(doc.versions.every((v) => v.snapshot), '每个版本都保存内容快照')
assert(doc.versions[1].snapshot.body === 'v2 内容', 'v2 快照内容正确')

let r = await review.submitRestoreReview(doc.id, 2, 'v2 是稳定版', editor)
assert(r.status === 'ok', '恢复评审提交成功')
assert(r.review.restoreFrom?.version === 2, '评审记录恢复来源 v2')
assert(r.review.snapshot.body === 'v2 内容', '评审快照为 v2 内容')
assert(r.review.baseVersion === 4, '评审基于 v4')
assert(r.review.restoreFrom.savedBy === editor.id, '恢复来源记录保存人')
const docLocked = await db.docs.get(doc.id)
assert(docLocked.publishState === 'in_review' && docLocked.activeReviewId === r.review.id, '文档进入评审中并锁定')

// 并发修改：管理员在评审期间直接保存 v5
const sv = await kb.updateDoc(doc.id, { title: '测试文档', body: 'v5 并发内容', categoryId: 'c-dev', tagIds: [], visibility: 'team' }, admin, '管理员直接保存')
assert(sv.status === 'saved', '管理员并发保存 v5 成功')
assert((await db.docs.get(doc.id)).versions.length === 5, '并发保存后文档有 5 个版本')

r = await review.decideReview(r.review.id, 'approve', '确认恢复', admin)
assert(r.status === 'ok' && r.approved, '恢复评审审批通过')
assert(r.review.restoreResult?.rolledBack.join(',') === '3,4,5', '评审单记录回滚 v3-v5')
assert(r.review.restoreResult?.rolledBackConcurrent.join(',') === '5', '评审单标记 v5 为并发修改')
const restored = await db.docs.get(doc.id)
assert(restored.body === 'v2 内容', '文档内容恢复为 v2')
assert(restored.versions.length === 6, '生成新版本 v6')
const v6 = restored.versions[5]
assert(v6.restore?.fromVersion === 2, 'v6 标记恢复自 v2')
assert(v6.restore.rolledBack.join(',') === '3,4,5', 'v6 回滚 v3-v5')
assert(v6.restore.rolledBackConcurrent.join(',') === '5', 'v5 标记为并发修改')
assert(v6.snapshot.body === 'v2 内容', 'v6 快照为 v2 内容')
assert(restored.versions[2].supersededBy?.version === 6, 'v3 标记被 v6 覆盖')
assert(restored.versions[3].supersededBy?.version === 6, 'v4 标记被 v6 覆盖')
assert(restored.versions[4].supersededBy?.version === 6, 'v5 标记被 v6 覆盖')
assert(!restored.versions[0].supersededBy && !restored.versions[1].supersededBy, 'v1/v2 无覆盖标记（内容生效）')
assert(restored.lastReview?.version === 6, 'lastReview 记录恢复版本')
assert(latestRestoreInfo(restored)?.fromVersion === 2, '问答引用可读到最新恢复信息')

// ---------- 2. 二次恢复：边界重标 ----------
console.log('\n[2] 二次恢复：恢复 v1，v2-v6 重标为被 v7 覆盖')
r = await review.submitRestoreReview(doc.id, 1, '回到最初', editor)
assert(r.status === 'ok', '二次恢复评审提交成功')
r = await review.decideReview(r.review.id, 'approve', '', admin)
assert(r.status === 'ok', '二次恢复审批通过')
const restored2 = await db.docs.get(doc.id)
assert(restored2.body === 'v1 内容', '文档恢复为 v1 内容')
assert(restored2.versions.length === 7, '生成 v7')
assert(restored2.versions[6].restore?.fromVersion === 1, 'v7 恢复自 v1')
assert(restored2.versions[6].restore.rolledBack.join(',') === '2,3,4,5,6', 'v7 回滚 v2-v6')
for (let i = 1; i < 6; i++) {
  assert(restored2.versions[i].supersededBy?.version === 7, 'v' + (i + 1) + ' 重标为被 v7 覆盖')
}
assert(!restored2.versions[0].supersededBy, 'v1 无覆盖标记')
assert(restored2.versions[5].restore?.fromVersion === 2 && restored2.versions[5].supersededBy?.version === 7, 'v6 保留恢复记录且被 v7 覆盖')

// ---------- 3. 幂等：恢复与当前一致的版本被拒绝 ----------
console.log('\n[3] 幂等：恢复与当前内容一致的版本被拒绝')
r = await review.submitRestoreReview(doc.id, 1, '', editor)
assert(r.status === 'identical', '恢复与当前一致的版本被拒绝（v1 已是当前内容）')
r = await review.submitRestoreReview(doc.id, 7, '', editor)
assert(r.status === 'identical', '恢复最新版本（即当前内容）被拒绝')

// ---------- 4. 无快照版本不可恢复 ----------
console.log('\n[4] 无快照的历史版本不可恢复')
const legacyDoc = await kb.createDoc({ title: '旧文档', body: '旧内容', categoryId: 'c-dev', tagIds: [], visibility: 'team' }, editor)
await db.docs.update(legacyDoc.id, { versions: [{ version: 1, savedAt: new Date().toISOString(), savedBy: editor.id, note: '旧版' }] })
assert(!(await db.docs.get(legacyDoc.id)).versions[0].snapshot, '构造出无快照的历史版本')
r = await review.submitRestoreReview(legacyDoc.id, 1, '', editor)
assert(r.status === 'no-snapshot', '无快照版本恢复被拒绝')

// ---------- 5. 重复发起与撤回 ----------
console.log('\n[5] 已有待审评审单时不可重复发起，撤回后可重新发起')
const doc2 = await mkDocWithVersions('另一个文档', ['v1', 'v2'])
const first = await review.submitRestoreReview(doc2.id, 1, '', editor)
assert(first.status === 'ok', '首次恢复评审成功')
r = await review.submitRestoreReview(doc2.id, 1, '', editor)
assert(r.status === 'duplicate', '重复恢复评审被拒绝')
await review.withdrawReview(first.review.id, editor)
const doc2After = await db.docs.get(doc2.id)
assert(doc2After.publishState === 'published' && !doc2After.activeReviewId, '撤回后文档解锁')
r = await review.submitRestoreReview(doc2.id, 1, '', editor)
assert(r.status === 'ok', '撤回后可重新发起恢复评审')

// ---------- 6. 快照对比工具 ----------
console.log('\n[6] 快照对比与边界工具')
assert(diffVersionFields({ title: 'a', body: 'x' }, { title: 'a', body: 'y' }).join(',') === 'body', '字段差异：正文')
assert(diffVersionFields({ title: 'a', body: 'x' }, { title: 'b', body: 'y' }).join(',') === 'title,body', '字段差异：标题+正文')
assert(diffVersionFields({ title: 'a', body: 'x', tagIds: [1] }, { title: 'a', body: 'x', tagIds: [2] }).join(',') === 'tagIds', '字段差异：标签')
const lines = diffBodyLines('<p>a</p><p>b</p>', '<p>a</p><p>c</p>')
assert(lines.some((l) => l.type === 'del' && l.text === 'b') && lines.some((l) => l.type === 'add' && l.text === 'c'), '行级差异：b→c')
assert(lines.some((l) => l.type === 'same' && l.text === 'a'), '行级差异：保留相同行')
const bounded = applyRestoreBoundary(
  [{ version: 1 }, { version: 2, supersededBy: { version: 3 } }, { version: 3 }],
  1, 4, 'now'
)
assert(!bounded[0].supersededBy, '边界内版本清除覆盖标记')
assert(bounded[1].supersededBy?.version === 4 && bounded[2].supersededBy?.version === 4, '边界外版本标记被覆盖')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
