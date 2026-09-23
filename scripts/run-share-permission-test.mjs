// 共享链接管理权限：端到端安全回归（fake-indexeddb + 真实 store）
// 修复漏洞：普通查看者打开分享入口生成「可编辑」链接 → 访客持链接修改正文
// （分享管理 → 正文保存的权限升级）。
// 覆盖：访客禁止创建、只读成员/编辑者越权生成 edit 链接、view 链接边界、
//       拥有者/协作者/管理员/限时协作授权创建 edit、评审锁定与退役限制、
//       撤销资格（创建者/拥有者/管理员）、旧路径（直接调库）之外的访客保存链路。
// 运行：npm run test:share（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useShareStore } from '@/stores/share'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { uid, makeToken } from '@/utils/format'
import { ACCESS, ACCESS_PERM } from '@/utils/access'
import { REVIEW, PUBLISH } from '@/utils/review'
import { RETIRE } from '@/utils/retirement'
import {
  canEditDoc, canCreateShare, canRevokeShare, GUEST_ID, ROLE
} from '@/utils/permission'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const shareStore = useShareStore(pinia)
const review = useReviewStore(pinia)
const access = useAccessStore(pinia)

const guest = null
const viewer = { id: 'u-view', role: ROLE.VIEWER, name: '只读甲' }
const viewer2 = { id: 'u-view2', role: ROLE.VIEWER, name: '只读乙' }
const editor = { id: 'u-edit', role: ROLE.EDITOR, name: '编辑甲' }
const editor2 = { id: 'u-edit2', role: ROLE.EDITOR, name: '编辑乙' }
const admin = { id: 'u-admin', role: ROLE.ADMIN, name: '管理员' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

const now = new Date().toISOString()
async function mkDoc(owner = editor2, extra = {}) {
  const d = {
    id: uid('doc'), title: '文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>正文</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: now, updatedAt: now,
    versions: [{ version: 1, savedAt: now, savedBy: owner.id, note: '初始' }],
    ...extra
  }
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}

async function mkGrant(docId, applicant, permission) {
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString()
  const req = {
    id: uid('acc'), docId, applicantId: applicant.id, status: ACCESS.APPROVED,
    requestedPermission: permission, reason: '', createdAt: now,
    decidedBy: 'u-admin', decidedAt: now, decisionNote: '',
    expiresAt, revokedAt: null,
    grant: { permission, grantedAt: now, expiresAt, revokedAt: null },
    timeline: []
  }
  await db.accessRequests.add(req)
  await access.reload()
  return req
}

const patch = (d) => ({ title: d.title, body: '<p>新正文</p>', categoryId: d.categoryId, tagIds: [], visibility: d.visibility })

// ---------- 1. 纯函数：canCreateShare 权限不超过自身权限 ----------
console.log('\n[1] canCreateShare：链接权限 ≤ 创建者自身权限')
const d1 = await mkDoc(editor2, { visibility: 'private' })
assert(canCreateShare(d1, 'edit', {}) === false, '访客（无 userId）不能生成 edit 链接')
assert(canCreateShare(d1, 'view', {}) === false, '访客不能生成任何共享链接')
assert(canCreateShare(d1, 'edit', { userId: viewer.id, role: ROLE.VIEWER }) === false, '只读成员不能给他人私有文档生成 edit 链接')
assert(canCreateShare(d1, 'view', { userId: viewer.id, role: ROLE.VIEWER }) === false, '无查看资格者也不能生成 view 链接（私有文档）')
assert(canCreateShare(d1, 'edit', { userId: editor2.id, role: ROLE.EDITOR }) === true, '拥有者可生成 edit 链接')
assert(canCreateShare(d1, 'edit', { userId: admin.id, role: ROLE.ADMIN }) === true, '管理员可生成 edit 链接')

// 限时协作授权：持协作授权的只读成员可生成 edit；持阅读授权只能生成 view
const g1 = await mkGrant(d1.id, viewer, ACCESS_PERM.COLLAB)
assert(canCreateShare(d1, 'edit', { userId: viewer.id, role: ROLE.VIEWER, grant: g1 }) === true, '持限时协作授权可生成 edit 链接')
const g2 = await mkGrant(d1.id, viewer2, ACCESS_PERM.READ)
assert(canCreateShare(d1, 'edit', { userId: viewer2.id, role: ROLE.VIEWER, grant: g2 }) === false, '限时阅读授权不能生成 edit 链接')
assert(canCreateShare(d1, 'view', { userId: viewer2.id, role: ROLE.VIEWER, grant: g2 }) === true, '限时阅读授权可生成 view 链接')
assert(canCreateShare(d1, 'weird', { userId: admin.id, role: ROLE.ADMIN }) === false, '非法权限类型拒绝')

// 评审锁定 / 退役限制
assert(canCreateShare(d1, 'edit', { userId: editor2.id, role: ROLE.EDITOR, pendingReview: { id: 'rv' } }) === false, '评审锁定中（非管理员）不能生成 edit 链接')
assert(canCreateShare(d1, 'edit', { userId: admin.id, role: ROLE.ADMIN, pendingReview: { id: 'rv' } }) === true, '管理员不受评审锁定限制')
const retiredDoc = { ...d1, retirement: { status: RETIRE.APPROVED } }
assert(canCreateShare(retiredDoc, 'view', { userId: editor2.id, role: ROLE.EDITOR }) === false, '已退役文档不能再生成任何共享链接')

// ---------- 2. store：访客 / 只读成员 / 编辑者越权创建均被事务拒绝 ----------
console.log('\n[2] store 事务内拦截越权创建（核心漏洞链路）')
const d2 = await mkDoc(editor2)
let before = await db.shares.where('docId').equals(d2.id).count()
let r = await shareStore.createShare(d2.id, 'edit', 0, guest)
assert(r.status === 'guest', '访客生成 edit 链接被拒（guest）')
r = await shareStore.createShare(d2.id, 'edit', 0, viewer)
assert(r.status === 'denied', '只读成员（公开文档仅查看）生成 edit 链接被拒（denied）')
r = await shareStore.createShare(d2.id, 'edit', 0, editor)
assert(r.status === 'denied', '编辑甲（与编辑乙的文档无关）生成 edit 链接被拒')
r = await shareStore.createShare(d2.id, 'view', 0, viewer)
assert(r.status === 'ok', '只读成员仍可生成 view 链接（权限不超过自身）')
const after = await db.shares.where('docId').equals(d2.id).count()
assert(after === before + 1, '拒绝的创建未落库，仅 view 链接写入成功')

// 漏洞链路验证：只读成员无法通过分享管理让访客获得正文写权限
const viewLink = (await db.shares.where('docId').equals(d2.id).toArray())[0]
assert(viewLink.permission === 'view', '只读成员创建的链接确为 view，访客无法据此写正文')
r = await kb.updateDoc(d2.id, { body: '<p>访客改</p>' }, guest, '共享编辑', { shareToken: viewLink.token })
assert(r.status === 'guest', '访客持该 view 链接保存被拒，正文未被升级写入')
assert((await db.docs.get(d2.id)).body === '<p>正文</p>', '文档正文保持不变')

// ---------- 3. store：合法身份可生成 edit 链接，访客凭证链仍有效 ----------
console.log('\n[3] 拥有者/固定协作成员/管理员/限时协作者可生成 edit 链接')
const d3 = await mkDoc(editor2, { editors: [editor2.id, editor.id] })
r = await shareStore.createShare(d3.id, 'edit', 7, editor)
assert(r.status === 'ok' && r.share.permission === 'edit', '固定协作成员可生成 edit 链接（7 天有效）')
assert(r.share.createdBy === editor.id && !!r.share.token && !!r.share.expiresAt && !r.share.revokedAt, '链接字段完整：创建者/token/到期时间')
r = await kb.updateDoc(d3.id, { body: '<p>访客改</p>' }, guest, '共享编辑', { shareToken: r.share.token })
assert(r.status === 'saved', '访客持合法 edit 链接保存成功（凭证链本身保持可用）')

const d3b = await mkDoc(editor2)
r = await shareStore.createShare(d3b.id, 'edit', 0, admin)
assert(r.status === 'ok', '管理员可为任意文档生成 edit 链接')

const d3c = await mkDoc(editor2, { visibility: 'private' })
await mkGrant(d3c.id, viewer, ACCESS_PERM.COLLAB)
r = await shareStore.createShare(d3c.id, 'edit', 0, viewer)
assert(r.status === 'ok', '持限时协作授权的只读成员可生成 edit 链接')
// 授权撤销后立即失去创建资格
const req = await db.accessRequests.where('docId').equals(d3c.id).filter((x) => x.applicantId === viewer.id).first()
await db.accessRequests.update(req.id, { revokedAt: now, 'grant.revokedAt': now })
await access.reload()
r = await shareStore.createShare(d3c.id, 'edit', 0, viewer)
assert(r.status === 'denied', '协作授权撤销后再生成 edit 链接被拒')

r = await shareStore.createShare('no-such-doc', 'view', 0, editor)
assert(r.status === 'missing', '文档不存在返回 missing')

// ---------- 4. 评审锁定 / 退役：store 以库中最新状态复核 ----------
console.log('\n[4] 评审锁定与退役文档的创建拦截')
const d4 = await mkDoc(editor2)
r = await review.submitReview(d4.id, patch(d4), '送审', editor2)
assert(r.status === 'ok', '拥有者对文档发起评审')
r = await shareStore.createShare(d4.id, 'edit', 0, editor2)
assert(r.status === 'denied', '评审锁定中拥有者不能生成 edit 链接（防多窗口绕过）')
r = await shareStore.createShare(d4.id, 'view', 0, editor2)
assert(r.status === 'ok', '评审锁定中仍可生成 view 链接（只读不冲突）')
r = await shareStore.createShare(d4.id, 'edit', 0, admin)
assert(r.status === 'ok', '管理员不受评审锁定限制')

const d4b = await mkDoc(editor2)
await db.docs.update(d4b.id, { retirement: { status: RETIRE.APPROVED, docId: d4b.id } })
r = await shareStore.createShare(d4b.id, 'view', 0, editor2)
assert(r.status === 'denied', '已退役文档不能再生成 view 链接')

// ---------- 5. 撤销资格：仅创建者 / 拥有者 / 管理员 ----------
console.log('\n[5] 撤销共享链接的身份边界')
const d5 = await mkDoc(editor2)
const ownerShare = (await shareStore.createShare(d5.id, 'view', 0, editor2)).share
const viewerShare = (await shareStore.createShare(d5.id, 'view', 0, viewer)).share

assert(canRevokeShare(ownerShare, d5, viewer.id, ROLE.VIEWER) === false, '纯函数：只读成员不能撤销他人链接')
assert(canRevokeShare(ownerShare, d5, editor2.id, ROLE.EDITOR) === true, '纯函数：拥有者可撤销')
assert(canRevokeShare(ownerShare, d5, admin.id, ROLE.ADMIN) === true, '纯函数：管理员可撤销')
assert(canRevokeShare(viewerShare, d5, viewer.id, ROLE.VIEWER) === true, '纯函数：创建者本人可撤销')
assert(canRevokeShare(viewerShare, d5, GUEST_ID, null) === false, '纯函数：访客不能撤销')

r = await shareStore.revokeShare(ownerShare.id, viewer)
assert(r.status === 'denied', '只读成员撤销拥有者链接被拒')
assert(!(await db.shares.get(ownerShare.id)).revokedAt, '越权撤销未改链接状态')
r = await shareStore.revokeShare(ownerShare.id, guest)
assert(r.status === 'guest', '访客撤销被拒')
r = await shareStore.revokeShare(ownerShare.id, editor)
assert(r.status === 'denied', '其他协作编辑者不能撤销（非创建者/非拥有者/非管理员）')
r = await shareStore.revokeShare(ownerShare.id, editor2)
assert(r.status === 'ok', '拥有者撤销成功')
r = await shareStore.revokeShare(ownerShare.id, editor2)
assert(r.status === 'closed', '重复撤销返回 closed')
r = await shareStore.revokeShare(viewerShare.id, viewer)
assert(r.status === 'ok', '创建者本人撤销成功')
r = await shareStore.revokeShare(uid('share'), admin)
assert(r.status === 'missing', '链接不存在返回 missing')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
