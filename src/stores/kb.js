import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions, mergeDocFields, docSnapshot } from '@/utils/version'
import { buildTimelineEntry } from '@/utils/review'
import { GAP } from '@/utils/gap'
import { isGrantActive, ACCESS_PERM } from '@/utils/access'
import { canEditContent, canEditDoc, canDeleteDoc, GUEST_ID } from '@/utils/permission'
import { isDocOverride, isFreshTicketOpen, materializeFromPolicy } from '@/utils/freshness'
import { useAuthStore } from './auth'
import { useGapStore } from './gap'

export const useKbStore = defineStore('kb', () => {
  const docs = ref([])
  const categories = ref([])
  const tags = ref([])
  const comments = ref([])
  const loaded = ref(false)

  const catMap = computed(() => Object.fromEntries(categories.value.map((c) => [c.id, c])))
  const tagMap = computed(() => Object.fromEntries(tags.value.map((t) => [t.id, t])))

  async function loadAll() {
    if (loaded.value) return
    docs.value = await db.docs.toArray()
    categories.value = await db.categories.toArray()
    tags.value = await db.tags.toArray()
    comments.value = await db.comments.toArray()
    loaded.value = true
  }

  async function reloadDocs() {
    docs.value = await db.docs.toArray()
  }

  async function getDoc(id) {
    await loadAll()
    return docs.value.find((d) => d.id === id) || null
  }

  // 直接读库取最新文档，绕过内存缓存——编辑器打开文档、保存前校验时必须用最新数据，
  // 否则多窗口场景会基于过期快照判断，造成覆盖与版本记录丢失
  async function getDocFresh(id) {
    await loadAll()
    const fresh = await db.docs.get(id)
    return fresh || null
  }

  async function createDoc(payload, currentUser) {
    await loadAll()
    // 新建文档属于内容发布：访客与只读角色无写入资格（路由层已拦一次，store 兜底防直接调用）
    if (!currentUser?.id || currentUser.id === GUEST_ID || !canEditContent(currentUser.role)) {
      return { status: 'forbidden' }
    }
    const now = new Date().toISOString()
    const doc = {
      id: uid('doc'),
      title: payload.title || '无标题文档',
      categoryId: payload.categoryId || categories.value[0]?.id || null,
      tagIds: payload.tagIds || [],
      body: payload.body || '',
      visibility: payload.visibility || 'public',
      publishState: 'published',
      activeReviewId: null,
      ownerId: currentUser?.id || 'u-guest',
      editors: [currentUser?.id || 'u-guest'],
      createdAt: now,
      updatedAt: now,
      versions: [{ version: 1, savedAt: now, savedBy: currentUser?.id || 'u-guest', note: '创建文档', snapshot: docSnapshot(payload) }]
    }
    // 分类设有复核策略时新文档自动继承（物化为 source='policy'，后续随策略批量重算）
    const policy = doc.categoryId ? await db.freshnessPolicies.where('categoryId').equals(doc.categoryId).first() : null
    if (policy) doc.freshness = materializeFromPolicy(policy, null, now)
    await db.docs.add(doc)
    await reloadDocs()
    return doc
  }

  // 保存文档（乐观锁 + 三方合并）。
  // opts.baseVersion：编辑器打开文档时的版本号；保存时若库中版本更高，说明其他窗口已保存过
  // opts.base：编辑器打开时的字段快照，用于三方合并（只自动合并未被对方改动的字段）
  // opts.force：用户确认「以我的内容为准」时强制保存，冲突字段取本次提交值
  // opts.shareToken：共享链接编辑入口必须携带；store 据此复核链接仍有效且为 edit，
  //   未携带凭证的写入一律视为无资格，防止访客/只读成员直接调用 store 写入。
  // 返回 { status: 'saved', doc, autoMerged } | { status: 'conflict', conflictFields, autoMerged, latest }
  //      | { status: 'missing' } | { status: 'review-locked' | 'access-denied', latest }
  async function updateDoc(id, patch, currentUser, note, opts = {}) {
    await loadAll()
    const now = new Date().toISOString()
    const savedBy = currentUser?.id || GUEST_ID
    const isGuest = savedBy === GUEST_ID
    let result = null
    // 读 + 写放在同一事务中，保证「权限/版本检测 → 合并 → 追加版本记录」不被其他窗口的写入打断
    await db.transaction('rw', db.docs, db.accessRequests, db.shares, db.reviews, db.freshnessTickets, db.freshnessPolicies, async () => {
      const existing = await db.docs.get(id)
      if (!existing) { result = { status: 'missing' }; return }
      // 事务内重读评审状态：评审中锁定仅管理员可直接写（管理员并发修改通道），
      // 访客借共享链接、只读成员、限时协作者在锁定期一律拒绝（防止多窗口绕过页面锁定）
      const pendingReview = await db.reviews
        .where('docId').equals(id)
        .filter((rv) => rv.status === 'pending').first()
      // 限时协作授权：以库中最新申请记录判定，撤销/到期保存时立即收回
      let grant = null
      if (!isGuest) {
        const grantReq = await db.accessRequests
          .where('docId').equals(id)
          .filter((r) => r.applicantId === savedBy).toArray()
        grant = grantReq.find((r) => isGrantActive(r) && r.grant?.permission === ACCESS_PERM.COLLAB) || null
      }
      // 共享链接凭证：仅当入口显式携带 token 时才复核（普通成员/管理员保存不依赖链接）
      let share = null
      if (opts.shareToken) {
        share = await db.shares.where('token').equals(opts.shareToken).first() || null
        if (!share || share.docId !== id) share = null
      }
      if (!canEditDoc(existing, {
        userId: savedBy,
        role: currentUser?.role,
        grant,
        share,
        pendingReview
      })) {
        // 拒绝原因区分优先级：评审锁定（含访客借链接写入）→ 访客无凭证 → 其余无资格
        if (pendingReview && currentUser?.role !== 'admin') {
          result = { status: 'review-locked', latest: existing }
        } else if (isGuest) {
          result = { status: 'guest', latest: existing }
        } else {
          result = { status: 'access-denied', latest: existing }
        }
        return
      }
      // 兼容已有文档：缺失的版本记录先补全，再在其后追加，历史版本永不丢弃
      const versions = ensureVersions(existing, now)
      const currentVersion = versions.length
      const hasConflict = opts.baseVersion != null && currentVersion > opts.baseVersion

      let fields = patch
      let autoMerged = []
      if (hasConflict) {
        if (!opts.base) {
          // 没有基线快照无法安全合并，除非强制保存，否则返回冲突由调用方决定
          if (!opts.force) {
            result = { status: 'conflict', conflictFields: Object.keys(patch), autoMerged, latest: existing }
            return
          }
        } else {
          const merge = mergeDocFields(existing, opts.base, patch)
          autoMerged = merge.autoMerged
          if (merge.conflicts.length && !opts.force) {
            result = { status: 'conflict', conflictFields: merge.conflicts, autoMerged, latest: existing }
            return
          }
          fields = merge.fields
          // 用户选择以本次提交为准：冲突字段强制采用我方值，其余字段仍是合并结果
          if (opts.force) for (const k of merge.conflicts) fields[k] = patch[k]
        }
      }

      // 分类变更：无文档级覆盖的文档按新分类策略重解析保鲜配置（新分类无策略则退出保鲜）；
      // 有在途复核单时跳过——当轮按规则快照执行，结案时由保鲜联动按新分类策略重算
      if (fields.categoryId && fields.categoryId !== existing.categoryId && !isDocOverride(existing.freshness)) {
        const openFresh = await db.freshnessTickets
          .where('docId').equals(id)
          .filter((t) => isFreshTicketOpen(t)).first()
        if (!openFresh) {
          const pol = await db.freshnessPolicies.where('categoryId').equals(fields.categoryId).first()
          fields = { ...fields, freshness: pol ? materializeFromPolicy(pol, existing.freshness, now) : null }
        }
      }

      const versionNote = autoMerged.length
        ? (note || '编辑文档') + '（自动合并：' + autoMerged.join('、') + '）'
        : (note || '编辑文档')
      const updated = {
        ...existing,
        ...fields,
        updatedAt: now,
        // 版本记录升级为内容快照：保存后的完整字段随版本留档，供历史对比与恢复评审使用
        versions: [...versions, { version: currentVersion + 1, savedAt: now, savedBy, note: versionNote, snapshot: docSnapshot({ ...existing, ...fields }) }]
      }
      await db.docs.put(updated)
      result = { status: 'saved', doc: updated, autoMerged }
    })
    await reloadDocs()
    return result
  }

  // 删除文档为破坏性操作：仅拥有者/固定协作成员/管理员可执行（限时协作授权与共享链接不授予删除权）；
  // 访客、评审中（非管理员）同样拒绝。返回 { status: 'ok' | 'forbidden' | 'missing' }
  async function deleteDoc(id, currentUser) {
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'ok' }
    await db.transaction('rw', db.docs, db.comments, db.shares, db.reviews, db.accessRequests, db.gapTickets, db.freshnessTickets, db.retirements, async () => {
      const doc = await db.docs.get(id)
      if (!doc) { result = { status: 'missing' }; return }
      const pendingReview = await db.reviews
        .where('docId').equals(id)
        .filter((rv) => rv.status === 'pending').first()
      // 知识退役：已退役文档为只读归档不可删除；流转中退役单/作为他人替代文档的也先处理退役再删除，
      // 避免产生悬挂退役记录或让生效退役失去替代目标
      const activeRetirement = doc.retirement?.status === 'approved' ? doc.retirement : null
      const openRetirement = await db.retirements.filter((rt) => rt.docId === id && rt.status === 'pending').first()
      // 作为他人退役替代文档：生效单必须先撤销退役，在途单必须先完成/取消，避免替代链断裂
      const usedAsReplacement = await db.retirements
        .filter((rt) => (rt.status === 'approved' || rt.status === 'pending') && rt.replacementDocId === id).first()
      if (!canDeleteDoc(doc, { userId, role: currentUser?.role, pendingReview, activeRetirement })) {
        result = { status: 'forbidden' }
        return
      }
      if (openRetirement) { result = { status: 'in-retirement' }; return }
      if (usedAsReplacement) { result = { status: 'is-replacement' }; return }
      await db.docs.delete(id)
      await db.comments.where('docId').equals(id).delete()
      await db.shares.where('docId').equals(id).delete()
      // 评审单随文档一并清理（直接按索引删除，避免与 review store 循环依赖）
      await db.reviews.where('docId').equals(id).delete()
      // 访问申请/授权随文档一并清理（授权失去依附对象，详情、搜索、问答、编辑入口同步消失）
      await db.accessRequests.where('docId').equals(id).delete()
      // 知识保鲜复核单随文档一并清理（复核周期与复核单失去依附对象）
      await db.freshnessTickets.where('docId').equals(id).delete()
      // 关联该文档的缺口工单退回处理中：答案来源/送审关联随文档删除失效，需重新关联
      const now = new Date().toISOString()
      const linkedTickets = await db.gapTickets.where('docId').equals(id).toArray()
      for (const t of linkedTickets) {
        await db.gapTickets.update(t.id, {
          status: GAP.CLAIMED,
          docId: null,
          reviewId: null,
          resolvedAt: null,
          timeline: [...(t.timeline || []), buildTimelineEntry('reset', 'system', '关联文档已删除，工单退回处理', now)]
        })
      }
    })
    comments.value = comments.value.filter((c) => c.docId !== id)
    const gap = useGapStore()
    const { useFreshnessStore } = await import('./freshness')
    const freshness = useFreshnessStore()
    await Promise.all([reloadDocs(), gap.reload(), freshness.loaded ? freshness.reload() : Promise.resolve()])
    return result
  }

  // 普通文档评论：登录成员可发表（访客不可）。返回评论对象或 { status: 'forbidden' }
  async function addComment(docId, content, mentionIds, authorId) {
    if (!authorId || authorId === GUEST_ID) return { status: 'forbidden' }
    const cmt = { id: uid('cmt'), docId, authorId, content, mentionIds: mentionIds || [], createdAt: new Date().toISOString() }
    await db.comments.add(cmt)
    comments.value.push(cmt)
    return cmt
  }

  async function addCategory(name, icon) {
    const cat = { id: uid('c'), name, icon: icon || 'doc' }
    await db.categories.add(cat)
    categories.value.push(cat)
    return cat
  }

  async function addTag(name, color) {
    const tag = { id: uid('t'), name, color: color || '#4f6ef7' }
    await db.tags.add(tag)
    tags.value.push(tag)
    return tag
  }

  function commentsOf(docId) {
    return comments.value
      .filter((c) => c.docId === docId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  return {
    docs, categories, tags, comments, loaded,
    catMap, tagMap, loadAll, reloadDocs, getDoc, getDocFresh, createDoc, updateDoc, deleteDoc,
    addCategory, addTag, addComment, commentsOf
  }
})