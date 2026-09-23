// 限时授权失效统一处理：端到端回归（fake-indexeddb + 真实 store）
// 覆盖：授权到期不刷新页面即失效（响应式时钟 + 到期调度器驱动 activeGrantMap 重算）、
//       撤销即时生效、到期留痕补录、长期授权不受短期到期调度影响、
//       详情/搜索/问答统一入口 grantOf 同步收回受限内容。
// 运行：npm run test:access（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAccessStore } from '@/stores/access'
import { uid } from '@/utils/format'
import { ACCESS, ACCESS_PERM } from '@/utils/access'
import { canViewDoc } from '@/utils/permission'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const access = useAccessStore(pinia)

const owner = { id: 'u-owner', role: 'editor', name: '拥有者' }
const viewer = { id: 'u-view', role: 'viewer', name: '只读甲' }
const viewer2 = { id: 'u-view2', role: 'viewer', name: '只读乙' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = new Date().toISOString()

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '受限文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>受限正文</p>', categoryId: 'c', tagIds: [], visibility: 'private',
    ownerId: owner.id, editors: [owner.id], publishState: 'published', activeReviewId: null,
    createdAt: nowIso, updatedAt: nowIso,
    versions: [{ version: 1, savedAt: nowIso, savedBy: owner.id, note: '初始' }],
    ...extra
  }
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}

// 直接落库一条已通过的授权（模拟审批通过后的记录），并刷新 store 触发到期调度
async function mkGrant(docId, applicant, permission, expiresAt) {
  const req = {
    id: uid('acc'), docId, applicantId: applicant.id, status: ACCESS.APPROVED,
    requestedPermission: permission, reason: '', createdAt: nowIso,
    decidedBy: owner.id, decidedAt: nowIso, decisionNote: '',
    expiresAt, revokedAt: null,
    grant: { permission, grantedAt: nowIso, expiresAt, revokedAt: null },
    timeline: []
  }
  await db.accessRequests.add(req)
  await access.reload()
  return req
}

// ---------- 1. 有效期内：统一入口可见 ----------
console.log('\n[1] 授权有效期内可访问')
const d1 = await mkDoc()
const g1 = await mkGrant(d1.id, viewer, ACCESS_PERM.READ, new Date(Date.now() + 7 * 86400000).toISOString())
assert(access.grantOf(d1.id, viewer.id)?.id === g1.id, 'grantOf 返回有效授权')
assert(canViewDoc(d1, viewer.id, null, access.grantOf(d1.id, viewer.id)) === true, 'canViewDoc 放行（详情/搜索/问答可见）')
assert(access.activeGrantFor(d1.id, viewer.id)?.id === g1.id, 'activeGrantFor 默认走统一时钟')

// ---------- 2. 撤销：不刷新页面即收回 ----------
console.log('\n[2] 撤销授权后统一入口即时失效')
await access.revokeGrant(g1.id, '收回', owner)
assert(access.grantOf(d1.id, viewer.id) === null, '撤销后 grantOf 立即为 null（无需重新加载）')
assert(canViewDoc(d1, viewer.id, null, access.grantOf(d1.id, viewer.id)) === false, '撤销后 canViewDoc 关闭')
const revoked = await db.accessRequests.get(g1.id)
assert(revoked.status === ACCESS.REVOKED && revoked.grant.revokedAt, '撤销留痕：状态与 grant.revokedAt 已落库')

// ---------- 3. 到期：页面停留期间自动失效（核心回归） ----------
console.log('\n[3] 限时授权到期后自动收回（不刷新、不重新加载）')
const d2 = await mkDoc()
await mkGrant(d2.id, viewer, ACCESS_PERM.READ, new Date(Date.now() + 300).toISOString())
assert(access.grantOf(d2.id, viewer.id) !== null, '到期前 grantOf 有效')
assert(canViewDoc(d2, viewer.id, null, access.grantOf(d2.id, viewer.id)) === true, '到期前详情可读')
// 页面停留，不发生任何 reload / 路由切换 / 用户操作，等待调度器推进统一时钟
await sleep(900)
assert(access.grantOf(d2.id, viewer.id) === null, '到期后 grantOf 自动失效（时钟调度驱动，无需刷新）')
assert(canViewDoc(d2, viewer.id, null, access.grantOf(d2.id, viewer.id)) === false, '到期后 canViewDoc 同步关闭（详情/搜索/问答统一收回）')
assert(access.activeGrantFor(d2.id, viewer.id) === null, '到期后 activeGrantFor 同步失效')

// ---------- 4. 到期留痕：调度器触发 sweep 补录 ----------
console.log('\n[4] 到期留痕')
const expiredReq = await db.accessRequests.get((await db.accessRequests.where('docId').equals(d2.id).first()).id)
assert((expiredReq.timeline || []).some((t) => t.action === 'expire'), '到期后 timeline 补录「到期收回」留痕')
assert(expiredReq.status === ACCESS.APPROVED, '到期为惰性判定：记录状态保持 approved')

// ---------- 5. 长期授权不受短期到期调度影响 ----------
console.log('\n[5] 混合有效期：短期到点不影响长期授权')
const d3 = await mkDoc()
await mkGrant(d3.id, viewer, ACCESS_PERM.READ, new Date(Date.now() + 300).toISOString())
await mkGrant(d3.id, viewer2, ACCESS_PERM.COLLAB, new Date(Date.now() + 7 * 86400000).toISOString())
assert(access.grantOf(d3.id, viewer2.id) !== null, '长期授权到期前有效')
await sleep(900)
assert(access.grantOf(d3.id, viewer.id) === null, '短期授权到点自动失效')
assert(access.grantOf(d3.id, viewer2.id) !== null, '长期授权不受短期到期调度影响，仍然有效')

// ---------- 6. 新审批的长期授权会重排调度器 ----------
console.log('\n[6] 调度器重排：新增授权后到期调度仍准确')
const d4 = await mkDoc()
await mkGrant(d4.id, viewer, ACCESS_PERM.READ, new Date(Date.now() + 400).toISOString())
await sleep(1000)
assert(access.grantOf(d4.id, viewer.id) === null, '重排后短期授权仍按点到失效')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
