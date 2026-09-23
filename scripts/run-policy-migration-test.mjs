// 分类复核策略迁移与种子回归（fake-indexeddb）
// 覆盖：v8 老库（历史逐篇保鲜配置，无 source/ruleSource）升级 v9 自动迁移 →
//       全新安装种子 v7（分类策略演示数据：doc-9 继承、doc-4 文档级覆盖 + 在途快照）。
// 运行：npm run test:policy-migration
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

// localStorage 桩（seed 的 meta 依赖）
const mem = {}
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v) },
  removeItem: (k) => { delete mem[k] }
}

let passed = 0
let failed = 0
const assert = (c, m) => { if (c) { passed++; console.log('  ✅', m) } else { failed++; console.error('  ❌', m) } }

// ---- 1. 构造 v8 老库（含历史逐篇保鲜配置与复核单，无 source/ruleSource）----
class OldDB extends Dexie {
  constructor(name) {
    super(name)
    this.version(1).stores({
      users: 'id, name, role, email', categories: 'id, name', tags: 'id, name',
      docs: 'id, title, categoryId, visibility, ownerId, updatedAt, createdAt, *tagIds',
      comments: 'id, docId, authorId, createdAt', shares: 'id, docId, token',
      favorites: 'id, [userId+docId], docId', recentViews: 'id, [userId+docId], docId, viewedAt',
      ratings: 'id, [docId+slug]'
    })
    this.version(2).stores({ reviews: 'id, docId, status, submittedBy, submittedAt, decidedBy, decidedAt', comments: 'id, docId, authorId, createdAt, reviewId' })
    this.version(3).stores({ gapTickets: 'id, status, createdBy, claimedBy, docId, reviewId, createdAt' })
    this.version(4).stores({ accessRequests: 'id, docId, applicantId, status, requestedPermission, createdAt, decidedAt, expiresAt, revokedAt' })
    this.version(5).stores({ gapTickets: 'id, status, createdBy, claimedBy, docId, reviewId, groupId, createdAt' })
    this.version(6).stores({ freshnessTickets: 'id, docId, status, round, dueAt, createdAt' })
    this.version(7).stores({ handovers: 'id, status, fromUserId, toUserId, createdAt, decidedAt' })
    this.version(8).stores({ retirements: 'id, status, docId, replacementDocId, initiatedBy, decidedBy, createdAt, decidedAt' })
  }
}
const old = new OldDB('knowbase-mig')
await old.docs.add({
  id: 'doc-old', title: '老文档', categoryId: 'c-a', tagIds: [], visibility: 'public',
  ownerId: 'u1', editors: ['u1'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  freshness: { cycleDays: 30, nextDueAt: new Date().toISOString(), round: 1, activeTicket: 'fr-old' }
})
await old.freshnessTickets.add({
  id: 'fr-old', docId: 'doc-old', round: 1, status: 'open', cycleDays: 30,
  dueAt: new Date().toISOString(), createdAt: new Date().toISOString(), timeline: []
})
await old.close()

// ---- 2. 用当前 schema（v9）打开：升级迁移应自动执行 ----
const { db, KnowledgeDB } = await import('@/db')
const mig = new KnowledgeDB('knowbase-mig')
await mig.open()
assert(mig.freshnessPolicies !== undefined, 'v9 新增 freshnessPolicies 表')
const d = await mig.docs.get('doc-old')
assert(d.freshness.source === 'doc' && d.freshness.policyId === null, '老库逐篇配置迁移为文档级覆盖')
const t = await mig.freshnessTickets.get('fr-old')
assert(t.ruleSource === 'doc' && t.policyId === null, '老库复核单补规则来源快照')
await mig.close()

// ---- 3. 全新安装：种子跑到 v7，分类策略演示数据就位 ----
const { ensureSeeded } = await import('@/db/seed')
const fresh = new KnowledgeDB('knowbase-fresh-install')
// 把全局 db 指向新库不可行（模块单例），直接验证 ensureSeeded 用的是模块级 db——
// 改为验证默认库的完整种子流程
await ensureSeeded()
const pol = await db.freshnessPolicies.get('fp-1')
assert(!!pol && pol.categoryId === 'c-product' && pol.cycleDays === 180, '种子：产品设计分类策略 180 天已建立')
assert((pol.timeline || []).some((x) => x.action === 'policy-setting'), '种子：策略留痕完整')
const doc9 = await db.docs.get('doc-9')
assert(doc9.freshness?.source === 'policy' && doc9.freshness.policyId === 'fp-1' && doc9.freshness.cycleDays === 180, '种子：doc-9 继承分类策略')
const doc4 = await db.docs.get('doc-4')
assert(doc4.freshness?.source === 'doc' && doc4.freshness.cycleDays === 180 && doc4.freshness.activeTicket === 'fr-2', '种子：doc-4 保持文档级覆盖与在途复核单')
const fr2 = await db.freshnessTickets.get('fr-2')
assert(fr2.ruleSource === 'doc' && fr2.cycleDays === 180, '种子：在途复核单携带规则快照')
const doc8 = await db.docs.get('doc-8')
assert(doc8.freshness?.source === 'doc', '种子：既有逐篇配置标记为文档级覆盖')
await fresh.close()

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
