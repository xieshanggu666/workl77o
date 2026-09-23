import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import { ACCESS, isGrantActive, buildAccessTimelineEntry } from '@/utils/access'
import { isFreshTicketOpen, buildFreshTimelineEntry } from '@/utils/freshness'
import {
  HO_ITEM, REVOKE_MODE, isItemOpen, handoverStatusOf, handoverSnapshotOf, checkHandoverConflicts
} from '@/utils/handover'
import { isDocRetired } from '@/utils/retirement'
import { GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { useKbStore } from './kb'
import { useAuthStore } from './auth'

// 知识责任交接 store：
// 负责人在同一批交接中逐篇指定接任者（每篇文档可交接给不同成员）→ 各接任者按篇独立确认/谢绝 →
// 管理员按确认结果分批批准：已确认篇可先批先转，在同一事务内执行转移——
// - 所有权：doc.ownerId 交给该篇接任者，原负责人任期追加进 doc.ownerHistory（历史归属全程保留）；
// - 待办审批：文档上流转中的评审单（原负责人名下）改挂接任者，待审批的访问申请随所有权自动转移；
// - 保鲜责任：复核周期随所有权转移，流转中的复核单留痕并改挂送审人；
// - 权限收回：按发起时的交接决定（keep/revoke）保留或收回原负责人的协作成员身份与有效授权。
// 批准执行时先以发起快照逐篇复核并发变更（负责人/内容/评审/保鲜配置）：校验与回退以「篇」为单位，
// 冲突篇标记失败（事务内不写入该篇任何转移），不影响同批其他篇；单篇转移写入异常由 Dexie 事务
// 整体回滚（本批不产生任何部分写入），catch 中补记失败留痕。
export const useHandoverStore = defineStore('handover', () => {
  const handovers = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    handovers.value = await db.handovers.toArray()
  }

  const sorted = computed(() =>
    [...handovers.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  // 有待我确认篇的交接单（我作为接任者）
  function pendingConfirmFor(userId) {
    return sorted.value.filter((h) =>
      (h.items || []).some((i) => i.status === HO_ITEM.PENDING_CONFIRM && i.toUserId === userId)
    )
  }

  // 有待批准篇的交接单（仅管理员）
  function pendingApprovalFor(role) {
    if (role !== ROLE.ADMIN) return []
    return sorted.value.filter((h) => (h.items || []).some((i) => i.status === HO_ITEM.CONFIRMED))
  }

  // 我发起的
  function initiatedBy(userId) {
    return sorted.value.filter((h) => h.fromUserId === userId)
  }

  // 我相关的（发起或作为任一篇的接任者），普通成员的「全部记录」范围
  function involvedIn(userId) {
    return sorted.value.filter((h) =>
      h.fromUserId === userId || (h.items || []).some((i) => i.toUserId === userId)
    )
  }

  // 文档当前是否有流转中的交接篇（同一文档同时只允许一个）
  function activeHandoverOfDoc(docId) {
    return handovers.value.find((h) =>
      (h.items || []).some((i) => i.docId === docId && isItemOpen(i))
    ) || null
  }

  // 文档当前流转中的交接篇（含所属交接单），供文档详情页提示
  function activeItemOfDoc(docId) {
    for (const h of handovers.value) {
      const item = (h.items || []).find((i) => i.docId === docId && isItemOpen(i))
      if (item) return { handover: h, item }
    }
    return null
  }

  // 侧栏角标：待我确认 + （管理员）待批准
  function pendingCountFor(userId, role) {
    return pendingConfirmFor(userId).length + pendingApprovalFor(role).length
  }

  // 负责人发起批量交接：同一批中逐篇指定接任者，逐篇复核归属并为每篇文档打快照
  // （批准执行时据此校验并发变更）。items: [{ docId, toUserId }]
  // 返回 { status: 'ok', handover } | 'guest' | 'no-docs' | 'bad-target' | 'missing' | 'denied'
  //      | 'retired' | 'in-retirement' | 'in-handover'
  async function initiateHandover({ items, revokeMode, note }, currentUser) {
    const kb = useKbStore()
    const auth = useAuthStore()
    await Promise.all([kb.loadAll(), auth.loadUsers()])
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    // 逐篇整理接任者：同一文档去重（先出现的为准）
    const pairs = []
    const seen = new Set()
    for (const it of items || []) {
      if (!it?.docId || seen.has(it.docId)) continue
      seen.add(it.docId)
      pairs.push({ docId: it.docId, toUserId: it.toUserId })
    }
    if (!pairs.length) return { status: 'no-docs' }
    // 每篇的接任者都必须是已注册成员且不能是自己
    for (const p of pairs) {
      if (!p.toUserId || p.toUserId === userId || !auth.users.some((u) => u.id === p.toUserId)) {
        return { status: 'bad-target', docId: p.docId }
      }
    }
    const mode = revokeMode === REVOKE_MODE.REVOKE ? REVOKE_MODE.REVOKE : REVOKE_MODE.KEEP
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.handovers, db.retirements, async () => {
      const hoItems = []
      for (const p of pairs) {
        // 事务内重读：归属与交接占用以库中最新数据为准，防止多窗口并发发起
        const doc = await db.docs.get(p.docId)
        if (!doc) { result = { status: 'missing', docId: p.docId }; return }
        if (doc.ownerId !== userId) { result = { status: 'denied', docId: p.docId, title: doc.title }; return }
        // 已退役文档不再参与责任交接（只读归档）；流转中退役单也先完成/取消，避免两流程交错
        if (isDocRetired(doc)) { result = { status: 'retired', docId: p.docId, title: doc.title }; return }
        const dupRetire = await db.retirements.filter((rt) => rt.docId === p.docId && rt.status === 'pending').first()
        if (dupRetire) { result = { status: 'in-retirement', docId: p.docId, title: doc.title }; return }
        const dup = await db.handovers
          .filter((h) => (h.items || []).some((i) => i.docId === p.docId && isItemOpen(i))).first()
        if (dup) { result = { status: 'in-handover', docId: p.docId, title: doc.title, handover: dup }; return }
        hoItems.push({
          docId: p.docId, title: doc.title, toUserId: p.toUserId,
          status: HO_ITEM.PENDING_CONFIRM,
          snapshot: handoverSnapshotOf(doc),
          confirmedAt: null, decidedBy: null, decidedAt: null, decideNote: '',
          completedAt: null, failReason: '', result: null
        })
      }

      const handover = {
        id: uid('ho'),
        status: handoverStatusOf({ items: hoItems }),
        fromUserId: userId,
        docIds: pairs.map((p) => p.docId),
        revokeMode: mode,
        note: String(note || '').trim(),
        items: hoItems,
        createdAt: nowIso,
        timeline: [buildTimelineEntry('initiate', userId, note, nowIso)]
      }
      await db.handovers.add(handover)
      result = { status: 'ok', handover }
    })

    await reload()
    return result
  }

  // 接任者确认接收（可一次确认多篇）：仅「指定我为接任者且待确认」的篇生效 → 进入待管理员批准
  async function confirmHandover(id, docIds, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.handovers, async () => {
      const h = await db.handovers.get(id)
      if (!h) { result = { status: 'missing' }; return }
      const wanted = new Set(docIds || [])
      const targets = (h.items || []).filter((it) => wanted.has(it.docId))
      if (!targets.length) { result = { status: 'missing' }; return }
      // 只能确认「指定我为接任者」的篇
      if (isGuestUser(userId) || targets.some((it) => it.toUserId !== userId)) { result = { status: 'denied' }; return }
      // 事务内复核：目标篇必须仍处于待确认（防止多窗口重复确认）
      if (targets.some((it) => it.status !== HO_ITEM.PENDING_CONFIRM)) { result = { status: 'changed', handover: h }; return }
      const items = h.items.map((it) =>
        wanted.has(it.docId) ? { ...it, status: HO_ITEM.CONFIRMED, confirmedAt: nowIso } : it
      )
      const entries = targets.map((it) => buildTimelineEntry('confirm', userId, '《' + it.title + '》', nowIso))
      const updated = { ...h, items, timeline: [...(h.timeline || []), ...entries] }
      updated.status = handoverStatusOf(updated)
      await db.handovers.put(updated)
      result = { status: 'ok', count: targets.length, handover: updated }
    })

    await reload()
    return result
  }

  // 接任者谢绝某一篇 → 该篇交接终止，文档保持原状；同批其他篇不受影响
  async function declineHandover(id, docId, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.handovers, async () => {
      const h = await db.handovers.get(id)
      if (!h) { result = { status: 'missing' }; return }
      const item = (h.items || []).find((it) => it.docId === docId)
      if (!item) { result = { status: 'missing' }; return }
      if (item.toUserId !== userId || isGuestUser(userId)) { result = { status: 'denied' }; return }
      if (item.status !== HO_ITEM.PENDING_CONFIRM) { result = { status: 'changed', handover: h }; return }
      const decideNote = String(note || '').trim()
      const items = h.items.map((it) =>
        it.docId === docId ? { ...it, status: HO_ITEM.DECLINED, decideNote } : it
      )
      const updated = {
        ...h,
        items,
        timeline: [...(h.timeline || []), buildTimelineEntry('decline', userId, '《' + item.title + '》' + (decideNote ? '：' + decideNote : ''), nowIso)]
      }
      updated.status = handoverStatusOf(updated)
      await db.handovers.put(updated)
      result = { status: 'ok', handover: updated }
    })

    await reload()
    return result
  }

  // 发起人/管理员取消：所有仍在流转中的篇一并取消（已终态的篇不受影响）
  async function cancelHandover(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.handovers, async () => {
      const h = await db.handovers.get(id)
      if (!h) { result = { status: 'missing' }; return }
      if (isGuestUser(userId) || (h.fromUserId !== userId && role !== ROLE.ADMIN)) { result = { status: 'denied' }; return }
      const openItems = (h.items || []).filter((it) => isItemOpen(it))
      if (!openItems.length) { result = { status: 'changed', handover: h }; return }
      const items = h.items.map((it) => (isItemOpen(it) ? { ...it, status: HO_ITEM.CANCELLED } : it))
      const note = '取消 ' + openItems.length + ' 篇流转中的交接：' + openItems.map((it) => '《' + it.title + '》').join('')
      const updated = { ...h, items, timeline: [...(h.timeline || []), buildTimelineEntry('cancel', userId, note, nowIso)] }
      updated.status = handoverStatusOf(updated)
      await db.handovers.put(updated)
      result = { status: 'ok', handover: updated }
    })

    await reload()
    return result
  }

  // 管理员分批审批：对一批「已确认」的篇执行批准转移 / 驳回（按确认结果分批，
  // 未确认/已谢绝篇不在本批范围）。docIds: 本次审批的篇。
  // 批准路径在同一事务内：① 逐篇以发起快照复核并发变更 → ② 一致篇执行转移
  // （所有权 + 历史归属 + 待办审批 + 保鲜责任 + 按决定收回权限）→ ③ 冲突篇标记失败回退。
  // 校验与转移均以「篇」为单位：某篇冲突/失败不影响同批其他篇；
  // 转移途中抛错：Dexie 事务整体回滚（本批无任何部分写入），catch 中补记失败。
  async function decideHandover(id, docIds, decision, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    if (currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    const nowIso = new Date().toISOString()
    const decideNote = String(note || '').trim()
    let result = { status: 'error' }

    try {
      await db.transaction('rw', db.handovers, db.docs, db.reviews, db.accessRequests, db.freshnessTickets, async () => {
        const h = await db.handovers.get(id)
        if (!h) { result = { status: 'missing' }; return }
        const wanted = new Set(docIds || [])
        // 事务内复核：目标篇必须仍处于「已确认待批准」（防止多窗口重复审批）
        const actionable = (h.items || []).filter((it) => wanted.has(it.docId) && it.status === HO_ITEM.CONFIRMED)
        if (!actionable.length) { result = { status: 'changed', handover: h }; return }

        const items = [...h.items]
        const timeline = [...(h.timeline || [])]
        const patchItem = (docId, patch) => {
          const idx = items.findIndex((it) => it.docId === docId)
          items[idx] = { ...items[idx], ...patch }
        }
        const noteOf = (title) => '《' + title + '》' + (decideNote ? '：' + decideNote : '')

        if (decision === 'reject') {
          for (const it of actionable) {
            patchItem(it.docId, { status: HO_ITEM.REJECTED, decidedBy: userId, decidedAt: nowIso, decideNote })
            timeline.push(buildTimelineEntry('reject', userId, noteOf(it.title), nowIso))
          }
          const rejected = { ...h, items, timeline }
          rejected.status = handoverStatusOf(rejected)
          await db.handovers.put(rejected)
          result = { status: 'ok', approved: false, count: actionable.length, handover: rejected }
          return
        }

        // ① 并发变更校验：事务内重读本批全部文档，与发起快照逐篇对比
        const docMap = {}
        for (const it of actionable) docMap[it.docId] = (await db.docs.get(it.docId)) || null
        const conflicts = checkHandoverConflicts(actionable, docMap)
        const conflictIds = new Set(conflicts.map((c) => c.docId))
        const failures = []

        // 冲突篇：标记失败回退（不写入该篇任何转移），原因随篇留档
        for (const c of conflicts) {
          const failReason = '交接期间文档发生并发变更：' + c.fields.join('、') + '。该篇未执行任何转移，请确认后重新发起。'
          patchItem(c.docId, { status: HO_ITEM.FAILED, decidedBy: userId, decidedAt: nowIso, decideNote, failReason })
          timeline.push(buildTimelineEntry('fail', userId, '《' + c.title + '》' + failReason, nowIso))
          failures.push({ docId: c.docId, title: c.title, fields: c.fields })
        }

        // ② 一致篇逐篇转移（同一事务，任一写入异常整体回滚）
        const from = h.fromUserId
        let done = 0
        for (const item of actionable) {
          if (conflictIds.has(item.docId)) continue
          const doc = docMap[item.docId]
          const to = item.toUserId

          // 所有权：交接给该篇接任者；原负责人任期追加进 ownerHistory（历史归属保留）
          const ownerHistory = [
            ...(doc.ownerHistory || []),
            { ownerId: from, until: nowIso, handoverId: h.id, toUserId: to }
          ]
          // 协作成员：接任者加入；按交接决定保留/移出原负责人
          let editors = [...(doc.editors || [])]
          if (!editors.includes(to)) editors.push(to)
          if (h.revokeMode === REVOKE_MODE.REVOKE) editors = editors.filter((e) => e !== from)
          await db.docs.update(doc.id, { ownerId: to, editors, ownerHistory })

          // 待办审批（评审）：文档上流转中的评审单，原负责人名下的改挂接任者并留痕
          const transferredReviewIds = []
          const pendingReviews = await db.reviews
            .where('docId').equals(doc.id)
            .filter((r) => r.status === 'pending').toArray()
          for (const rv of pendingReviews) {
            if (rv.submittedBy !== from) continue
            await db.reviews.update(rv.id, {
              submittedBy: to,
              timeline: [...(rv.timeline || []), buildTimelineEntry('handover', userId, '负责人交接：评审待办随文档责任转移给接任者', nowIso)]
            })
            transferredReviewIds.push(rv.id)
          }

          // 保鲜责任：复核周期随所有权转移；流转中的复核单留痕并改挂送审人
          let freshTicketId = null
          const openFresh = await db.freshnessTickets
            .where('docId').equals(doc.id)
            .filter((t) => isFreshTicketOpen(t)).first()
          if (openFresh) {
            await db.freshnessTickets.update(openFresh.id, {
              ...(openFresh.submittedBy === from ? { submittedBy: to } : {}),
              timeline: [...(openFresh.timeline || []), buildFreshTimelineEntry('handover', userId, '负责人交接：保鲜复核责任转移给接任者', nowIso)]
            })
            freshTicketId = openFresh.id
          }

          // 待办审批（访问申请）：审批责任随所有权自动转移，此处统计留痕
          const accessPending = await db.accessRequests
            .where('docId').equals(doc.id)
            .filter((r) => r.status === ACCESS.PENDING).count()

          // 按交接决定收回原负责人在本文档上的有效限时授权（阅读/协作）
          let revokedGrants = 0
          if (h.revokeMode === REVOKE_MODE.REVOKE) {
            const grants = await db.accessRequests
              .where('docId').equals(doc.id)
              .filter((r) => r.applicantId === from && isGrantActive(r, new Date(nowIso))).toArray()
            for (const g of grants) {
              await db.accessRequests.update(g.id, {
                status: ACCESS.REVOKED,
                revokedAt: nowIso,
                grant: { ...(g.grant || {}), revokedAt: nowIso },
                timeline: [...(g.timeline || []), buildAccessTimelineEntry('revoke', userId, '负责人交接，按交接决定收回原负责人权限', nowIso)]
              })
              revokedGrants++
            }
          }

          patchItem(item.docId, {
            status: HO_ITEM.COMPLETED,
            decidedBy: userId, decidedAt: nowIso, decideNote,
            completedAt: nowIso,
            result: { reviewIds: transferredReviewIds, freshTicketId, accessPending, revokedGrants }
          })
          timeline.push(buildTimelineEntry('approve', userId, noteOf(item.title), nowIso))
          done++
        }

        // ③ 交接单更新：逐篇结果随单留档，整体状态由篇状态派生
        const updated = { ...h, items, timeline }
        updated.status = handoverStatusOf(updated)
        await db.handovers.put(updated)
        result = { status: 'ok', approved: true, done, failures, handover: updated }
      })
    } catch (e) {
      // 转移途中异常：事务已整体回滚（本批无任何部分转移），目标篇补记失败留痕，可排查后重新发起
      const failReason = '交接执行异常，已整体回退：' + (e && e.message ? e.message : String(e))
      try {
        const cur = await db.handovers.get(id)
        if (cur) {
          const wanted = new Set(docIds || [])
          const items = (cur.items || []).map((it) =>
            wanted.has(it.docId) && it.status === HO_ITEM.CONFIRMED
              ? { ...it, status: HO_ITEM.FAILED, decidedBy: userId, decidedAt: nowIso, failReason }
              : it
          )
          const updated = { ...cur, items, timeline: [...(cur.timeline || []), buildTimelineEntry('fail', userId, failReason, nowIso)] }
          updated.status = handoverStatusOf(updated)
          await db.handovers.put(updated)
        }
      } catch { /* 补记失败本身出错时保持原状，篇仍处于流转态可重试 */ }
      result = { status: 'error' }
    }

    // 联动刷新：所有权/评审待办/授权/保鲜责任均已变化
    const [{ useReviewStore }, { useAccessStore }, { useFreshnessStore }] = await Promise.all([
      import('./review'), import('./access'), import('./freshness')
    ])
    const review = useReviewStore()
    const access = useAccessStore()
    const freshness = useFreshnessStore()
    await Promise.all([
      reload(),
      kb.reloadDocs(),
      review.loaded ? review.reload() : Promise.resolve(),
      access.loaded ? access.reload() : Promise.resolve(),
      freshness.loaded ? freshness.reload() : Promise.resolve()
    ])
    return result
  }

  return {
    handovers, loaded, loadAll, reload, sorted,
    pendingConfirmFor, pendingApprovalFor, initiatedBy, involvedIn,
    activeHandoverOfDoc, activeItemOfDoc, pendingCountFor,
    initiateHandover, confirmHandover, declineHandover, cancelHandover, decideHandover
  }
})
