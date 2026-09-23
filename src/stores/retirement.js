import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import {
  RETIRE, RETIRE_BATCH, isRetirementOpen, isRetirementActive,
  retirementBatchStatusOf
} from '@/utils/retirement'
import { checkRetirementBatch } from '@/utils/retirement'
import {
  RETIRE_JOB_KIND, RETIRE_JOB, RETIRE_JOB_ITEM,
  RETIRE_JOB_CHUNK_SIZE, RETIRE_JOB_MAX_ITEM_ATTEMPTS,
  isTransientRetirementError, isJobItemRemaining, jobProgressOf, isJobResumable,
  classifyRetirementStepResult
} from '@/utils/retirementJob'
import { GAP } from '@/utils/gap'
import { isItemOpen } from '@/utils/handover'
import { GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { useKbStore } from './kb'

// 知识退役替代 store：
// 负责人发起文档退役并指定替代文档（pending）→ 管理员逐篇批准（approved），在同一事务内：
// - doc.retirement 记录生效退役，旧文档立即停止搜索命中与问答引用（详情仍可访问）；
// - 旧文档全部「有效」共享链接批量撤销（revokedAt + 撤销原因，记录保留不删除）；
// - 已解决缺口工单（resolved、答案来源指向旧文档）的 docId 改挂替代文档并逐条留痕；
// 管理员可逐篇驳回（rejected）、发起人审批前可撤销（cancelled）；退役生效后发起人/管理员可撤销退役
// （revoked）：同事务恢复搜索/问答引用、恢复被本次退役撤销的共享链接、答案来源回挂旧文档。
// 批量送审：负责人可一次为多篇文档分别指定替代文档（retirementBatches 批次挂 N 张退役单），
// 同一事务内逐篇校验（含批次内替代链冲突），任一篇不合法整体送审失败并逐行返回原因；
// 管理员仍逐篇批准/驳回（各篇联动彼此独立），批次状态由各篇退役单派生；
// 审批前可整体取消批次、生效后可批量撤销（逐篇独立事务，单篇失败不影响其他篇）。
// 分批编排（retirementJobs）：批量批准/批量撤销升级为可重试的分批编排任务——
// - 任务持久化，分片逐篇独立事务执行：单篇的文档退役态/共享链接/答案来源联动原子提交，
//   进程中断即整体回滚该篇，不产生跨文档半联动状态；
// - 暂态失败（事务中断/配额等环境异常）就地重试；业务冲突（评审中/替代冲突/状态已变化等）
//   隔离为篇目级冲突，不阻塞同批其他篇；
// - 部分失败/中断可续跑：剩余篇目（含冲突、失败、执行中残留）逐篇幂等重判，已成功篇目不重复联动；
// - 全链路留痕：批次 timeline ↔ 任务 timeline/篇目 history ↔ 退役单 timeline ↔ 链接/工单记录。
// 退役单（retirements）与其 timeline、批次（retirementBatches）、编排任务（retirementJobs）、
// 联动结果（effects）全程保留。
export const useRetirementStore = defineStore('retirement', () => {
  const retirements = ref([])
  const batches = ref([])
  const jobs = ref([])
  // 本会话内正在执行的编排任务 id（用于停止请求与防重入；持久化状态以库中记录为准）
  const executingJobIds = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    const [rs, bs, js] = await Promise.all([
      db.retirements.toArray(), db.retirementBatches.toArray(), db.retirementJobs.toArray()
    ])
    retirements.value = rs
    batches.value = bs
    jobs.value = js
  }

  const sorted = computed(() =>
    [...retirements.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  const sortedBatches = computed(() =>
    [...batches.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  // 某文档流转中（待审批）的退役单：同一文档同时只允许一个
  function openRetirementOfDoc(docId) {
    return retirements.value.find((r) => isRetirementOpen(r) && r.docId === docId) || null
  }

  // 某文档当前生效退役（旧文档退役态）
  function activeRetirementOfDoc(docId) {
    return retirements.value.find((r) => isRetirementActive(r) && r.docId === docId) || null
  }

  // 某文档是否被某条生效退役指定为替代文档（用于阻止替代文档自身被退役/删除）
  function activeRetirementUsingAsReplacement(docId) {
    return retirements.value.find((r) => isRetirementActive(r) && r.replacementDocId === docId) || null
  }

  // 某文档是否被某条流转中退役指定为替代文档（文档间替代冲突：先完成/撤销该在途退役）
  function openRetirementUsingAsReplacement(docId) {
    return retirements.value.find((r) => isRetirementOpen(r) && r.replacementDocId === docId) || null
  }

  // 某文档被任意在途/生效退役用作替代文档
  function retirementUsingAsReplacement(docId) {
    return activeRetirementUsingAsReplacement(docId) || openRetirementUsingAsReplacement(docId)
  }

  function batchById(batchId) {
    return batches.value.find((b) => b.id === batchId) || null
  }

  // 批次内退役单（按批次创建顺序）
  function itemsOfBatch(batchId) {
    return retirements.value
      .filter((r) => r.batchId === batchId)
      .sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0))
  }

  const batchStatusById = computed(() => {
    const map = {}
    for (const b of batches.value) map[b.id] = retirementBatchStatusOf(itemsOfBatch(b.id))
    return map
  })

  // ---- 分批编排任务查询 ----

  function jobById(jobId) {
    return jobs.value.find((j) => j.id === jobId) || null
  }

  // 批次下的编排任务（创建时间倒序）
  function jobsOfBatch(batchId) {
    return jobs.value
      .filter((j) => j.batchId === batchId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 批次下某类任务的最新一条
  function latestJobOfBatch(batchId, kind) {
    return jobsOfBatch(batchId).find((j) => !kind || j.kind === kind) || null
  }

  // 任务是否正在本会话执行中
  function isJobExecuting(jobId) {
    return executingJobIds.value.includes(jobId)
  }

  // 可续跑任务（部分失败/中断/已停止且仍有剩余篇目，且未在执行中）：供全局提醒
  const resumableJobs = computed(() =>
    jobs.value.filter((j) => isJobResumable(j) && !isJobExecuting(j.id))
  )

  function pendingApprovalFor(role) {
    if (role !== ROLE.ADMIN) return []
    return sorted.value.filter((r) => r.status === RETIRE.PENDING)
  }

  function initiatedBy(userId) {
    return sorted.value.filter((r) => r.initiatedBy === userId)
  }

  function involvedIn(userId) {
    return sorted.value.filter((r) => r.initiatedBy === userId || r.replacementOwnerId === userId)
  }

  // 侧栏角标：（管理员）待审批退役单数
  function pendingCountFor(role) {
    return pendingApprovalFor(role).length
  }

  // 发起退役：事务内逐篇/逐条复核归属、替代文档合法性与各类占用（评审/交接/退役）
  // 返回 { status: 'ok', retirement } | 'guest' | 'denied' | 'missing' | 'bad-replacement'
  //       | 'replacement-retired' | 'in-retirement' | 'in-review' | 'in-handover'
  async function initiateRetirement({ docId, replacementDocId, reason }, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.retirements, db.reviews, db.handovers, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (doc.ownerId !== userId && role !== ROLE.ADMIN) { result = { status: 'denied', title: doc.title }; return }
      if (doc.retirement?.status === RETIRE.APPROVED) { result = { status: 'in-retirement', title: doc.title }; return }

      const dup = await db.retirements.filter((r) => isRetirementOpen(r) && r.docId === docId).first()
      if (dup) { result = { status: 'in-retirement', title: doc.title, retirement: dup }; return }

      // 文档间替代冲突：本文档正作为他人在途/生效退役的替代文档，退役它会让替代链断裂或成环
      const usedActive = await db.retirements
        .filter((r) => isRetirementActive(r) && r.replacementDocId === docId).first()
      const usedOpen = await db.retirements
        .filter((r) => isRetirementOpen(r) && r.replacementDocId === docId).first()
      if (usedActive || usedOpen) { result = { status: 'used-as-replacement', title: (usedActive || usedOpen).docTitle || doc.title }; return }

      // 替代文档合法性
      if (!replacementDocId || replacementDocId === docId) { result = { status: 'bad-replacement' }; return }
      const replacement = await db.docs.get(replacementDocId)
      if (!replacement) { result = { status: 'bad-replacement' }; return }
      if (replacement.retirement?.status === RETIRE.APPROVED) { result = { status: 'replacement-retired', title: replacement.title }; return }
      const repOpen = await db.retirements.filter((r) => isRetirementOpen(r) && r.docId === replacementDocId).first()
      if (repOpen) { result = { status: 'replacement-retired', title: replacement.title }; return }

      // 评审中的文档先走完评审再退役，避免锁定与引用状态交错
      const pendingReview = await db.reviews
        .where('docId').equals(docId)
        .filter((rv) => rv.status === 'pending').first()
      if (pendingReview) { result = { status: 'in-review', title: doc.title }; return }

      // 交接中的文档先完成/取消交接，避免所有权与退役责任交错（按篇判定：该篇仍在流转才占用）
      const handover = await db.handovers.filter((h) => (h.items || []).some((i) => i.docId === docId && isItemOpen(i))).first()
      if (handover) { result = { status: 'in-handover', title: doc.title }; return }

      const retirement = {
        id: uid('rt'),
        status: RETIRE.PENDING,
        docId,
        docTitle: doc.title,
        replacementDocId,
        replacementTitle: replacement.title,
        replacementOwnerId: replacement.ownerId,
        initiatedBy: userId,
        reason: String(reason || '').trim(),
        createdAt: nowIso,
        decidedBy: null,
        decidedAt: null,
        decideNote: '',
        approvedAt: null,
        revokedBy: null,
        revokedAt: null,
        revokeNote: '',
        // effects：批准/撤销退役时的联动结果（改挂的工单、撤销的共享链接），撤销时据此逐项还原
        effects: null,
        timeline: [buildTimelineEntry('initiate', userId, reason, nowIso)]
      }
      await db.retirements.add(retirement)
      result = { status: 'ok', retirement }
    })

    await reload()
    return result
  }

  // 同步批次整体状态（由各篇退役单派生）；须在退役单写入后、同一事务作用域内调用
  async function syncBatchInTx(batchId, entry) {
    if (!batchId) return
    const items = await db.retirements.where('batchId').equals(batchId).toArray()
    const batch = await db.retirementBatches.get(batchId)
    if (!batch) return
    const status = retirementBatchStatusOf(items)
    const nowIso = new Date().toISOString()
    const patch = { status, total: items.length, updatedAt: nowIso }
    if (status !== RETIRE_BATCH.ACTIVE && !batch.resolvedAt) patch.resolvedAt = nowIso
    if (status === RETIRE_BATCH.ACTIVE) patch.resolvedAt = null
    await db.retirementBatches.put({
      ...batch,
      ...patch,
      timeline: entry ? [...(batch.timeline || []), entry] : (batch.timeline || [])
    })
  }

  // 批量送审：一次为多篇文档分别指定替代文档并统一送审。
  // rows: [{ docId, replacementDocId, reason? }]；note 为批次级统一退役原因（篇级 reason 可选覆盖）
  // 同一事务内逐篇复核归属、替代合法性、评审/交接占用与文档间替代冲突（含同批成链），
  // 任一篇不合法 → 整体送审失败（不产生任何退役单），逐行返回原因供发起人调整。
  // 返回 { status:'ok', batch, retirements } | 'guest' | 'no-docs'
  //      | { status:'invalid', rows: checkRetirementBatch 结果 }
  async function initiateRetirementBatch({ rows, note }, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    const role = currentUser?.role || null
    const cleanRows = (rows || []).filter((x) => x && x.docId)
    if (!cleanRows.length) return { status: 'no-docs' }
    const nowIso = new Date().toISOString()
    const batchNote = String(note || '').trim()
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.docs, db.retirements, db.retirementBatches, db.reviews, db.handovers,
      async () => {
        // 事务内统一读出校验上下文，逐篇复核以库中最新数据为准
        const docCache = {}
        const docOf = async (id) => {
          if (!(id in docCache)) docCache[id] = await db.docs.get(id)
          return docCache[id]
        }
        const docs = {}
        for (const row of cleanRows) {
          docs[row.docId] = await docOf(row.docId)
          if (row.replacementDocId) docs[row.replacementDocId] = await docOf(row.replacementDocId)
        }
        // 退役占用判断直接读库（非内存快照），保证事务内看到其他窗口已提交的最新在途/生效单
        const allRetirements = await db.retirements.toArray()
        const openCache = new Map()
        const activeCache = new Map()
        const openRepCache = new Map()
        const activeRepCache = new Map()
        const reviewCache = new Map()
        const handoverCache = new Map()
        const openRetirementOfDoc = (id) => {
          if (!openCache.has(id)) openCache.set(id, allRetirements.find((r) => isRetirementOpen(r) && r.docId === id) || null)
          return openCache.get(id)
        }
        const activeRetirementOfDoc = (id) => {
          if (!activeCache.has(id)) activeCache.set(id, allRetirements.find((r) => isRetirementActive(r) && r.docId === id) || null)
          return activeCache.get(id)
        }
        const openUsingAsReplacement = (id) => {
          if (!openRepCache.has(id)) openRepCache.set(id, allRetirements.find((r) => isRetirementOpen(r) && r.replacementDocId === id) || null)
          return openRepCache.get(id)
        }
        const activeUsingAsReplacement = (id) => {
          if (!activeRepCache.has(id)) activeRepCache.set(id, allRetirements.find((r) => isRetirementActive(r) && r.replacementDocId === id) || null)
          return activeRepCache.get(id)
        }
        // 评审/交接占用：事务内预取全部待退役文档的最新状态，checkRetirementBatch 按同步 Map 查询
        const allOldIds = [...new Set(cleanRows.map((x) => x.docId))]
        await Promise.all(allOldIds.map(async (id) => {
          const [rv, ho] = await Promise.all([
            db.reviews.where('docId').equals(id).filter((x) => x.status === 'pending').first(),
            db.handovers.filter((h) => (h.items || []).some((i) => i.docId === id && isItemOpen(i))).first()
          ])
          reviewCache.set(id, rv || null)
          handoverCache.set(id, ho || null)
        }))
        const pendingReviewOfDoc = (id) => reviewCache.get(id) || null
        const openHandoverOfDoc = (id) => handoverCache.get(id) || null

        const checked = checkRetirementBatch(cleanRows, {
          docOf: (id) => docs[id] || null,
          userId, role,
          openRetirementOfDoc, activeRetirementOfDoc,
          openUsingAsReplacement, activeUsingAsReplacement,
          pendingReviewOfDoc, openHandoverOfDoc
        })
        if (checked.rows.some((r) => r.error)) { result = { status: 'invalid', rows: checked.rows }; return }

        // 归属复核（checkRetirementBatch 的 ctx 未带权限信息，统一在此判定）
        for (const row of checked.rows) {
          const doc = docs[row.docId]
          if (doc.ownerId !== userId && role !== ROLE.ADMIN) {
            row.error = 'denied'
          }
        }
        if (checked.rows.some((r) => r.error)) { result = { status: 'invalid', rows: checked.rows }; return }

        const batchId = uid('rtb')
        const created = []
        for (let i = 0; i < checked.rows.length; i++) {
          const row = checked.rows[i]
          const doc = docs[row.docId]
          const replacement = docs[row.replacementDocId]
          const reason = row.reason || batchNote
          const retirement = {
            id: uid('rt'),
            status: RETIRE.PENDING,
            docId: doc.id,
            docTitle: doc.title,
            replacementDocId: replacement.id,
            replacementTitle: replacement.title,
            replacementOwnerId: replacement.ownerId,
            initiatedBy: userId,
            reason,
            createdAt: nowIso,
            decidedBy: null,
            decidedAt: null,
            decideNote: '',
            approvedAt: null,
            revokedBy: null,
            revokedAt: null,
            revokeNote: '',
            batchId,
            batchIndex: i,
            effects: null,
            timeline: [buildTimelineEntry('batch-submit', userId, '随批次 ' + batchId + ' 统一送审' + (reason ? '：' + reason : ''), nowIso)]
          }
          await db.retirements.add(retirement)
          created.push(retirement)
        }

        const batch = {
          id: batchId,
          status: RETIRE_BATCH.ACTIVE,
          initiatedBy: userId,
          total: created.length,
          note: batchNote,
          docIds: created.map((r) => r.docId),
          createdAt: nowIso,
          updatedAt: nowIso,
          resolvedAt: null,
          timeline: [buildTimelineEntry('initiate', userId, '统一送审 ' + created.length + ' 篇' + (batchNote ? '：' + batchNote : ''), nowIso)]
        }
        await db.retirementBatches.add(batch)
        result = { status: 'ok', batch, retirements: created }
      }
    )

    await reload()
    return result
  }

  // 发起人在审批前撤销退役申请
  async function cancelRetirement(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.retirements, db.retirementBatches, async () => {
      const r = await db.retirements.get(id)
      if (!r) { result = { status: 'missing' }; return }
      if (!isRetirementOpen(r)) { result = { status: 'changed', retirement: r }; return }
      if (r.initiatedBy !== userId && role !== ROLE.ADMIN) { result = { status: 'denied' }; return }
      const updated = {
        ...r,
        status: RETIRE.CANCELLED,
        timeline: [...(r.timeline || []), buildTimelineEntry('cancel', userId, '', nowIso)]
      }
      await db.retirements.put(updated)
      await syncBatchInTx(r.batchId, r.batchId
        ? buildTimelineEntry('batch-cancel', userId, '《' + r.docTitle + '》申请已撤销', nowIso)
        : null)
      result = { status: 'ok', retirement: updated }
    })

    await reload()
    return result
  }

  // 管理员审批：reject 驳回（文档保持原状）/ approve 生效（同事务执行全部联动）
  async function decideRetirement(id, decision, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    if (currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    const nowIso = new Date().toISOString()
    const decideNote = String(note || '').trim()
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.retirements, db.retirementBatches, db.docs, db.shares, db.gapTickets, db.reviews, db.handovers,
      async () => {
        const r = await db.retirements.get(id)
        if (!r) { result = { status: 'missing' }; return }
        if (!isRetirementOpen(r)) { result = { status: 'changed', retirement: r }; return }

        if (decision === 'reject') {
          const rejected = {
            ...r,
            status: RETIRE.REJECTED,
            decidedBy: userId,
            decidedAt: nowIso,
            decideNote,
            timeline: [...(r.timeline || []), buildTimelineEntry('reject', userId, decideNote, nowIso)]
          }
          await db.retirements.put(rejected)
          await syncBatchInTx(r.batchId, r.batchId
            ? buildTimelineEntry('reject', userId, '《' + r.docTitle + '》已驳回' + (decideNote ? '：' + decideNote : ''), nowIso)
            : null)
          result = { status: 'ok', approved: false, retirement: rejected }
          return
        }

        // ---- 批准生效：事务内重读，复核并发变更 ----
        const doc = await db.docs.get(r.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }
        const replacement = await db.docs.get(r.replacementDocId)
        if (!replacement) { result = { status: 'replacement-missing' }; return }
        // 替代文档在审批期间也被退役 → 不允许（避免替代链落到已退役文档）
        if (replacement.retirement?.status === RETIRE.APPROVED) { result = { status: 'replacement-retired', title: replacement.title }; return }
        // 文档间替代冲突（审批期间兜底）：本文档被他单作为替代文档且对方仍在途/生效，先处理对方
        const usedByOther = await db.retirements
          .filter((x) => x.id !== r.id && (isRetirementActive(x) || isRetirementOpen(x)) && x.replacementDocId === doc.id)
          .first()
        if (usedByOther) { result = { status: 'used-as-replacement', title: usedByOther.docTitle || doc.title }; return }
        // 旧文档审批期间进入评审/交接 → 驳回本次执行，发起人处理完后可重新发起
        const pendingReview = await db.reviews
          .where('docId').equals(doc.id)
          .filter((rv) => rv.status === 'pending').first()
        if (pendingReview) { result = { status: 'in-review', title: doc.title }; return }
        const handover = await db.handovers.filter((h) => (h.items || []).some((i) => i.docId === doc.id && isItemOpen(i))).first()
        if (handover) { result = { status: 'in-handover', title: doc.title }; return }

        // ① 共享链接：撤销旧文档全部「有效」链接（未过期、未撤销），保留记录与撤销时间，撤销退役时可恢复
        const shares = await db.shares.where('docId').equals(doc.id).toArray()
        const revokedShareIds = []
        for (const s of shares) {
          const expired = s.expiresAt && new Date(s.expiresAt) <= new Date(nowIso)
          if (s.revokedAt || expired) continue
          await db.shares.update(s.id, {
            revokedAt: nowIso,
            revokeReason: 'retirement:' + r.id
          })
          revokedShareIds.push(s.id)
        }

        // ② 已解决缺口工单：答案来源（docId）由旧文档改挂替代文档，逐条留痕；撤销退役时据此回挂
        const resolvedTickets = await db.gapTickets
          .where('docId').equals(doc.id)
          .filter((t) => t.status === GAP.RESOLVED).toArray()
        const repointedTicketIds = []
        for (const t of resolvedTickets) {
          await db.gapTickets.update(t.id, {
            docId: replacement.id,
            timeline: [
              ...(t.timeline || []),
              buildTimelineEntry('gap-repoint', userId, '答案来源文档《' + doc.title + '》已退役，改挂替代文档《' + replacement.title + '》（退役单 ' + r.id + '）', nowIso)
            ]
          })
          repointedTicketIds.push(t.id)
        }

        // ③ 文档置退役态：记录生效退役（搜索/问答闸门据此停止引用）
        await db.docs.update(doc.id, {
          retirement: {
            id: r.id,
            status: RETIRE.APPROVED,
            replacementDocId: replacement.id,
            replacementTitle: replacement.title,
            approvedBy: userId,
            approvedAt: nowIso
          }
        })

        const effects = {
          revokedShareIds,
          repointedTicketIds,
          shareCountBefore: shares.length,
          resolvedCount: resolvedTickets.length
        }
        const approved = {
          ...r,
          status: RETIRE.APPROVED,
          decidedBy: userId,
          decidedAt: nowIso,
          decideNote,
          approvedAt: nowIso,
          replacementTitle: replacement.title,
          replacementOwnerId: replacement.ownerId,
          effects,
          timeline: [
            ...(r.timeline || []),
            buildTimelineEntry('approve', userId, decideNote, nowIso),
            buildTimelineEntry('gap-repoint', userId, '已解决缺口工单 ' + repointedTicketIds.length + ' 张答案来源改挂《' + replacement.title + '》', nowIso),
            buildTimelineEntry('share-revoke', userId, '旧文档有效共享链接 ' + revokedShareIds.length + ' 条随退役撤销', nowIso)
          ]
        }
        await db.retirements.put(approved)
        await syncBatchInTx(r.batchId, r.batchId
          ? buildTimelineEntry('approve', userId, '《' + doc.title + '》已批准退役生效', nowIso)
          : null)
        result = { status: 'ok', approved: true, retirement: approved, effects }
      }
    )

    const { useGapStore } = await import('./gap')
    const gap = useGapStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.reload()])
    return result
  }

  // 撤销已生效的退役：同事务逐项还原（搜索/引用、共享链接、答案来源），退役单置 revoked 并保留记录
  async function revokeRetirement(id, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    const revokeNote = String(note || '').trim()
    let result = { status: 'error' }

    await db.transaction('rw', db.retirements, db.retirementBatches, db.docs, db.shares, db.gapTickets, async () => {
      const r = await db.retirements.get(id)
      if (!r) { result = { status: 'missing' }; return }
      if (!isRetirementActive(r)) { result = { status: 'changed', retirement: r }; return }
      if (r.initiatedBy !== userId && role !== ROLE.ADMIN) { result = { status: 'denied' }; return }

      const doc = await db.docs.get(r.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }
      const replacement = await db.docs.get(r.replacementDocId)

      // ① 共享链接：恢复被本次退役撤销、且当前仍未被再次撤销的链接（清除退役撤销标记）
      const restoredShareIds = []
      for (const sid of r.effects?.revokedShareIds || []) {
        const s = await db.shares.get(sid)
        // 仅恢复仍带有本次退役撤销标记的链接：退役期间被人工再次撤销的不恢复
        if (!s || s.revokeReason !== 'retirement:' + r.id) continue
        await db.shares.update(s.id, { revokedAt: null, revokeReason: null })
        restoredShareIds.push(s.id)
      }

      // ② 答案来源回挂旧文档：仅回挂「仍指向替代文档、且改挂记录来自本退役单」的工单，
      //    退役期间被另行处理（重新送审/改挂其他文档）的工单不强行覆盖
      const restoredTicketIds = []
      for (const tid of r.effects?.repointedTicketIds || []) {
        const t = await db.gapTickets.get(tid)
        if (!t || t.docId !== r.replacementDocId) continue
        // 以退役单 id 标记识别本次改挂；若之后又产生了非本退役的处理记录，则不覆盖
        const repointIdx = (t.timeline || []).findLastIndex
          ? t.timeline.findLastIndex((x) => x.action === 'gap-repoint' && (x.note || '').includes(r.id))
          : (() => {
              for (let i = t.timeline.length - 1; i >= 0; i--) {
                if (t.timeline[i].action === 'gap-repoint' && (t.timeline[i].note || '').includes(r.id)) return i
              }
              return -1
            })()
        if (repointIdx < 0) continue
        const after = (t.timeline || []).slice(repointIdx + 1)
        // 退役改挂之后若工单又被退回/重新送审/再次改挂，则保持现状不回挂
        if (after.some((x) => ['return', 'reset', 'submit', 'resolve', 'gap-repoint'].includes(x.action))) continue
        await db.gapTickets.update(t.id, {
          docId: doc.id,
          timeline: [
            ...(t.timeline || []),
            buildTimelineEntry('gap-restore', userId, '退役已撤销，答案来源回挂《' + doc.title + '》（退役单 ' + r.id + '）', nowIso)
          ]
        })
        restoredTicketIds.push(t.id)
      }

      // ③ 文档解除退役态：恢复搜索与问答引用
      await db.docs.update(doc.id, { retirement: null })

      const revoked = {
        ...r,
        status: RETIRE.REVOKED,
        revokedBy: userId,
        revokedAt: nowIso,
        revokeNote,
        effects: { ...(r.effects || {}), restoredShareIds, restoredTicketIds },
        timeline: [
          ...(r.timeline || []),
          buildTimelineEntry('revoke', userId, revokeNote, nowIso),
          buildTimelineEntry('gap-restore', userId, '答案来源回挂 ' + restoredTicketIds.length + ' 张工单', nowIso),
          buildTimelineEntry('share-restore', userId, '共享链接恢复 ' + restoredShareIds.length + ' 条', nowIso)
        ]
      }
      await db.retirements.put(revoked)
      await syncBatchInTx(r.batchId, r.batchId
        ? buildTimelineEntry('batch-revoke', userId, '《' + doc.title + '》撤销退役并恢复', nowIso)
        : null)
      result = { status: 'ok', retirement: revoked, restoredShareIds, restoredTicketIds, replacementMissing: !replacement }
    })

    const { useGapStore } = await import('./gap')
    const gap = useGapStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.reload()])
    return result
  }

  // 批次整体取消（审批前）：批次内所有仍在待审批的退役单一并取消，已结案的篇不动。
  // 同一事务内逐篇处理，任一篇因状态变化不可取消则跳过（逐篇幂等）。
  // 返回 { status:'ok', cancelled:[ids...], batch } | 'guest' | 'denied' | 'missing' | 'changed'
  async function cancelRetirementBatch(batchId, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.retirements, db.retirementBatches, async () => {
      const batch = await db.retirementBatches.get(batchId)
      if (!batch) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (batch.initiatedBy !== userId && role !== ROLE.ADMIN) { result = { status: 'denied' }; return }
      const openItems = await db.retirements
        .where('batchId').equals(batchId)
        .filter((r) => isRetirementOpen(r)).toArray()
      if (!openItems.length) { result = { status: 'changed', batch }; return }
      const cancelled = []
      for (const r of openItems) {
        const updated = {
          ...r,
          status: RETIRE.CANCELLED,
          timeline: [...(r.timeline || []), buildTimelineEntry('batch-cancel', userId, '随批次整体撤销申请', nowIso)]
        }
        await db.retirements.put(updated)
        cancelled.push(r.id)
      }
      await syncBatchInTx(batchId, buildTimelineEntry('batch-cancel', userId, '批次整体取消 ' + cancelled.length + ' 篇待审批申请', nowIso))
      result = { status: 'ok', cancelled, batch: await db.retirementBatches.get(batchId) }
    })

    await reload()
    return result
  }

  // ---- 分批编排执行器 ----

  // 持久化任务当前快照。仅写执行器拥有的字段：stopRequested 由 stopRetirementJob 独立置位、
  // 执行器在分片边界读取合并，双方不写同一字段，避免并发互相覆盖。
  async function persistJob(job) {
    await db.retirementJobs.update(job.id, {
      status: job.status,
      items: job.items,
      stats: jobProgressOf(job.items),
      timeline: job.timeline,
      finishedAt: job.finishedAt || null,
      updatedAt: new Date().toISOString()
    })
  }

  // 建立编排任务并持久化（items 快照目标篇目；逐篇状态/尝试次数/留痕随执行推进）
  async function createJob(kind, batch, targets, note, userId) {
    const nowIso = new Date().toISOString()
    const kindLabel = kind === RETIRE_JOB_KIND.APPROVE ? '批量批准' : '批量撤销'
    const job = {
      id: uid('rtj'),
      batchId: batch.id,
      kind,
      status: RETIRE_JOB.RUNNING,
      note: String(note || '').trim(),
      initiatedBy: userId,
      stopRequested: false,
      items: targets.map((r) => ({
        retirementId: r.id,
        docId: r.docId,
        docTitle: r.docTitle,
        status: RETIRE_JOB_ITEM.PENDING,
        attempts: 0,
        lastError: '',
        history: []
      })),
      stats: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      finishedAt: null,
      timeline: [buildTimelineEntry('job-initiate', userId, kindLabel + '编排创建：共 ' + targets.length + ' 篇，分片逐篇独立事务执行', nowIso)]
    }
    await db.retirementJobs.add(job)
    await reload()
    return job
  }

  // 编排执行主循环：分片逐篇独立事务执行，暂态失败就地重试，业务冲突隔离，
  // 片间让出事件循环并响应停止请求；任务状态全程持久化，中断后可由 resumeRetirementJob 接管。
  // opts: { chunkSize, maxItemAttempts, chunkDelayMs, retryDelayMs, itemInterceptor(item, attempt) 测试注入 }
  // 返回 { status: 'done' | 'partial' | 'stopped' | 'busy' | 'missing', job, summary }
  async function executeJob(jobId, currentUser, opts = {}) {
    if (executingJobIds.value.includes(jobId)) return { status: 'busy', job: jobById(jobId) }
    const job = await db.retirementJobs.get(jobId)
    if (!job) return { status: 'missing' }
    const chunkSize = Math.max(1, opts.chunkSize || RETIRE_JOB_CHUNK_SIZE)
    const maxItemAttempts = Math.max(1, opts.maxItemAttempts || RETIRE_JOB_MAX_ITEM_ATTEMPTS)
    const chunkDelayMs = opts.chunkDelayMs ?? 25
    const retryDelayMs = opts.retryDelayMs ?? 60
    const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve())
    const nowIso = () => new Date().toISOString()
    const operatorId = currentUser?.id || GUEST_ID

    executingJobIds.value = [...executingJobIds.value, jobId]
    try {
      // 中断恢复：上次执行残留的「执行中」篇目重置为待执行。
      // 单篇联动在各自事务内原子提交，中断即回滚，重判不会重复联动（幂等）。
      for (const it of job.items) {
        if (it.status === RETIRE_JOB_ITEM.RUNNING) it.status = RETIRE_JOB_ITEM.PENDING
      }
      job.status = RETIRE_JOB.RUNNING
      await persistJob(job)

      const execItem = (item) => job.kind === RETIRE_JOB_KIND.APPROVE
        ? decideRetirement(item.retirementId, 'approve', job.note, currentUser)
        : revokeRetirement(item.retirementId, job.note, currentUser)

      let stopped = false
      const pendings = () => job.items.filter((it) => it.status === RETIRE_JOB_ITEM.PENDING)
      while (pendings().length) {
        // 分片：每片 chunkSize 篇；片内逐篇独立事务（单篇故障/冲突隔离，不影响同批他篇）
        const chunk = pendings().slice(0, chunkSize)
        for (const item of chunk) {
          item.status = RETIRE_JOB_ITEM.RUNNING
          await persistJob(job)
          for (let attempt = 1; attempt <= maxItemAttempts; attempt++) {
            item.attempts = attempt
            try {
              if (opts.itemInterceptor) await opts.itemInterceptor(item, attempt)
              const res = await execItem(item)
              const { outcome, message } = classifyRetirementStepResult(job.kind, res)
              item.history.push({ at: nowIso(), attempt, result: res.status, message })
              item.status = outcome
              item.lastError = outcome === RETIRE_JOB_ITEM.CONFLICT ? message : ''
            } catch (err) {
              const transient = isTransientRetirementError(err)
              const message = err ? err.name + (err.message ? '：' + err.message : '') : '执行异常'
              item.history.push({ at: nowIso(), attempt, result: 'error', message, transient })
              if (transient && attempt < maxItemAttempts) {
                // 暂态失败：就地重试（单篇事务已回滚，重试安全）
                await persistJob(job)
                await sleep(retryDelayMs)
                continue
              }
              item.status = RETIRE_JOB_ITEM.FAILED
              item.lastError = message
            }
            break
          }
          if (item.status === RETIRE_JOB_ITEM.RUNNING) item.status = RETIRE_JOB_ITEM.FAILED // 兜底，不应到达
          await persistJob(job)
        }
        // 分片边界：合并停止请求（stopRetirementJob 仅置位 stopRequested，不并发写其他字段）
        const fresh = await db.retirementJobs.get(jobId)
        if (fresh?.stopRequested) { stopped = true; break }
        if (pendings().length) await sleep(chunkDelayMs)
      }

      const stats = jobProgressOf(job.items)
      if (stopped) {
        job.status = RETIRE_JOB.STOPPED
        job.timeline.push(buildTimelineEntry('job-stopped', operatorId,
          '分片边界停止：已成功 ' + stats.succeeded + ' 篇，剩余 ' + stats.remaining + ' 篇可续跑', nowIso()))
      } else {
        job.status = stats.remaining ? RETIRE_JOB.PARTIAL : RETIRE_JOB.DONE
        job.finishedAt = nowIso()
        job.timeline.push(buildTimelineEntry('job-finish', operatorId,
          '执行完成：成功 ' + stats.succeeded + '/' + stats.total +
          (stats.conflict ? '，冲突隔离 ' + stats.conflict + ' 篇' : '') +
          (stats.failed ? '，失败 ' + stats.failed + ' 篇' : ''), nowIso()))
      }
      await persistJob(job)

      // 批次留痕：编排结论同步到批次时间线（全链路：批次 ↔ 任务 ↔ 退役单 ↔ 链接/工单）
      const kindLabel = job.kind === RETIRE_JOB_KIND.APPROVE ? '批量批准' : '批量撤销'
      const batchNote = kindLabel + '编排' + (stopped ? '已停止' : '完成') +
        '：成功 ' + stats.succeeded + '/' + stats.total +
        (stats.remaining ? '，剩余 ' + stats.remaining + ' 篇可续跑' : '') + '（任务 ' + job.id + '）'
      await db.transaction('rw', db.retirements, db.retirementBatches, async () => {
        await syncBatchInTx(job.batchId, buildTimelineEntry(
          job.kind === RETIRE_JOB_KIND.APPROVE ? 'batch-approve-job' : 'batch-revoke-job',
          operatorId, batchNote, nowIso()))
      })

      await reload()
      return {
        status: stopped ? 'stopped' : (stats.remaining ? 'partial' : 'done'),
        job: await db.retirementJobs.get(jobId),
        summary: stats
      }
    } finally {
      executingJobIds.value = executingJobIds.value.filter((x) => x !== jobId)
    }
  }

  // 批量批准编排：为批次内全部待审批篇建立可续跑编排任务并立即执行。
  // 同一批次同类任务单例（存在未完成任务时返回 busy，应续跑而非新建，避免并发交叉）。
  // 返回 executeJob 结果 | 'guest' | 'denied' | 'missing' | 'changed' | { status:'busy', job }
  async function startBatchApproveJob(batchId, note, currentUser, opts = {}) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    if (currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    const batch = batchById(batchId)
    if (!batch) return { status: 'missing' }
    const live = jobs.value.find((j) =>
      j.batchId === batchId && j.kind === RETIRE_JOB_KIND.APPROVE &&
      (isJobResumable(j) || isJobExecuting(j.id)))
    if (live) return { status: 'busy', job: live }
    const targets = itemsOfBatch(batchId).filter((r) => isRetirementOpen(r))
    if (!targets.length) return { status: 'changed', results: [] }
    const job = await createJob(RETIRE_JOB_KIND.APPROVE, batch, targets, note, userId)
    return executeJob(job.id, currentUser, opts)
  }

  // 批量撤销编排：为批次内全部已生效篇建立可续跑编排任务并立即执行（逐篇独立事务恢复）。
  async function startBatchRevokeJob(batchId, note, currentUser, opts = {}) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    const batch = batchById(batchId)
    if (!batch) return { status: 'missing' }
    if (batch.initiatedBy !== userId && currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    const live = jobs.value.find((j) =>
      j.batchId === batchId && j.kind === RETIRE_JOB_KIND.REVOKE &&
      (isJobResumable(j) || isJobExecuting(j.id)))
    if (live) return { status: 'busy', job: live }
    const targets = itemsOfBatch(batchId).filter((r) => isRetirementActive(r))
    if (!targets.length) return { status: 'changed', results: [] }
    const job = await createJob(RETIRE_JOB_KIND.REVOKE, batch, targets, note, userId)
    return executeJob(job.id, currentUser, opts)
  }

  // 续跑：剩余篇目（待执行/冲突/失败/中断残留）重置为待执行后重新分片执行。
  // 逐篇幂等重判——已处目标态的篇目记为成功且不重复联动；已成功篇目不参与续跑。
  async function resumeRetirementJob(jobId, currentUser, opts = {}) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    const job = await db.retirementJobs.get(jobId)
    if (!job) return { status: 'missing' }
    if (job.kind === RETIRE_JOB_KIND.APPROVE) {
      if (currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    } else if (job.initiatedBy !== userId && currentUser?.role !== ROLE.ADMIN) {
      return { status: 'denied' }
    }
    if (executingJobIds.value.includes(jobId)) return { status: 'busy', job }
    const remaining = job.items.filter((it) => isJobItemRemaining(it))
    if (!remaining.length) return { status: 'done', job, summary: jobProgressOf(job.items) }
    const nowIso = new Date().toISOString()
    for (const it of job.items) {
      if (isJobItemRemaining(it)) {
        it.status = RETIRE_JOB_ITEM.PENDING
        it.lastError = ''
      }
    }
    job.status = RETIRE_JOB.RUNNING
    job.stopRequested = false
    job.timeline = [...(job.timeline || []), buildTimelineEntry('job-resume', userId,
      '续跑剩余 ' + remaining.length + ' 篇（冲突/失败篇目重新判定）', nowIso)]
    // 任务未在执行中，整体写回安全（含清除 stopRequested）
    await db.retirementJobs.put(job)
    return executeJob(jobId, currentUser, opts)
  }

  // 请求停止：仅置位 stopRequested，执行器在当前分片结束后停止（剩余篇目可续跑）
  async function stopRetirementJob(jobId, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    const job = await db.retirementJobs.get(jobId)
    if (!job) return { status: 'missing' }
    if (job.initiatedBy !== userId && currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    if (!executingJobIds.value.includes(jobId)) return { status: 'changed', job }
    await db.retirementJobs.update(jobId, { stopRequested: true })
    return { status: 'ok' }
  }

  // 批次批量撤销已生效退役（兼容入口）：内部升级为可重试分批编排——逐篇独立事务、
  // 暂态失败重试、业务冲突隔离、部分失败可续跑；返回保持逐篇聚合结构。
  // 返回 { status:'ok', results:[{id,status,...}], done, failed, job } | 'denied'（无资格）
  async function revokeRetirementBatch(batchId, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const batch = batchById(batchId)
    if (!batch) return { status: 'missing' }
    if (isGuestUser(userId)) return { status: 'guest' }
    if (batch.initiatedBy !== userId && role !== ROLE.ADMIN) return { status: 'denied' }
    const targets = itemsOfBatch(batchId).filter((r) => isRetirementActive(r))
    if (!targets.length) return { status: 'changed', results: [] }
    const res = await startBatchRevokeJob(batchId, note, currentUser)
    if (res.status === 'busy' || res.status === 'missing' || res.status === 'denied' || res.status === 'guest') {
      return { status: res.status, results: [], job: res.job }
    }
    const items = res.job?.items || []
    const results = items.map((it) => ({
      id: it.retirementId,
      status: it.status === RETIRE_JOB_ITEM.SUCCEEDED ? 'ok' : 'conflict',
      jobItem: it
    }))
    return {
      status: 'ok',
      results,
      done: results.filter((x) => x.status === 'ok').length,
      failed: results.filter((x) => x.status !== 'ok').length,
      job: res.job
    }
  }

  // 我发起的批次
  function batchesInitiatedBy(userId) {
    return sortedBatches.value.filter((b) => b.initiatedBy === userId)
  }

  // 我相关批次（我发起，或我是批次内任一篇替代文档负责人）
  function batchesInvolvedIn(userId) {
    return sortedBatches.value.filter((b) =>
      b.initiatedBy === userId || itemsOfBatch(b.id).some((r) => r.replacementOwnerId === userId)
    )
  }

  return {
    retirements, batches, jobs, loaded, loadAll, reload, sorted, sortedBatches,
    openRetirementOfDoc, activeRetirementOfDoc, activeRetirementUsingAsReplacement,
    openRetirementUsingAsReplacement, retirementUsingAsReplacement,
    batchById, itemsOfBatch, batchStatusById,
    jobById, jobsOfBatch, latestJobOfBatch, isJobExecuting, resumableJobs,
    pendingApprovalFor, initiatedBy, involvedIn, pendingCountFor,
    batchesInitiatedBy, batchesInvolvedIn,
    initiateRetirement, initiateRetirementBatch,
    cancelRetirement, cancelRetirementBatch,
    decideRetirement,
    revokeRetirement, revokeRetirementBatch,
    startBatchApproveJob, startBatchRevokeJob,
    resumeRetirementJob, stopRetirementJob
  }
})
