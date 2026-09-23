import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { REVIEW, buildTimelineEntry } from '@/utils/review'
import { GAP, normalizeQuestion, isGroupPrimary } from '@/utils/gap'
import { canEditContent, GUEST_ID } from '@/utils/permission'

// 知识缺口工单 store：
// 成员把未解决的问答转为补写需求（open）→ 编辑者认领（claimed）→ 关联文档送审（in_review）→
// 管理员审批通过自动回填答案来源（resolved）/ 驳回退回处理（claimed）。
// 合并认领：编辑者可把多个同类问题合并为一组（groupId = 主工单 id），组内各自保留提问与
// 处理历史，共用一个认领人、一次文档送审；审批通过/驳回/文档删除对全组成员统一联动。
// 送审由 review store 的 submitGapReview 在一个事务内完成（建评审单 + 锁文档 + 全组关联），
// 审批联动在 review store 的 decideReview/withdrawReview 中同事务完成，这里只负责工单自身的读写。
export const useGapStore = defineStore('gap', () => {
  const tickets = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
    // 首次加载时自愈「卡在送审中」的历史工单（关联评审单已完结/丢失但工单未联动）
    await reconcileStuckTickets()
  }

  async function reload() {
    tickets.value = await db.gapTickets.toArray()
  }

  // 待认领数量（侧边栏角标）
  const openCount = computed(() => tickets.value.filter((t) => t.status === GAP.OPEN).length)

  // 合并组全部成员（含主工单），按创建时间正序
  function groupMembers(groupId) {
    if (!groupId) return []
    return tickets.value
      .filter((t) => t.groupId === groupId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  // 同一问题是否已有未解决工单（问答页提示与创建去重，合并组成员同样命中）
  function activeTicketForQuestion(question) {
    const q = normalizeQuestion(question)
    if (!q) return null
    return tickets.value.find((t) => t.status !== GAP.RESOLVED && normalizeQuestion(t.question) === q) || null
  }

  // 已解决工单中匹配关键词的答案来源（问答页自动回填展示）。
  // 合并组解决后每个成员都指向同一文档，按 docId 去重，避免同一答案来源重复出现
  function resolvedTicketsMatching(keywords = []) {
    const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean)
    if (!kws.length) return []
    const seenDoc = new Set()
    return tickets.value
      .filter((t) => t.status === GAP.RESOLVED && t.docId)
      .map((t) => ({
        ticket: t,
        score: kws.reduce((n, k) => n + (String(t.question).toLowerCase().includes(k) ? 1 : 0), 0)
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.ticket.resolvedAt) - new Date(a.ticket.resolvedAt))
      .map((x) => x.ticket)
      .filter((t) => {
        if (seenDoc.has(t.docId)) return false
        seenDoc.add(t.docId)
        return true
      })
  }

  // 成员提交补写需求。同问题存在未解决工单时直接返回已有工单，避免重复。
  // 访客（未登录）不可建工单：缺口工单会进入认领/送审流程，必须有明确责任人
  async function createTicket({ question, detail }, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (userId === GUEST_ID) return { status: 'guest' }
    const dup = activeTicketForQuestion(question)
    if (dup) return { status: 'duplicate', ticket: dup }
    const now = new Date().toISOString()
    const ticket = {
      id: uid('gap'),
      question: String(question || '').trim(),
      detail: String(detail || '').trim(),
      status: GAP.OPEN,
      createdBy: userId,
      createdAt: now,
      claimedBy: null,
      claimedAt: null,
      docId: null,
      reviewId: null,
      groupId: null,
      resolvedAt: null,
      timeline: [buildTimelineEntry('create', userId, '', now)]
    }
    await db.gapTickets.add(ticket)
    await reload()
    return { status: 'ok', ticket }
  }

  // 编辑者认领：open（且未并入组）→ claimed。组内工单由合并流程统一认领，不可单独认领。
  // 事务内复核角色：访客/只读角色直接调用 store 同样拒绝
  async function claimTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }
    if (userId === GUEST_ID || !canEditContent(currentUser?.role)) return { status: 'denied' }
    await db.transaction('rw', db.gapTickets, async () => {
      const t = await db.gapTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.groupId) { result = { status: 'grouped', ticket: t }; return }
      if (t.status !== GAP.OPEN) { result = { status: 'changed', ticket: t }; return }
      await db.gapTickets.update(id, {
        status: GAP.CLAIMED,
        claimedBy: userId,
        claimedAt: now,
        timeline: [...(t.timeline || []), buildTimelineEntry('claim', userId, '', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 取消认领：独立 claimed 工单 → open。合并组工单不走这里（取消认领 = 解散整组）
  async function releaseTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }
    if (userId === GUEST_ID || !canEditContent(currentUser?.role)) return { status: 'denied' }
    await db.transaction('rw', db.gapTickets, async () => {
      const t = await db.gapTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.groupId) { result = { status: 'grouped', ticket: t }; return }
      if (t.status !== GAP.CLAIMED) { result = { status: 'changed', ticket: t }; return }
      await db.gapTickets.update(id, {
        status: GAP.OPEN,
        claimedBy: null,
        claimedAt: null,
        timeline: [...(t.timeline || []), buildTimelineEntry('release', userId, '', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 合并认领：把多个同类问题（open 或自己处理中 claimed 的独立工单）并为一组，统一认领。
  // 主工单取「已由当前用户认领」的工单（沿用其认领时间），否则取最早创建的工单；
  // groupId 挂主工单 id，主工单自身也带 groupId。全程在一个事务内重读校验，
  // 并发认领/并发合并任一工单都会让整个合并回滚。
  async function mergeTickets(ticketIds, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === 'admin'
    let result = { status: 'error' }
    // 合并认领是编辑者治理操作：访客/只读角色直接拒绝
    if (userId === GUEST_ID || !canEditContent(currentUser?.role)) return { status: 'denied' }

    await db.transaction('rw', db.gapTickets, async () => {
      const picked = []
      for (const id of ticketIds || []) {
        const t = await db.gapTickets.get(id)
        if (!t) { result = { status: 'missing' }; return }
        const mergeable = !t.groupId &&
          (t.status === GAP.OPEN ||
            (t.status === GAP.CLAIMED && (t.claimedBy === userId || isAdmin)))
        if (!mergeable) { result = { status: 'changed', ticket: t }; return }
        picked.push(t)
      }
      if (picked.length < 2) { result = { status: 'too-few' }; return }
      const qs = new Set(picked.map((t) => normalizeQuestion(t.question)))
      if (qs.size !== picked.length) { result = { status: 'duplicate-question' }; return }

      // 主工单：优先沿用自己已认领的工单；否则取最早创建的
      picked.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      const ownClaimed = picked.find((t) => t.status === GAP.CLAIMED && t.claimedBy === userId)
      const primary = ownClaimed || picked[0]
      const groupId = primary.id
      const others = picked.filter((t) => t.id !== groupId)
      const questionList = picked.map((t) => t.question).join(' / ')

      // 主工单：若原本是 open 则顺带完成认领（claimedAt 取当前时间）；已是自己认领则保留认领时间
      await db.gapTickets.update(groupId, {
        status: GAP.CLAIMED,
        claimedBy: userId,
        claimedAt: primary.claimedBy === userId && primary.claimedAt ? primary.claimedAt : now,
        groupId,
        timeline: [
          ...(primary.timeline || []),
          buildTimelineEntry('merge', userId, '合并认领 ' + picked.length + ' 个同类问题：' + questionList, now)
        ]
      })

      for (const t of others) {
        await db.gapTickets.update(t.id, {
          status: GAP.CLAIMED,
          claimedBy: userId,
          claimedAt: now,
          groupId,
          timeline: [
            ...(t.timeline || []),
            buildTimelineEntry('merge', userId, '并入合并组，与主问题「' + primary.question + '」共用一次送审', now)
          ]
        })
      }
      result = { status: 'ok', groupId }
    })

    await reload()
    return result
  }

  // 把单个成员移出合并组：拆回独立工单，保留认领人继续独立处理（提问与处理历史原样保留）。
  // 若移出后组内只剩主工单一人，合并组随之自动解散（主工单也拆为独立工单）。
  async function removeFromGroup(ticketId, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === 'admin'
    let result = { status: 'error' }
    if (userId === GUEST_ID) return { status: 'denied' }

    await db.transaction('rw', db.gapTickets, async () => {
      const t = await db.gapTickets.get(ticketId)
      if (!t) { result = { status: 'missing' }; return }
      if (!t.groupId || isGroupPrimary(t)) { result = { status: 'not-member', ticket: t }; return }
      if (t.status !== GAP.CLAIMED) { result = { status: 'locked', ticket: t }; return }
      if (t.claimedBy !== userId && !isAdmin) { result = { status: 'denied', ticket: t }; return }

      const members = await db.gapTickets.where('groupId').equals(t.groupId).toArray()
      const primary = members.find((m) => isGroupPrimary(m))
      if (!primary) { result = { status: 'missing' }; return }

      await db.gapTickets.update(t.id, {
        groupId: null,
        timeline: [
          ...(t.timeline || []),
          buildTimelineEntry('unmerge', userId, '移出合并组，转为独立工单继续处理', now)
        ]
      })

      if (members.length <= 2) {
        // 组里只剩主工单：合并组自动解散，主工单拆为独立工单（认领关系不变）
        await db.gapTickets.update(primary.id, {
          groupId: null,
          timeline: [
            ...(primary.timeline || []),
            buildTimelineEntry('dissolve', userId, '组成员移出后仅剩单个工单，合并组自动解散', now)
          ]
        })
      } else {
        await db.gapTickets.update(primary.id, {
          timeline: [
            ...(primary.timeline || []),
            buildTimelineEntry('unmerge', userId, '成员工单「' + t.question + '」移出合并组', now)
          ]
        })
      }
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 解散合并组：仅处理中阶段、组处理人可操作。组内全部工单（含主工单）拆为独立工单，
  // 提问与各自 timeline 保留，统一退回待认领、清空认领人。
  async function dissolveGroup(groupId, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === 'admin'
    let result = { status: 'error' }
    if (userId === GUEST_ID) return { status: 'denied' }

    await db.transaction('rw', db.gapTickets, async () => {
      const members = await db.gapTickets.where('groupId').equals(groupId).toArray()
      const primary = members.find((m) => isGroupPrimary(m))
      if (!primary || members.length < 2) { result = { status: 'missing' }; return }
      if (primary.status !== GAP.CLAIMED) { result = { status: 'locked', ticket: primary }; return }
      if (primary.claimedBy !== userId && !isAdmin) { result = { status: 'denied', ticket: primary }; return }

      for (const m of members) {
        const note = m.id === primary.id
          ? '解散合并组，组内全部工单退回待认领'
          : '合并组解散，工单退回待认领'
        await db.gapTickets.update(m.id, {
          groupId: null,
          status: GAP.OPEN,
          claimedBy: null,
          claimedAt: null,
          timeline: [...(m.timeline || []), buildTimelineEntry('dissolve', userId, note, now)]
        })
      }
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 自愈「卡在送审中」的工单：送审中但关联评审单已完结/丢失时，按评审结论补齐状态——
  // 已通过 → 已解决并回填答案来源；已驳回/已撤回/评审单丢失 → 退回处理中并解除失效关联。
  // 历史上「先建评审单、后回写工单」两步式送审在并发审批下会产生这种工单；现为单事务送审，
  // 不再新增，此处仅修复存量，首次加载时执行一次。合并组成员各自带同一 reviewId，
  // 会在此被逐张修正，结论天然一致。
  async function reconcileStuckTickets() {
    const stuck = tickets.value.filter((t) => t.status === GAP.IN_REVIEW)
    if (!stuck.length) return
    const now = new Date().toISOString()
    let changed = false
    await db.transaction('rw', db.gapTickets, db.reviews, async () => {
      for (const t of stuck) {
        const review = t.reviewId ? await db.reviews.get(t.reviewId) : null
        if (review && review.status === REVIEW.PENDING) continue // 评审正常流转中
        // 事务内重读，避免覆盖期间并发的状态修正
        const fresh = await db.gapTickets.get(t.id)
        if (!fresh || fresh.status !== GAP.IN_REVIEW) continue
        if (review && review.status === REVIEW.APPROVED) {
          await db.gapTickets.update(t.id, {
            status: GAP.RESOLVED,
            resolvedAt: review.decidedAt || now,
            timeline: [...(fresh.timeline || []), buildTimelineEntry('resolve', review.decidedBy || 'system', '审批通过，答案来源已回填', now)]
          })
        } else {
          const reason = !review
            ? '关联评审单已丢失，退回处理'
            : review.status === REVIEW.REJECTED
              ? '评审驳回' + (review.decisionNote ? '：' + review.decisionNote : '') + '，退回处理'
              : '评审已撤回，退回处理'
          await db.gapTickets.update(t.id, {
            status: GAP.CLAIMED,
            reviewId: null,
            timeline: [...(fresh.timeline || []), buildTimelineEntry('return', (review && review.decidedBy) || 'system', reason, now)]
          })
        }
        changed = true
      }
    })
    if (changed) await reload()
  }

  return {
    tickets, loaded, loadAll, reload, openCount, groupMembers,
    activeTicketForQuestion, resolvedTicketsMatching,
    createTicket, claimTicket, releaseTicket,
    mergeTickets, removeFromGroup, dissolveGroup,
    reconcileStuckTickets
  }
})
