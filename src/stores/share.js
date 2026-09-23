import { defineStore } from 'pinia'
import { db } from '@/db'
import { uid, makeToken } from '@/utils/format'
import { canCreateShare, canRevokeShare, GUEST_ID } from '@/utils/permission'
import { ACCESS_PERM } from '@/utils/access'

// 共享链接 store：链接的创建与撤销统一收口于此。
// 修复「分享管理 → 正文保存」权限升级：此前 ShareDialog 直接 db.shares.add，
// 只读查看者/访客可生成「可编辑」链接，访客再持链接修改正文。
// 现在创建/撤销都在事务内以库中最新文档、评审、授权与退役状态复核资格
// （链接授予的权限不得超过创建者自身权限），仅靠前端隐藏入口或直接调用库均无法绕过。
export const useShareStore = defineStore('share', () => {
  // 生成共享链接。permission: 'view' | 'edit'；expireDays: 0 表示永久有效。
  // 返回 { status: 'ok', share } | { status: 'guest' | 'denied' | 'bad-permission' | 'missing' }
  async function createShare(docId, permission, expireDays, currentUser) {
    if (permission !== 'view' && permission !== 'edit') return { status: 'bad-permission' }
    const userId = currentUser?.id
    if (!userId || userId === GUEST_ID) return { status: 'guest' }
    const now = new Date()
    const nowIso = now.toISOString()
    let result = { status: 'error' }
    await db.transaction('rw', db.docs, db.shares, db.reviews, db.accessRequests, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      // 事务内重读评审与限时授权：评审锁定/授权撤销后创建资格立即按最新状态判定
      const pendingReview = await db.reviews
        .where('docId').equals(docId)
        .filter((rv) => rv.status === 'pending').first()
      const grantReqs = await db.accessRequests
        .where('docId').equals(docId)
        .filter((r) => r.applicantId === userId).toArray()
      const grant = grantReqs.find((r) => r.status === 'approved' && !r.revokedAt) || null
      // 已退役文档为只读归档（退役时已批量撤销链接），归档期间不再生成新链接
      const activeRetirement = doc.retirement?.status === 'approved' ? doc.retirement : null
      if (!canCreateShare(doc, permission, {
        userId,
        role: currentUser?.role,
        grant,
        pendingReview,
        activeRetirement,
        now
      })) {
        result = { status: 'denied' }
        return
      }
      const share = {
        id: uid('share'),
        docId,
        token: makeToken(),
        permission,
        createdBy: userId,
        createdAt: nowIso,
        expiresAt: expireDays > 0 ? new Date(now.getTime() + expireDays * 86400000).toISOString() : null,
        revokedAt: null
      }
      await db.shares.add(share)
      result = { status: 'ok', share }
    })
    return result
  }

  // 撤销共享链接：仅创建者本人 / 文档拥有者 / 管理员（事务内复核，标记状态而非删除）。
  // 返回 { status: 'ok' } | { status: 'guest' | 'denied' | 'missing' | 'doc-missing' | 'closed' }
  async function revokeShare(shareId, currentUser) {
    const userId = currentUser?.id
    if (!userId || userId === GUEST_ID) return { status: 'guest' }
    let result = { status: 'error' }
    await db.transaction('rw', db.shares, db.docs, async () => {
      const share = await db.shares.get(shareId)
      if (!share) { result = { status: 'missing' }; return }
      if (share.revokedAt) { result = { status: 'closed' }; return }
      const doc = await db.docs.get(share.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }
      if (!canRevokeShare(share, doc, userId, currentUser?.role)) {
        result = { status: 'denied' }
        return
      }
      await db.shares.update(shareId, { revokedAt: new Date().toISOString() })
      result = { status: 'ok' }
    })
    return result
  }

  // 文档的共享链接列表（创建时间倒序，供分享管理弹窗展示）
  async function listSharesOfDoc(docId) {
    const rows = await db.shares.where('docId').equals(docId).toArray()
    return rows.reverse()
  }

  return { createShare, revokeShare, listSharesOfDoc }
})
