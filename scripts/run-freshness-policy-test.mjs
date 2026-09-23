// 分类复核策略端到端回归（fake-indexeddb + 真实 store）
// 覆盖：管理员按分类批量设置复核周期（权限）→ 无覆盖文档继承、文档级覆盖不动 →
//       策略调整重算到期计划、在途复核单保留规则快照 → 审批结案按当前策略重算 →
//       关闭策略（无在途退出保鲜恢复引用 / 有在途转文档级快照）→ 恢复跟随分类策略 →
//       新建文档继承、编辑/审批改分类重解析 → 问答引用闸门 → 交接并发签名联动 →
//       已有逐篇配置迁移（v9）。
// 运行：npm run test:policy
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db, migrateFreshnessPolicyV9 } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useReviewStore } from '@/stores/review'
import { useFreshnessStore } from '@/stores/freshness'
import { uid } from '@/utils/format'
import { FRESH, isDocCitable, canManagePolicy, RULE_SOURCE } from '@/utils/freshness'
import { handoverSnapshotOf, checkHandoverConflicts } from '@/utils/handover'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const review = useReviewStore(pinia)
const freshness = useFreshnessStore(pinia)

const owner = { id: 'u-owner', role: 'editor', name: '负责人' }
const editor = { id: 'u-editor', role: 'editor', name: '编辑乙' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }
const viewer = { id: 'u-viewer', role: 'viewer', name: '只读' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const nowIso = () => new Date().toISOString()
const pastIso = () => new Date(Date.now() - 60 * 1000).toISOString()

await db.categories.bulkAdd([
  { id: 'c-a', name: '甲类', icon: 'doc' },
  { id: 'c-b', name: '乙类', icon: 'doc' },
  { id: 'c-c', name: '丙类', icon: 'doc' }
])
await kb.loadAll()

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '策略文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>正文 v1</p>', categoryId: 'c-a', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id, editor.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: { title: '', body: '<p>正文 v1</p>', categoryId: 'c-a', tagIds: [], visibility: 'public' } }],
    ...extra
  }
  d.versions[0].snapshot.title = d.title
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}
const getDoc = (id) => db.docs.get(id)
const policyOf = (catId) => db.freshnessPolicies.where('categoryId').equals(catId).first()

// ---------- 1. 分类策略权限与批量设置 ----------
console.log('\n[1] 仅管理员可设置分类策略，批量应用到无覆盖文档')
const d1 = await mkDoc()
const d2 = await mkDoc()
const d3 = await mkDoc()
let r = await freshness.setFreshCycle(d3.id, 30, owner)
assert(r.status === 'ok' && (await getDoc(d3.id)).freshness.source === RULE_SOURCE.DOC, '逐篇设置后标记为文档级覆盖')
assert(canManagePolicy('admin') === true && canManagePolicy('editor') === false, '策略管理仅管理员（纯函数）')
r = await freshness.setCategoryPolicy('c-a', 90, editor)
assert(r.status === 'denied', '编辑者设置分类策略被拒绝')
r = await freshness.setCategoryPolicy('c-a', 90, null)
assert(r.status === 'guest', '访客设置分类策略被拒绝')
r = await freshness.setCategoryPolicy('c-a', 0, admin)
assert(r.status === 'bad-cycle', '非法周期被拒绝')
r = await freshness.setCategoryPolicy('c-a', 90, admin)
assert(r.status === 'ok' && r.action === 'setting', '管理员设置分类策略成功')
assert(r.applied === 2 && r.kept === 1 && r.skipped === 0, '批量应用 2 篇、文档级覆盖 1 篇未动')
const d1p = await getDoc(d1.id)
assert(d1p.freshness?.source === RULE_SOURCE.POLICY && d1p.freshness.cycleDays === 90, '无覆盖文档继承策略（90 天）')
assert(!!d1p.freshness.policyId && new Date(d1p.freshness.nextDueAt) > new Date(), '继承配置物化到期点与策略来源')
assert(isDocCitable(d1p, null, new Date()) === true, '周期内问答引用正常')
const d3p = await getDoc(d3.id)
assert(d3p.freshness.cycleDays === 30 && d3p.freshness.source === RULE_SOURCE.DOC, '文档级覆盖不受批量设置影响')
const pol1 = await policyOf('c-a')
assert(pol1 && (pol1.timeline || []).some((x) => x.action === 'policy-setting'), '策略记录含设置留痕')

// ---------- 2. 策略调整重算到期计划 + 文档覆盖/恢复继承 ----------
console.log('\n[2] 策略调整重算继承文档，覆盖文档不动；覆盖可恢复继承')
r = await freshness.setFreshCycle(d1.id, 30, owner)
assert(r.status === 'ok' && (await getDoc(d1.id)).freshness.source === RULE_SOURCE.DOC, '继承文档单独设置后转为覆盖')
r = await freshness.setCategoryPolicy('c-a', 180, admin)
assert(r.status === 'ok' && r.action === 'change', '策略调整成功')
assert(r.applied === 1 && r.kept === 2, '仅 1 篇继承文档重算，2 篇覆盖保留')
const d2p = await getDoc(d2.id)
assert(d2p.freshness.cycleDays === 180 && d2p.freshness.source === RULE_SOURCE.POLICY, '继承文档按新策略重算（180 天）')
assert((await getDoc(d1.id)).freshness.cycleDays === 30, '覆盖文档周期保持 30 天')
r = await freshness.resetToPolicy(d1.id, editor)
assert(r.status === 'denied', '非负责人不能恢复继承')
r = await freshness.resetToPolicy(d1.id, owner)
assert(r.status === 'ok', '负责人恢复跟随分类策略')
const d1r = await getDoc(d1.id)
assert(d1r.freshness.source === RULE_SOURCE.POLICY && d1r.freshness.cycleDays === 180, '恢复继承后跟随当前策略周期')

// ---------- 3. 在途复核单保留规则快照 ----------
console.log('\n[3] 策略调整时在途复核单保留规则快照')
await db.docs.update(d2.id, { 'freshness.nextDueAt': pastIso() })
await kb.reloadDocs()
await freshness.reload()
await freshness.sweepDue()
const t2 = freshness.activeTicketOf(d2.id)
assert(!!t2 && t2.status === FRESH.OPEN, '到期生成复核单')
assert(t2.ruleSource === RULE_SOURCE.POLICY && t2.cycleDays === 180, '复核单携带规则快照（继承策略 · 180 天）')
const dueAtBefore = (await getDoc(d2.id)).freshness.nextDueAt
r = await freshness.setCategoryPolicy('c-a', 365, admin)
assert(r.status === 'ok' && r.skipped === 1, '在途复核单所在文档被跳过（快照保留）')
const d2s = await getDoc(d2.id)
assert(d2s.freshness.cycleDays === 180 && d2s.freshness.nextDueAt === dueAtBefore, '在途文档配置不被策略调整改写')
const t2b = freshness.activeTicketOf(d2.id)
assert(t2b.cycleDays === 180 && t2b.ruleSource === RULE_SOURCE.POLICY, '在途复核单快照不变')
assert(isDocCitable(d2s, t2b, new Date()) === false, '在途期间问答引用继续暂停')
r = await freshness.setFreshCycle(d2.id, 30, owner)
assert(r.status === 'has-open', '在途期间也不允许改为文档级周期')

// ---------- 4. 复核审批联动：结案按当前策略重算，快照不改写 ----------
console.log('\n[4] 在途单审批通过：按当前策略重算下一周期')
r = await freshness.submitFreshReview(d2.id, {}, '内容仍有效', true, owner)
assert(r.status === 'ok', '在途单确认有效送审')
const rvId = freshness.activeTicketOf(d2.id).reviewId
r = await review.decideReview(rvId, 'approve', '通过。', admin)
assert(r.status === 'ok', '管理员复核批准')
const d2d = await getDoc(d2.id)
assert(d2d.freshness.cycleDays === 365 && d2d.freshness.source === RULE_SOURCE.POLICY, '结案后按当前策略（365 天）重算')
assert(new Date(d2d.freshness.nextDueAt) > new Date(Date.now() + 300 * 24 * 3600 * 1000), '下一到期点按新周期落在未来')
assert(isDocCitable(d2d, null, new Date()) === true, '批准后问答引用恢复')
const t2done = await db.freshnessTickets.get(t2.id)
assert(t2done.status === FRESH.APPROVED && t2done.cycleDays === 180 && t2done.ruleSource === RULE_SOURCE.POLICY, '历史复核单快照保持 180 天不改写')

// ---------- 5. 关闭分类策略：无在途退出保鲜 / 有在途转文档级快照 ----------
console.log('\n[5] 关闭分类策略的两路处理')
const d4 = await mkDoc()
await db.docs.update(d4.id, {
  freshness: { cycleDays: 365, nextDueAt: pastIso(), round: 0, activeTicket: null, source: RULE_SOURCE.POLICY, policyId: pol1.id }
})
await kb.reloadDocs()
await freshness.reload()
await freshness.sweepDue()
const t4 = freshness.activeTicketOf(d4.id)
assert(!!t4 && t4.ruleSource === RULE_SOURCE.POLICY, 'd4 在途复核单（继承策略）已生成')
r = await freshness.clearCategoryPolicy('c-a', editor)
assert(r.status === 'denied', '非管理员关闭策略被拒绝')
r = await freshness.clearCategoryPolicy('c-a', admin)
assert(r.status === 'ok' && r.converted === 1 && r.cleared >= 1, '关闭策略：在途转文档级、无在途退出保鲜')
assert(!(await policyOf('c-a')), '策略记录已删除')
const d1c = await getDoc(d1.id)
assert(!d1c.freshness && isDocCitable(d1c, null, new Date()) === true, '无在途继承文档退出保鲜并恢复引用')
const d3c = await getDoc(d3.id)
assert(d3c.freshness?.cycleDays === 30 && d3c.freshness.source === RULE_SOURCE.DOC, '文档级覆盖不受策略关闭影响')
const d4c = await getDoc(d4.id)
assert(d4c.freshness?.source === RULE_SOURCE.DOC && d4c.freshness.cycleDays === 365 && !d4c.freshness.policyId, '在途文档按快照转为文档级配置')
const t4c = await db.freshnessTickets.get(t4.id)
assert((t4c.timeline || []).some((x) => x.action === 'policy-convert'), '在途复核单留痕「策略关闭转文档级」')
assert(t4c.ruleSource === RULE_SOURCE.POLICY && t4c.cycleDays === 365, '在途单生成时快照仍记录继承来源')
// 结案：策略已关闭，按快照周期（文档级）重算
r = await freshness.submitFreshReview(d4.id, {}, '确认有效', true, owner)
assert(r.status === 'ok', 'd4 送审成功')
r = await review.decideReview(freshness.activeTicketOf(d4.id).reviewId, 'approve', '', admin)
assert(r.status === 'ok', 'd4 复核批准')
const d4d = await getDoc(d4.id)
assert(d4d.freshness.cycleDays === 365 && d4d.freshness.source === RULE_SOURCE.DOC, '策略已关闭：按快照周期以文档级继续')

// ---------- 6. 新建文档继承 + 问答引用闸门 ----------
console.log('\n[6] 新建文档自动继承分类策略，到期暂停问答引用')
r = await freshness.setCategoryPolicy('c-b', 90, admin)
assert(r.status === 'ok', '乙类策略设置成功')
const dNew = await kb.createDoc({ title: '乙类新文档', categoryId: 'c-b', body: '<p>新文档正文</p>', visibility: 'public' }, editor)
assert(dNew.freshness?.source === RULE_SOURCE.POLICY && dNew.freshness.cycleDays === 90, '新建文档自动继承分类策略')
assert(isDocCitable(dNew, null, new Date()) === true, '到期前引用正常')
await db.docs.update(dNew.id, { 'freshness.nextDueAt': pastIso() })
await kb.reloadDocs()
await freshness.reload()
await freshness.sweepDue()
const tN = freshness.activeTicketOf(dNew.id)
assert(!!tN && tN.ruleSource === RULE_SOURCE.POLICY, '继承文档到期生成带策略快照的复核单')
assert(isDocCitable(await getDoc(dNew.id), tN, new Date()) === false, '到期后问答引用暂停')

// ---------- 7. 分类变更重解析（编辑保存 / 审批通过两条路径） ----------
console.log('\n[7] 文档改分类后按新分类重解析保鲜配置')
const dM = await kb.createDoc({ title: '迁移文档', categoryId: 'c-b', body: '<p>迁移</p>', visibility: 'public' }, editor)
assert(dM.freshness?.source === RULE_SOURCE.POLICY, '乙类新文档已继承')
r = await kb.updateDoc(dM.id, { categoryId: 'c-c' }, admin)
assert(r.status === 'saved', '编辑保存改分类成功')
const dM1 = await getDoc(dM.id)
assert(dM1.categoryId === 'c-c' && !dM1.freshness, '移入无策略分类：退出保鲜')
r = await kb.updateDoc(dM.id, { categoryId: 'c-b' }, admin)
const dM2 = await getDoc(dM.id)
assert(dM2.freshness?.source === RULE_SOURCE.POLICY && dM2.freshness.cycleDays === 90, '移回有策略分类：重新继承')
const dO = await mkDoc()
await freshness.setFreshCycle(dO.id, 30, owner)
await kb.updateDoc(dO.id, { categoryId: 'c-b' }, admin)
const dO1 = await getDoc(dO.id)
assert(dO1.freshness?.source === RULE_SOURCE.DOC && dO1.freshness.cycleDays === 30, '文档级覆盖改分类后保持不变')
// 审批通过改分类
const dR = await kb.createDoc({ title: '审批迁移', categoryId: 'c-b', body: '<p>审批</p>', visibility: 'public' }, editor)
const patch = { title: '审批迁移', body: '<p>审批 v2</p>', categoryId: 'c-c', tagIds: [], visibility: 'public' }
r = await review.submitReview(dR.id, patch, '改分类送审', editor)
assert(r.status === 'ok', '改分类评审发起成功')
r = await review.decideReview(r.review.id, 'approve', '', admin)
assert(r.status === 'ok', '审批通过')
const dR1 = await getDoc(dR.id)
assert(dR1.categoryId === 'c-c' && !dR1.freshness, '审批改分类到无策略分类：保鲜配置退出')

// ---------- 8. 负责人交接联动：策略重算可被并发校验检出 ----------
console.log('\n[8] 策略重算改变保鲜签名，交接并发校验可检出')
const dH = await kb.createDoc({ title: '交接文档', categoryId: 'c-b', body: '<p>交接</p>', visibility: 'public' }, editor)
const snap = handoverSnapshotOf(await getDoc(dH.id))
r = await freshness.setCategoryPolicy('c-b', 180, admin)
assert(r.status === 'ok' && r.applied >= 1, '策略调整重算继承文档')
const failures = checkHandoverConflicts(
  [{ docId: dH.id, title: dH.title, snapshot: snap }],
  { [dH.id]: await getDoc(dH.id) }
)
assert(failures.length === 1 && failures[0].fields.includes('保鲜配置已变化'), '交接期间策略重算被识别为并发变更（该篇回退保护）')

// ---------- 9. 已有逐篇配置迁移（v9） ----------
console.log('\n[9] 迁移：历史逐篇配置标记为文档级覆盖，复核单补规则快照')
const legacy = await mkDoc()
await db.docs.update(legacy.id, { freshness: { cycleDays: 30, nextDueAt: nowIso(), round: 0, activeTicket: null } })
await db.freshnessTickets.add({
  id: uid('fr'), docId: legacy.id, round: 1, status: FRESH.OPEN, cycleDays: 30,
  dueAt: pastIso(), reviewId: null, createdAt: nowIso(), timeline: []
})
const legacyTicket = (await db.freshnessTickets.where('docId').equals(legacy.id).toArray())[0]
await migrateFreshnessPolicyV9(db)
const lg = await getDoc(legacy.id)
assert(lg.freshness.source === RULE_SOURCE.DOC && lg.freshness.policyId === null, '历史逐篇配置迁移为文档级覆盖')
const lt = await db.freshnessTickets.get(legacyTicket.id)
assert(lt.ruleSource === RULE_SOURCE.DOC && lt.policyId === null, '历史复核单补规则来源快照')
// 迁移幂等且不误伤：继承配置与策略快照保持原样
const inh = await getDoc(dM.id)
assert(inh.freshness?.source === RULE_SOURCE.POLICY, '继承配置经迁移后仍为继承')
// 迁移后的覆盖文档不参与策略批量重算
r = await freshness.setCategoryPolicy('c-a', 90, admin)
const lg2 = await getDoc(legacy.id)
assert(lg2.freshness.cycleDays === 30 && r.kept >= 1, '迁移后的覆盖文档不被策略重算改写')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
