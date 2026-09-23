import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions, docSnapshot, diffVersionFields, applyRestoreBoundary, restoreRollbackInfo } from '@/utils/version'
import { REVIEW, PUBLISH, buildTimelineEntry, canSubmitReview, canReviewDecision } from '@/utils/review'
import { GAP } from '@/utils/gap'
import { canEditContent, GUEST_ID } from '@/utils/permission'
import { isGrantActive, ACCESS_PERM } from '@/utils/access'
import { isFreshReview, isFreshNoChangeReview } from '@/utils/review'
import { isDocOverride, materializeFromPolicy, isFreshTicketOpen } from '@/utils/freshness'
import { useKbStore } from './kb'
import { useGapStore } from './gap'
import { useFreshnessStore } from './freshness'

// 知识文档评审流程 store：
// 发起（快照待审内容、文档置为评审中并锁定）→ 成员发表评审意见 →
// 管理员通过（回写正文/可见性、追加带审批标记的版本）或驳回（解除锁定，内容不变）→
// 全程在评审单 timeline 与评审意见中留痕。
// 缺口工单送审（submitGapReview）：建评审单、锁文档、工单关联在同一事务内完成，
// 与审批/撤回事务互斥，不会出现「评审已完结但工单未关联」的卡单或孤立评审单。
// 评审单若由缺口工单发起（gapTickets.reviewId 关联），审批结果在同一事务内联动工单：
// 通过 → 工单置为已解决并回填答案来源；驳回/撤回 → 工单退回处理中。
export const useReviewStore = defineStore('review', () => {
  const reviews = ref([])
  const loaded = ref(false)

  // 事务内查询用户在文档上的有效限时协作授权（送审资格随撤销/到期即时收回）。
  // 必须在事务回调内以同一 Dexie 实例查询：直接在事务中 await db.table 会自动加入当前事务
  async function findCollabGrant(docId, userId) {
    if (!userId || userId === GUEST_ID) return null
    const reqs = await db.accessRequests
      .where('docId').equals(docId)
      .filter((r) => r.applicantId === userId).toArray()
    return reqs.find((r) => isGrantActive(r) && r.grant?.permission === ACCESS_PERM.COLLAB) || null
  }

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    reviews.value = await db.reviews.toArray()
  }

  // 文档当前流转中的评审单（同一文档同时只允许一个）
  const pendingByDoc = computed(() => {
    const m = {}
    for (const r of reviews.value) {
      if (r.status === REVIEW.PENDING) m[r.docId] = r
    }
    return m
  })

  function pendingReviewOf(docId) {
    return pendingByDoc.value[docId] || null
  }

  function reviewsOfDoc(docId) {
    return reviews.value
      .filter((r) => r.docId === docId)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
  }

  // 评审单下的意见（按时间正序）
  function commentsOfReview(reviewId) {
    const kb = useKbStore()
    return kb.comments
      .filter((c) => c.reviewId === reviewId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  // 构造待审批评审单：snapshot 为本次提交待审批的字段快照，审批通过时据此回写，保证「先审后发」
  function buildReviewRecord(docId, patch, note, userId, now, baseVersion) {
    return {
      id: uid('rev'),
      docId,
      status: REVIEW.PENDING,
      submittedBy: userId,
      submittedAt: now,
      snapshot: {
        title: patch.title,
        body: patch.body,
        categoryId: patch.categoryId,
        tagIds: patch.tagIds || [],
        visibility: patch.visibility
      },
      baseVersion,
      decidedBy: null,
      decidedAt: null,
      decisionNote: '',
      timeline: [buildTimelineEntry('submit', userId, note, now)]
    }
  }

  // 发起评审。
  // patch：本次提交待审批的文档字段（title/body/categoryId/tagIds/visibility）
  // 文档在审批期间保持旧内容可见，但置为「评审中」并锁定编辑；审批通过后才回写。
  // 事务内强制复核身份与文档写入资格：访客/只读角色/无文档关系的编辑者均不可发起，
  // 防止仅前端隐藏入口、直接调用 store 锁文档并制造评审单。
  async function submitReview(docId, patch, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.comments, db.accessRequests, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      const existingPending = await db.reviews
        .where('docId').equals(docId)
        .filter((r) => r.status === REVIEW.PENDING).first()
      if (!canSubmitReview(doc, { userId, role, grant: await findCollabGrant(docId, userId) }, existingPending)) {
        result = userId === GUEST_ID ? { status: 'guest' } : { status: 'denied' }
        return
      }
      if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }

      const review = buildReviewRecord(docId, patch, note, userId, now, ensureVersions(doc, now).length)
      await db.reviews.add(review)

      // 文档进入评审中：正文锁定，旧内容继续可见，待审批内容不提前泄露
      await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

      if (note && note.trim()) {
        const cmt = {
          id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
          content: note.trim(), mentionIds: [], createdAt: now
        }
        await db.comments.add(cmt)
        kb.comments.push(cmt)
      }
      result = { status: 'ok', review }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 发起版本恢复评审：编辑者选择历史版本快照作为待审内容，审批通过后回滚到该版本。
  // 与普通评审共用同一套锁定/审批/留痕机制；restoreFrom 标记恢复来源，
  // 审批通过时按 baseVersion 重标恢复边界（含评审期间的并发修改）。
  // 返回 { status: 'ok', review } | 'missing' | 'duplicate' | 'no-snapshot' | 'identical' | 'guest' | 'denied'
  async function submitRestoreReview(docId, fromVersion, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.comments, db.accessRequests, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      const existingPending = await db.reviews
        .where('docId').equals(docId)
        .filter((r) => r.status === REVIEW.PENDING).first()
      if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }
      // 恢复评审与普通评审同一套发起资格：访客/只读/无文档关系者一律拒绝
      if (!canSubmitReview(doc, { userId, role, grant: await findCollabGrant(docId, userId) }, existingPending)) {
        result = userId === GUEST_ID ? { status: 'guest' } : { status: 'denied' }
        return
      }

      const versions = ensureVersions(doc, now)
      const target = versions.find((v) => v.version === fromVersion)
      // 历史版本无内容快照（旧数据）无法安全恢复
      if (!target || !target.snapshot) { result = { status: 'no-snapshot' }; return }
      // 与当前内容一致：恢复无意义，避免产生空转版本
      if (diffVersionFields(target.snapshot, docSnapshot(doc)).length === 0) {
        result = { status: 'identical' }; return
      }

      const review = {
        id: uid('rev'),
        docId,
        status: REVIEW.PENDING,
        submittedBy: userId,
        submittedAt: now,
        snapshot: { ...target.snapshot, tagIds: [...(target.snapshot.tagIds || [])] },
        baseVersion: versions.length,
        restoreFrom: { version: target.version, savedAt: target.savedAt, savedBy: target.savedBy },
        decidedBy: null,
        decidedAt: null,
        decisionNote: '',
        timeline: [buildTimelineEntry('restore-submit', userId, note || ('申请恢复至 v' + target.version), now)]
      }
      await db.reviews.add(review)

      // 文档进入评审中：正文锁定，旧内容继续可见，恢复内容不提前泄露
      await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

      if (note && note.trim()) {
        const cmt = {
          id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
          content: note.trim(), mentionIds: [], createdAt: now
        }
        await db.comments.add(cmt)
        kb.comments.push(cmt)
      }
      result = { status: 'ok', review }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 缺口工单「关联文档送审」：创建评审单、锁定文档、工单置为送审中，在同一事务内完成。
  // 合并组（ticketId 为组主工单）共用一次送审：全组成员同时关联同一评审单与文档，
  // 任一步失败（含取消认领、解散、他人抢先送审等并发变化）整体回滚，不留孤立评审单或失效关联；
  // 与审批/撤回事务互斥，审批不可能插入「建单」与「工单关联」之间，工单不会卡在送审中。
  async function submitGapReview(ticketId, docId, patch, note, currentUser) {
    const kb = useKbStore()
    const gap = useGapStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === 'admin'
    let result = { status: 'error' }
    let submittedComment = null

    try {
      await db.transaction('rw', db.docs, db.reviews, db.comments, db.gapTickets, db.accessRequests, async () => {
        // 缺口送审属于内容发布：访客/只读角色在入口即拒绝，防止直接调用 store 锁文档/建工单
        if (userId === GUEST_ID || !canEditContent(currentUser?.role)) { result = { status: 'guest' }; return }
        const ticket = await db.gapTickets.get(ticketId)
        if (!ticket) { result = { status: 'ticket-missing' }; return }

        // 合并组：主工单发起，全组统一送审；组成员单独送审直接拒绝
        const members = ticket.groupId
          ? await db.gapTickets.where('groupId').equals(ticket.groupId).toArray()
          : [ticket]
        const primary = members.find((m) => m.id === ticketId) || ticket
        if (ticket.groupId && (!primary || primary.groupId !== primary.id)) {
          result = { status: 'ticket-changed', ticket }; return
        }
        // 每张工单都必须仍处于「本人处理中」：解散组、移出、取消认领等并发变化整体回滚
        for (const m of members) {
          if (m.status !== GAP.CLAIMED || (m.claimedBy !== userId && !isAdmin)) {
            result = { status: 'ticket-changed', ticket: m }; return
          }
        }

        const doc = await db.docs.get(docId)
        if (!doc) { result = { status: 'doc-missing' }; return }
        const existingPending = await db.reviews
          .where('docId').equals(docId)
          .filter((r) => r.status === REVIEW.PENDING).first()
        if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }
        // 送审人与文档的关系仍要满足发起评审资格（工单认领身份之外的二次校验：
        // 只读成员即便领到工单也不能借缺口送审发布他人文档内容）
        if (!canSubmitReview(doc, { userId, role: currentUser.role, grant: await findCollabGrant(docId, userId) }, existingPending)) {
          result = { status: 'denied' }; return
        }

        const review = buildReviewRecord(docId, patch, note, userId, now, ensureVersions(doc, now).length)
        await db.reviews.add(review)

        // 文档进入评审中：正文锁定，旧内容继续可见，待审批内容不提前泄露
        await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

        // 全组工单关联同一评审单：claimed → in_review，与评审单创建、文档锁定同生共死。
        // 各成员仍追加各自的 timeline 条目，提问与处理历史分别保留
        const grouped = members.length > 1
        for (const m of members) {
          const submitNote = grouped
            ? (m.id === primary.id
              ? '合并组（' + members.length + ' 个同类问题）关联文档《' + (doc.title || docId) + '》送审'
              : '合并组统一关联文档《' + (doc.title || docId) + '》送审')
            : '关联文档《' + (doc.title || docId) + '》送审'
          await db.gapTickets.update(m.id, {
            status: GAP.IN_REVIEW,
            docId,
            reviewId: review.id,
            timeline: [...(m.timeline || []), buildTimelineEntry('submit', userId, submitNote, now)]
          })
        }

        if (note && note.trim()) {
          submittedComment = {
            id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
            content: note.trim(), mentionIds: [], createdAt: now
          }
          await db.comments.add(submittedComment)
        }
        result = { status: 'ok', review }
      })
    } catch (e) {
      // 中途失败（如写入异常）：事务已整体回滚，无孤立评审单/残留锁定，按失败处理由调用方提示
      result = { status: 'error' }
      submittedComment = null
    }

    if (result.status === 'ok' && submittedComment) kb.comments.push(submittedComment)
    await Promise.all([reload(), kb.reloadDocs(), gap.reload()])
    return result
  }

  // 成员发表评审意见：同时写入 comments（联动评论区）与评审单 timeline（留痕）。
  // 访客（未登录）不可评论；评审单非待审批状态拒绝。
  async function addReviewComment(reviewId, content, mentionIds, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let created = null

    await db.transaction('rw', db.reviews, db.comments, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review || review.status !== REVIEW.PENDING) return
      if (userId === GUEST_ID || !currentUser?.role) { created = { status: 'guest' }; return }
      const cmt = {
        id: uid('cmt'), docId: review.docId, reviewId, authorId: userId,
        content, mentionIds: mentionIds || [], createdAt: now
      }
      await db.comments.add(cmt)
      await db.reviews.update(reviewId, {
        timeline: [...(review.timeline || []), buildTimelineEntry('comment', userId, content, now)]
      })
      created = cmt
    })

    if (created && !created.status) {
      kb.comments.push(created)
      await reload()
    }
    return created
  }

  // 联动缺口工单：审批通过 → 已解决并回填答案来源；驳回/撤回 → 退回处理中。
  // 合并组共用同一 reviewId：所有成员一起解决或一起退回，组关系始终保留。
  // 须在评审决策的同一事务内调用（tables 需包含 db.gapTickets），保证两边状态一致
  async function syncGapTicket(reviewId, action, note, userId, now) {
    const linked = await db.gapTickets.where('reviewId').equals(reviewId).toArray()
    // 仅联动「送审中」的工单：其它状态说明关联已失效（如文档删除后退回、历史脏数据），
    // 不再回写，避免审批结论覆盖已修正的工单状态
    const tickets = linked.filter((t) => t.status === GAP.IN_REVIEW)
    for (const ticket of tickets) {
      if (action === 'resolve') {
        const resolveNote = tickets.length > 1 && ticket.groupId
          ? '合并组送审批量通过，答案来源已回填'
          : '审批通过，答案来源已回填'
        await db.gapTickets.update(ticket.id, {
          status: GAP.RESOLVED,
          resolvedAt: now,
          timeline: [...(ticket.timeline || []), buildTimelineEntry('resolve', userId, resolveNote, now)]
        })
      } else {
        // 退回处理：保留关联文档与合并组关系便于修改后重新送审，仅解除评审单关联
        const reason = action === 'return'
          ? '评审驳回' + (note ? '：' + note : '') + '，退回处理'
          : '评审已撤回，退回处理'
        await db.gapTickets.update(ticket.id, {
          status: GAP.CLAIMED,
          reviewId: null,
          timeline: [...(ticket.timeline || []), buildTimelineEntry('return', userId, reason, now)]
        })
      }
    }
  }

  // 管理员审批：approve 通过 / reject 驳回。
  // 通过：把待审批快照回写到文档（含可见性），追加「审批通过」版本，解除评审中状态；
  // 驳回：文档内容与可见性保持发起前不变，仅解除锁定并留痕。
  async function decideReview(reviewId, decision, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.gapTickets, db.freshnessTickets, db.freshnessPolicies, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review) { result = { status: 'missing' }; return }
      if (review.status !== REVIEW.PENDING) { result = { status: 'closed', review }; return }
      // 审批是评审中唯一写入通道：仅管理员可执行，事务内复核，
      // 杜绝非管理员直接调用 store 发布待审内容或联动工单结案
      if (!canReviewDecision(currentUser?.role, review, userId)) {
        result = userId === GUEST_ID ? { status: 'guest' } : { status: 'denied' }
        return
      }

      const doc = await db.docs.get(review.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }

      const status = decision === 'approve' ? REVIEW.APPROVED : REVIEW.REJECTED
      const timeline = [
        ...(review.timeline || []),
        buildTimelineEntry(status === REVIEW.APPROVED ? 'approve' : 'reject', userId, note, now)
      ]
      const decided = {
        ...review,
        status,
        decidedBy: userId,
        decidedAt: now,
        decisionNote: note || '',
        timeline
      }

      if (status === REVIEW.APPROVED) {
        // 回写审批通过的内容与可见性，并追加带审批标记的新版本（留痕到版本历史）
        const versions = ensureVersions(doc, now)
        const nextVersion = versions.length + 1
        let versionEntry
        let newVersions
        if (review.restoreFrom) {
          // 恢复评审：以事务内最新读到的版本为准计算回滚边界——
          // 评审期间若有并发修改（管理员直接保存等），其版本一并纳入回滚范围并标记
          const fromV = review.restoreFrom.version
          const { rolledBack, rolledBackConcurrent } = restoreRollbackInfo(versions, fromV, review.baseVersion)
          versionEntry = {
            version: nextVersion,
            savedAt: now,
            savedBy: review.submittedBy,
            note: '恢复至 v' + fromV + (rolledBackConcurrent.length ? '（含并发修改 ' + rolledBackConcurrent.length + ' 处）' : '') + (note ? '：' + note : ''),
            reviewStatus: REVIEW.APPROVED,
            reviewId,
            decidedBy: userId,
            restore: { fromVersion: fromV, rolledBack, rolledBackConcurrent, reviewId, decidedBy: userId },
            snapshot: { ...review.snapshot }
          }
          // 旧记录重标边界：fromV 之后的版本被回滚（supersededBy），之前的恢复生效
          newVersions = [...applyRestoreBoundary(versions, fromV, nextVersion, now), versionEntry]
          // 评审单同步记录恢复结果，供评审中心/历史留痕直接展示
          decided.restoreResult = { rolledBack, rolledBackConcurrent }
        } else if (isFreshReview(review)) {
          // 知识保鲜复核通过：
          // - 修订送审（非 noChange）→ 回写修订快照，追加「保鲜复核通过」版本；
          // - 确认无需修订（noChange）→ 正文不回写不产生内容版本，仅恢复引用并重算周期。
          const freshRound = review.freshRound
          if (isFreshNoChangeReview(review)) {
            newVersions = versions
            decided.freshNoChange = true
          } else {
            versionEntry = {
              version: nextVersion,
              savedAt: now,
              savedBy: review.submittedBy,
              note: '知识保鲜复核通过后发布（第 ' + freshRound + ' 轮复核）' + (note ? '：' + note : ''),
              reviewStatus: REVIEW.APPROVED,
              reviewId,
              decidedBy: userId,
              freshReview: { round: freshRound, reviewId, noChange: false },
              snapshot: { ...review.snapshot }
            }
            newVersions = [...versions, versionEntry]
          }
        } else {
          versionEntry = {
            version: nextVersion,
            savedAt: now,
            savedBy: review.submittedBy,
            note: '评审通过后发布' + (note ? '：' + note : ''),
            reviewStatus: REVIEW.APPROVED,
            reviewId,
            decidedBy: userId,
            snapshot: { ...review.snapshot }
          }
          newVersions = [...versions, versionEntry]
        }
        const fresh = isFreshReview(review)
        const noChangeFresh = isFreshNoChangeReview(review)
        const updated = {
          ...doc,
          // 保鲜「确认无需修订」不回写快照，仅解除锁定；其余通过按快照回写
          ...(fresh && noChangeFresh ? {} : review.snapshot),
          visibility: fresh && noChangeFresh ? doc.visibility : review.snapshot.visibility,
          publishState: PUBLISH.PUBLISHED,
          activeReviewId: null,
          updatedAt: now,
          lastReview: { reviewId, status, by: userId, at: now, note: note || '', ...(newVersions.length ? { version: newVersions.length } : {}) },
          versions: newVersions
        }
        // 分类随审批变更：无文档级覆盖的文档按新分类策略重解析保鲜配置（新分类无策略则退出保鲜）；
        // 有在途复核单时跳过——当轮按规则快照执行，结案时由保鲜联动按新分类策略重算
        if (!fresh && review.snapshot.categoryId !== doc.categoryId && !isDocOverride(updated.freshness)) {
          const openFresh = await db.freshnessTickets
            .where('docId').equals(doc.id)
            .filter((t) => isFreshTicketOpen(t)).first()
          if (!openFresh) {
            const pol = review.snapshot.categoryId
              ? await db.freshnessPolicies.where('categoryId').equals(review.snapshot.categoryId).first()
              : null
            updated.freshness = pol ? materializeFromPolicy(pol, doc.freshness, now) : null
          }
        }
        await db.docs.put(updated)
      } else {
        // 驳回不改内容，仅解除评审中锁定；驳回结论挂到文档上供详情页提示
        await db.docs.update(review.docId, {
          publishState: PUBLISH.PUBLISHED,
          activeReviewId: null,
          lastReview: { reviewId, status, by: userId, at: now, note: note || '' }
        })
      }

      await db.reviews.put(decided)
      // 缺口工单联动：通过回填答案来源 / 驳回退回处理（同事务，状态不会脱节）
      await syncGapTicket(reviewId, status === REVIEW.APPROVED ? 'resolve' : 'return', note, userId, now)
      // 知识保鲜联动：通过恢复引用并重算周期 / 驳回回到待整改继续整改（同事务）
      if (isFreshReview(review)) {
        await useFreshnessStore().syncFreshTicket(review, status === REVIEW.APPROVED ? 'approve' : 'reject', note, userId, now)
      }
      result = { status: 'ok', review: decided, approved: status === REVIEW.APPROVED }
    })

    const gap = useGapStore()
    const freshness = useFreshnessStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.reload(), freshness.loaded ? freshness.reload() : Promise.resolve()])
    return result
  }

  // 发起人撤回评审：文档解除锁定，待审内容不生效
  async function withdrawReview(reviewId, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.gapTickets, db.freshnessTickets, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review) { result = { status: 'missing' }; return }
      if (userId === GUEST_ID) { result = { status: 'guest' }; return }
      if (review.status !== REVIEW.PENDING || review.submittedBy !== userId) { result = { status: 'denied' }; return }
      const withdrawn = {
        ...review,
        status: REVIEW.WITHDRAWN,
        timeline: [...(review.timeline || []), buildTimelineEntry('withdraw', userId, '', now)]
      }
      await db.reviews.put(withdrawn)
      await db.docs.update(review.docId, { publishState: PUBLISH.PUBLISHED, activeReviewId: null })
      // 缺口工单联动：撤回送审，工单退回处理中
      await syncGapTicket(reviewId, 'withdraw', '', userId, now)
      // 保鲜复核撤回：复核单回到待整改（问答引用继续暂停），修订后可重新送审
      if (isFreshReview(review)) {
        await useFreshnessStore().syncFreshTicket(review, 'withdraw', '', userId, now)
      }
      result = { status: 'ok', review: withdrawn }
    })

    const gap = useGapStore()
    const freshness = useFreshnessStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.reload(), freshness.loaded ? freshness.reload() : Promise.resolve()])
    return result
  }

  // 删除文档时连带清理评审单
  async function deleteReviewsOfDoc(docId) {
    await db.reviews.where('docId').equals(docId).delete()
    if (loaded.value) await reload()
  }

  // 待我审批（管理员视角）/ 我发起的（编辑者视角）
  const pendingCount = computed(() => reviews.value.filter((r) => r.status === REVIEW.PENDING).length)

  return {
    reviews, loaded, loadAll, reload,
    pendingByDoc, pendingReviewOf, reviewsOfDoc, commentsOfReview,
    submitReview, submitRestoreReview, submitGapReview, addReviewComment, decideReview, withdrawReview,
    deleteReviewsOfDoc, pendingCount
  }
})
