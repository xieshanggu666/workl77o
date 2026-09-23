import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions } from '@/utils/version'
import { REVIEW, PUBLISH, buildTimelineEntry } from '@/utils/review'
import {
  FRESH, calcDueAt, isFreshnessEnabled, isFreshTicketOpen, canManageFreshness, buildFreshTimelineEntry,
  isDocOverride, materializeFromPolicy, RULE_SOURCE
} from '@/utils/freshness'
import { GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { canSubmitReview } from '@/utils/review'
import { isGrantActive, ACCESS_PERM } from '@/utils/access'
import { useKbStore } from './kb'

// 知识保鲜 store：
// 负责人（拥有者/管理员）为文档设置复核周期；管理员也可按分类批量设置复核策略，
// 无文档级覆盖的文档继承策略（物化到 doc.freshness，source='policy'），文档单独设置优先（source='doc'）。
// 策略调整时重算无在途复核单文档的到期计划；在途复核单保留规则快照（ruleSource/cycleDays），
// 本轮结案（批准）时按当时有效的规则（当前策略或文档覆盖）重算下一周期。
// 到期由响应式时钟 + 调度器自动生成复核单，文档立即退出问答引用；编辑者修订（或确认无需修订）送审，
// 复用内容评审单的锁定/审批通道；管理员批准后恢复引用并重算周期，驳回则在同一复核单上继续整改。
// 每轮复核单（freshnessTickets）与其 timeline 全程保留，批准通过同步在版本记录上追加保鲜标记。
// 与审批/撤回的联动（syncFreshTicket）在 review store 的同事务内调用，两边状态不会脱节。
export const useFreshnessStore = defineStore('freshness', () => {
  const tickets = ref([])
  const policies = ref([])
  const loaded = ref(false)
  // 响应式当前时间：到期判定（isDocCitable/isFreshDue）与调度器统一以它为准，
  // 页面停留期间到点也能即时生成复核单并从问答收回引用，无需刷新
  const now = ref(new Date())
  let dueTimer = null
  const MAX_TIMER_DELAY = 2147483647

  // 事务内查询用户在文档上的有效限时协作授权（送审资格随撤销/到期即时收回）
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
    // 历史/关闭页面期间到点的文档补生成复核单（幂等）
    await sweepDue()
  }

  async function reload() {
    const [t, p] = await Promise.all([db.freshnessTickets.toArray(), db.freshnessPolicies.toArray()])
    tickets.value = t
    policies.value = p
    now.value = new Date()
    scheduleDue()
  }

  // [categoryId] -> 分类复核策略，供文档面板/保鲜中心解析继承关系
  const policyMap = computed(() => Object.fromEntries(policies.value.map((p) => [p.categoryId, p])))

  function policyOfCategory(categoryId) {
    return policyMap.value[categoryId] || null
  }

  // [docId] -> 流转中的复核单，供文档/问答批量判定引用资格
  const activeTicketMap = computed(() => {
    const m = {}
    for (const t of tickets.value) if (isFreshTicketOpen(t)) m[t.docId] = t
    return m
  })

  function activeTicketOf(docId) {
    return activeTicketMap.value[docId] || null
  }

  function ticketsOfDoc(docId) {
    return tickets.value
      .filter((t) => t.docId === docId)
      .sort((a, b) => b.round - a.round || new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 我负责（拥有）的文档上流转中的复核单
  function openTicketsForOwner(userId, role, docs) {
    const docMap = docs && docs.length ? Object.fromEntries(docs.map((d) => [d.id, d])) : null
    return tickets.value
      .filter((t) => isFreshTicketOpen(t))
      .filter((t) => {
        if (role === ROLE.ADMIN) return true
        const doc = docMap ? docMap[t.docId] : null
        return doc && doc.ownerId === userId
      })
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
  }

  // 暂停问答引用的文档数（侧栏角标）
  const pausedCount = computed(() => {
    const ids = new Set()
    for (const t of tickets.value) if (isFreshTicketOpen(t)) ids.add(t.docId)
    return ids.size
  })

  // 待管理员处理（复核送审中）数量
  const submittedCount = computed(() => tickets.value.filter((t) => t.status === FRESH.SUBMITTED).length)

  // ---- 到期调度（与限时授权到期同一套响应式时钟模式）----

  // 调度下一次到点唤醒：仅看「启用保鲜、当前无流转复核单」的文档，
  // 到点推进时钟 → sweepDue 生成复核单 → 问答引用闸门即时关闭
  function scheduleDue() {
    if (dueTimer) { clearTimeout(dueTimer); dueTimer = null }
    const activeIds = new Set(tickets.value.filter((t) => isFreshTicketOpen(t)).map((t) => t.docId))
    let next = Infinity
    for (const d of useKbStore().docs || []) {
      if (!isFreshnessEnabled(d) || !d.freshness?.nextDueAt || activeIds.has(d.id)) continue
      const due = new Date(d.freshness.nextDueAt).getTime()
      if (due > now.value.getTime() && due < next) next = due
    }
    if (next === Infinity) return
    const delay = Math.min(Math.max(next - Date.now(), 0) + 50, MAX_TIMER_DELAY)
    dueTimer = setTimeout(onDueTick, delay)
  }

  async function onDueTick() {
    dueTimer = null
    now.value = new Date()
    await sweepDue()
    scheduleDue()
  }

  // 扫描全部启用保鲜的文档：周期到点且尚无流转复核单 → 自动生成复核单并暂停问答引用。
  // 幂等：以 doc.freshness.activeTicket / 既有 open 单判重，重复扫描不会为同一周期建多张单
  async function sweepDue() {
    const kb = useKbStore()
    await kb.loadAll()
    now.value = new Date()
    const nowDate = now.value
    const nowIso = nowDate.toISOString()
    const dueDocs = kb.docs.filter((d) => isFreshnessEnabled(d) && d.freshness?.nextDueAt && new Date(d.freshness.nextDueAt) <= nowDate)
    if (!dueDocs.length) return

    await db.transaction('rw', db.docs, db.reviews, db.freshnessTickets, async () => {
      for (const d0 of dueDocs) {
        const fresh = await db.docs.get(d0.id)
        if (!fresh || !isFreshnessEnabled(fresh) || !fresh.freshness.nextDueAt) continue
        if (new Date(fresh.freshness.nextDueAt) > new Date(nowIso)) continue
        // 库内最新判重：已有本周期流转中复核单（含刚被驳回待整改）则不重复生成
        const dup = await db.freshnessTickets
          .where('docId').equals(fresh.id)
          .filter((t) => isFreshTicketOpen(t)).first()
        if (dup) continue
        // 文档正处于普通内容评审中（锁定）时，等该评审完结后再生成保鲜复核单，避免锁与引用状态交错
        const pendingContentReview = await db.reviews
          .where('docId').equals(fresh.id)
          .filter((rv) => rv.status === REVIEW.PENDING && !rv.freshTicketId).first()
        if (pendingContentReview) continue

        const round = (fresh.freshness.round || 0) + 1
        const ticket = {
          id: uid('fr'),
          docId: fresh.id,
          round,
          status: FRESH.OPEN,
          cycleDays: Number(fresh.freshness.cycleDays),
          // 规则快照：本轮复核按生成时的周期与来源执行，后续策略调整/覆盖不改写当轮
          ruleSource: fresh.freshness.source === RULE_SOURCE.POLICY ? RULE_SOURCE.POLICY : RULE_SOURCE.DOC,
          policyId: fresh.freshness.policyId || null,
          dueAt: fresh.freshness.nextDueAt, // 本轮到期点（逾期时长据此展示）
          reviewId: null,
          submittedBy: null,
          submittedAt: null,
          decidedBy: null,
          decidedAt: null,
          decisionNote: '',
          createdAt: nowIso,
          timeline: [buildFreshTimelineEntry('due', 'system', '复核周期到点，自动生成复核单并暂停问答引用', nowIso)]
        }
        await db.freshnessTickets.add(ticket)
        await db.docs.update(fresh.id, { 'freshness.activeTicket': ticket.id })
      }
    })

    await Promise.all([reload(), kb.reloadDocs()])
  }

  // 负责人设置/调整复核周期（文档级单独设置，覆盖分类策略）。
  // - 首次启用：记录周期，nextDueAt 自当前起算；
  // - 调整周期（无流转复核单）：以当前时刻为基准重算到期点，保留历史轮次；
  // - 存在流转中复核单时不允许直接改周期，需先完成/作废本轮，避免周期与复核单脱节。
  // 返回 { status: 'ok' } | 'denied' | 'guest' | 'missing' | 'has-open' | 'bad-cycle'
  async function setFreshCycle(docId, cycleDays, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const days = Number(cycleDays)
    let result = { status: 'error' }
    if (!(days > 0)) return { status: 'bad-cycle' }

    await db.transaction('rw', db.docs, db.freshnessTickets, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (!canManageFreshness(doc, userId, role)) { result = { status: 'denied' }; return }
      const openT = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t)).first()
      if (openT) { result = { status: 'has-open', ticket: openT }; return }

      const nowIso0 = new Date().toISOString()
      const existed = isFreshnessEnabled(doc)
      const prevRound = doc.freshness?.round || 0
      const patch = {
        cycleDays: days,
        nextDueAt: calcDueAt(days, nowIso0),
        round: prevRound,
        activeTicket: null,
        // 文档单独设置：脱离分类策略，策略批量调整不再影响本文档
        source: RULE_SOURCE.DOC,
        policyId: null,
        updatedAt: nowIso0
      }
      await db.docs.update(docId, { freshness: patch })
      // 设置/调整动作留痕到最近一轮复核单（无历史单时仅写配置，不凭空建单）
      const lastTicket = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => t.status === FRESH.APPROVED || t.status === FRESH.CANCELLED).first()
      if (lastTicket) {
        const label = existed ? '调整复核周期为 ' + days + ' 天（文档单独设置）' : '开启知识保鲜，复核周期 ' + days + ' 天（文档单独设置）'
        await db.freshnessTickets.update(lastTicket.id, {
          timeline: [...(lastTicket.timeline || []), buildFreshTimelineEntry(existed ? 'change' : 'setting', userId, label, nowIso0)]
        })
      }
      result = { status: 'ok', action: existed ? 'change' : 'setting' }
    })

    await Promise.all([reload(), useKbStore().reloadDocs()])
    return result
  }

  // 管理员按分类批量设置/调整复核策略。
  // 同事务内：① 落策略记录（含 timeline 留痕）→ ② 重算继承文档的到期计划——
  // 仅处理「跟随策略（无文档级覆盖）且无在途复核单」的文档；在途复核单保留规则快照，
  // 本轮结案时按当时策略重算（见 syncFreshTicket）；文档级覆盖的文档不受影响。
  // 返回 { status: 'ok', policy, applied, skipped, kept } | 'denied' | 'guest' | 'bad-cycle' | 'no-category'
  async function setCategoryPolicy(categoryId, cycleDays, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const days = Number(cycleDays)
    if (!(days > 0)) return { status: 'bad-cycle' }
    if (!kb.categories.some((c) => c.id === categoryId)) return { status: 'no-category' }
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.freshnessTickets, db.freshnessPolicies, async () => {
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (role !== ROLE.ADMIN) { result = { status: 'denied' }; return }

      const nowIso = new Date().toISOString()
      const existing = await db.freshnessPolicies.where('categoryId').equals(categoryId).first()
      const policy = existing
        ? {
          ...existing,
          cycleDays: days,
          updatedBy: userId,
          updatedAt: nowIso,
          timeline: [...(existing.timeline || []), buildFreshTimelineEntry('policy-change', userId, '复核周期调整为 ' + days + ' 天，重算继承文档到期计划', nowIso)]
        }
        : {
          id: uid('fp'),
          categoryId,
          cycleDays: days,
          createdBy: userId,
          updatedBy: userId,
          createdAt: nowIso,
          updatedAt: nowIso,
          timeline: [buildFreshTimelineEntry('policy-setting', userId, '分类统一复核周期 ' + days + ' 天', nowIso)]
        }
      await db.freshnessPolicies.put(policy)

      // 重算到期计划：逐篇事务内重读，在途复核单（快照保留）与文档级覆盖都跳过
      let applied = 0
      let skipped = 0
      let kept = 0
      const docs = await db.docs.where('categoryId').equals(categoryId).toArray()
      for (const d of docs) {
        if (isDocOverride(d.freshness)) { kept++; continue }
        const openT = await db.freshnessTickets
          .where('docId').equals(d.id)
          .filter((t) => isFreshTicketOpen(t)).first()
        if (openT) { skipped++; continue }
        await db.docs.update(d.id, { freshness: materializeFromPolicy(policy, d.freshness, nowIso) })
        applied++
      }
      result = { status: 'ok', policy, applied, skipped, kept, action: existing ? 'change' : 'setting' }
    })

    await Promise.all([reload(), useKbStore().reloadDocs()])
    return result
  }

  // 管理员关闭分类复核策略：删除策略记录，跟随策略的文档分两路处理——
  // - 无在途复核单：清除保鲜配置，立即恢复问答引用（历史复核单保留）；
  // - 有在途复核单：按规则快照转为文档级配置，本轮及后续按快照周期继续（复核单留痕）。
  // 返回 { status: 'ok', cleared, converted } | 'denied' | 'guest' | 'missing'
  async function clearCategoryPolicy(categoryId, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.freshnessTickets, db.freshnessPolicies, async () => {
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (role !== ROLE.ADMIN) { result = { status: 'denied' }; return }
      const policy = await db.freshnessPolicies.where('categoryId').equals(categoryId).first()
      if (!policy) { result = { status: 'missing' }; return }

      const nowIso = new Date().toISOString()
      await db.freshnessPolicies.delete(policy.id)

      let cleared = 0
      let converted = 0
      const docs = await db.docs.where('categoryId').equals(categoryId).toArray()
      for (const d of docs) {
        // 只处理跟随本策略的文档；文档级覆盖与其它来源不动
        if (!d.freshness || d.freshness.source !== RULE_SOURCE.POLICY) continue
        const openT = await db.freshnessTickets
          .where('docId').equals(d.id)
          .filter((t) => isFreshTicketOpen(t)).first()
        if (openT) {
          // 在途复核单保留规则快照：转为文档级配置继续本轮，审批时按快照周期重算
          await db.docs.update(d.id, { 'freshness.source': RULE_SOURCE.DOC, 'freshness.policyId': null })
          await db.freshnessTickets.update(openT.id, {
            timeline: [...(openT.timeline || []), buildFreshTimelineEntry('policy-convert', userId, '分类策略已关闭，本轮及后续按快照周期转为文档级配置', nowIso)]
          })
          converted++
        } else {
          await db.docs.update(d.id, { freshness: null })
          // 退出保鲜留痕到最近一轮复核单（与逐篇关闭保鲜同一模式）
          const lastTicket = await db.freshnessTickets
            .where('docId').equals(d.id)
            .filter((t) => t.status === FRESH.APPROVED || t.status === FRESH.CANCELLED).first()
          if (lastTicket) {
            await db.freshnessTickets.update(lastTicket.id, {
              timeline: [...(lastTicket.timeline || []), buildFreshTimelineEntry('policy-disable', userId, '分类复核策略已关闭，文档退出知识保鲜', nowIso)]
            })
          }
          cleared++
        }
      }
      result = { status: 'ok', cleared, converted }
    })

    await Promise.all([reload(), useKbStore().reloadDocs()])
    return result
  }

  // 负责人取消文档级覆盖，恢复跟随分类策略（按策略周期自当前重算到期点）。
  // 返回 { status: 'ok' } | 'denied' | 'guest' | 'missing' | 'has-open' | 'no-policy'
  async function resetToPolicy(docId, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.freshnessTickets, db.freshnessPolicies, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (!canManageFreshness(doc, userId, role)) { result = { status: 'denied' }; return }
      const openT = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t)).first()
      if (openT) { result = { status: 'has-open', ticket: openT }; return }
      const policy = await db.freshnessPolicies.where('categoryId').equals(doc.categoryId).first()
      if (!policy) { result = { status: 'no-policy' }; return }

      const nowIso = new Date().toISOString()
      await db.docs.update(docId, { freshness: materializeFromPolicy(policy, doc.freshness, nowIso) })
      const lastTicket = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => t.status === FRESH.APPROVED || t.status === FRESH.CANCELLED).first()
      if (lastTicket) {
        await db.freshnessTickets.update(lastTicket.id, {
          timeline: [...(lastTicket.timeline || []), buildFreshTimelineEntry('reset-policy', userId, '恢复跟随分类策略（' + policy.cycleDays + ' 天）', nowIso)]
        })
      }
      result = { status: 'ok' }
    })

    await Promise.all([reload(), useKbStore().reloadDocs()])
    return result
  }

  // 负责人关闭知识保鲜：当前流转中复核单作废（CANCELLED，记录保留），文档恢复正常引用
  async function disableFreshness(docId, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.freshnessTickets, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (!canManageFreshness(doc, userId, role)) { result = { status: 'denied' }; return }

      const nowIso = new Date().toISOString()
      const openList = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t)).toArray()
      for (const t of openList) {
        // 送审中的保鲜复核需先撤回评审单（评审单由评审中心处理）；这里只允许在评审单已撤回/完结时作废
        if (t.status === FRESH.SUBMITTED && t.reviewId) { result = { status: 'in-review', ticket: t }; return }
        await db.freshnessTickets.put({
          ...t,
          status: FRESH.CANCELLED,
          decidedBy: userId,
          decidedAt: nowIso,
          timeline: [...(t.timeline || []), buildFreshTimelineEntry('cancel', userId, '关闭知识保鲜，作废本轮复核单', nowIso)]
        })
      }
      await db.docs.update(docId, { freshness: null })
      result = { status: 'ok' }
    })

    await Promise.all([reload(), useKbStore().reloadDocs()])
    return result
  }

  // 编辑者保鲜复核送审：在同一事务内建内容评审单、锁文档、关联当轮复核单。
  // noChange=true 表示负责人/编辑者确认内容仍然有效、无需修订（快照=当前内容，批准后不回写）。
  // 返回 { status: 'ok', review } | 'missing' | 'denied' | 'guest' | 'duplicate' | 'no-ticket' | 'closed'
  async function submitFreshReview(docId, patch, note, noChange, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const nowIso = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.comments, db.freshnessTickets, db.accessRequests, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      const ticket = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t)).first()
      if (!ticket) { result = { status: 'no-ticket' }; return }
      if (ticket.status === FRESH.SUBMITTED) { result = { status: 'duplicate', ticket }; return }
      const existingPending = await db.reviews
        .where('docId').equals(docId)
        .filter((r) => r.status === REVIEW.PENDING).first()
      // 保鲜修订送审同样走文档写入资格：访客/只读/无关系编辑者不可发起，限时协作授权随撤销/到期收回
      if (!canSubmitReview(doc, { userId, role, grant: await findCollabGrant(docId, userId) }, existingPending)) {
        result = isGuestUser(userId) ? { status: 'guest' } : { status: 'denied' }
        return
      }
      if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }

      const snapshot = noChange
        ? { title: doc.title, body: doc.body, categoryId: doc.categoryId, tagIds: [...(doc.tagIds || [])], visibility: doc.visibility }
        : {
          title: patch.title, body: patch.body, categoryId: patch.categoryId,
          tagIds: patch.tagIds || [], visibility: patch.visibility
        }
      const review = {
        id: uid('rev'),
        docId,
        status: REVIEW.PENDING,
        submittedBy: userId,
        submittedAt: nowIso,
        snapshot,
        baseVersion: ensureVersions(doc, nowIso).length,
        freshTicketId: ticket.id,
        freshRound: ticket.round,
        freshNoChange: !!noChange,
        decidedBy: null, decidedAt: null, decisionNote: '',
        timeline: [buildTimelineEntry(noChange ? 'fresh-submit-nochange' : 'fresh-submit', userId, note, nowIso)]
      }
      await db.reviews.add(review)
      await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

      const freshAction = ticket.status === FRESH.REJECTED ? 'resubmit' : (noChange ? 'submit-nochange' : 'submit')
      await db.freshnessTickets.put({
        ...ticket,
        status: FRESH.SUBMITTED,
        reviewId: review.id,
        submittedBy: userId,
        submittedAt: nowIso,
        timeline: [...(ticket.timeline || []), buildFreshTimelineEntry(freshAction, userId, note, nowIso)]
      })

      if (note && note.trim()) {
        await db.comments.add({
          id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
          content: note.trim(), mentionIds: [], createdAt: nowIso
        })
      }
      result = { status: 'ok', review, ticket }
    })

    const { useReviewStore: useReview } = await import('./review')
    await Promise.all([reload(), kb.reloadDocs(), useReview().reload()])
    return result
  }

  // 审批/撤回事务内联动复核单（由 review store 在同事务调用，tables 含 db.freshnessTickets，
  // approve 路径还需含 db.freshnessPolicies 以解析当前分类策略）。
  // approve：复核通过 → 恢复引用、按当前有效规则重算到期点、写入版本标记由 review store 完成；
  //           继承策略的文档按「当前分类策略」重算（策略调整即刻生效于下一周期），
  //           策略已关闭的按在途复核单的规则快照转为文档级配置；复核单自身快照不改写。
  // reject ：驳回 → 复核单回到待整改，解除与评审单的送审关联，问答引用继续暂停；
  // withdraw：撤回送审 → 同 reject，回到待整改。
  async function syncFreshTicket(review, action, note, userId, nowIso) {
    if (!review?.freshTicketId) return
    const ticket = await db.freshnessTickets.get(review.freshTicketId)
    if (!ticket) return

    if (action === 'approve') {
      const doc = await db.docs.get(review.docId)
      // 解析结案后生效的规则：文档级覆盖用文档当前周期（流转中不可改，与快照一致）；
      // 继承策略用当前分类策略周期；策略已关闭则回落到复核单快照周期并转为文档级
      const cur = doc?.freshness || {}
      let cycleDays = Number(ticket.cycleDays)
      let source = cur.source === RULE_SOURCE.POLICY ? RULE_SOURCE.POLICY : RULE_SOURCE.DOC
      let policyId = cur.policyId || null
      if (source === RULE_SOURCE.POLICY) {
        const pol = doc?.categoryId
          ? await db.freshnessPolicies.where('categoryId').equals(doc.categoryId).first()
          : null
        if (pol) {
          cycleDays = Number(pol.cycleDays)
          policyId = pol.id
        } else {
          source = RULE_SOURCE.DOC
          policyId = null
        }
      } else if (isDocOverride(cur) && Number(cur.cycleDays) > 0) {
        cycleDays = Number(cur.cycleDays)
      }
      const nextDueAt = calcDueAt(cycleDays, nowIso)
      const approved = {
        ...ticket,
        status: FRESH.APPROVED,
        decidedBy: userId,
        decidedAt: nowIso,
        decisionNote: note || '',
        nextDueAt
      }
      await db.freshnessTickets.put(approved)
      if (doc) {
        await db.docs.update(review.docId, {
          freshness: {
            cycleDays,
            nextDueAt,
            round: ticket.round,
            activeTicket: null,
            source,
            policyId,
            lastApprovedAt: nowIso,
            lastApprovedBy: userId,
            lastReviewId: review.id
          }
        })
      }
    } else {
      const rejected = action === 'reject'
      await db.freshnessTickets.put({
        ...ticket,
        status: rejected ? FRESH.REJECTED : FRESH.OPEN,
        reviewId: null,
        decidedBy: rejected ? userId : null,
        decidedAt: rejected ? nowIso : null,
        decisionNote: rejected ? (note || '') : '',
        timeline: [
          ...(ticket.timeline || []),
          buildFreshTimelineEntry(rejected ? 'reject' : 'withdraw', userId, note, rejected ? nowIso : nowIso)
        ]
      })
      // activeTicket 仍指向本单（open/rejected 都是流转态），文档保持暂停引用
    }
  }

  // 删除文档时连带清理保鲜复核单
  async function deleteFreshnessOfDoc(docId) {
    await db.freshnessTickets.where('docId').equals(docId).delete()
    if (loaded.value) await reload()
  }

  return {
    tickets, policies, loaded, now, loadAll, reload,
    activeTicketMap, activeTicketOf, ticketsOfDoc, openTicketsForOwner,
    policyMap, policyOfCategory,
    pausedCount, submittedCount,
    sweepDue, setFreshCycle, setCategoryPolicy, clearCategoryPolicy, resetToPolicy,
    disableFreshness, submitFreshReview, syncFreshTicket, deleteFreshnessOfDoc
  }
})
