import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ACCESS, ACCESS_PERM, isGrantActive, calcExpiresAt, buildAccessTimelineEntry } from '@/utils/access'

// 文档访问申请 store：
// 成员访问受限文档 → 提交限时阅读/协作申请（pending）→ 拥有者/管理员审批：
// 通过（approved）生成带有效期的授权快照 grant；驳回（rejected）不授权；申请人可取消（cancelled）。
// 授权可被拥有者提前撤销（revoked）；到期为惰性判定（记录仍为 approved，判定/扫描时视为失效）。
// 详情、搜索、问答、编辑四处统一以 isGrantActive 校验授权，撤销/到期即时同步收回。
// 失效统一由响应式时钟 now 驱动：调度器在最近一个授权到期点推进时钟，
// activeGrantMap 随之重算，详情/列表/搜索/问答等页面的受限内容即时收回，无需刷新。
// 申请与授权变更全程记录在 timeline，记录不随撤销/到期删除。
export const useAccessStore = defineStore('access', () => {
  const requests = ref([])
  const loaded = ref(false)
  // 响应式当前时间：授权有效性判定（isGrantActive）统一以它为准。
  // 审批/撤销/到期调度都会推进它，使各页面的授权缓存（computed）同步失效
  const now = ref(new Date())
  let expiryTimer = null
  // setTimeout 延迟上限（2^31-1 ms），超过会溢出立即触发，长到期时间需分段调度
  const MAX_TIMER_DELAY = 2147483647

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
    // 扫描历史授权：惰性到期的记录补一条到期留痕（不改变状态，授权以 isGrantActive 判定）
    await sweepExpired()
  }

  async function reload() {
    requests.value = await db.accessRequests.toArray()
    now.value = new Date()
    scheduleExpiry()
  }

  // 调度下一次到期唤醒：找到生效中授权的最近到期点，到点推进时钟并补到期留痕。
  // requests 变化（审批/撤销/加载）后重排，保证页面停留期间授权到期也能即时失效
  function scheduleExpiry() {
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null }
    const t = now.value.getTime()
    let next = Infinity
    for (const r of requests.value) {
      if (r.status !== ACCESS.APPROVED || r.revokedAt || !r.grant?.expiresAt) continue
      const exp = new Date(r.grant.expiresAt).getTime()
      if (exp > t && exp < next) next = exp
    }
    if (next === Infinity) return
    // 稍过到期点再判定，避免边界误差；超长延迟分段调度
    const delay = Math.min(Math.max(next - Date.now(), 0) + 50, MAX_TIMER_DELAY)
    expiryTimer = setTimeout(onExpiryTick, delay)
  }

  async function onExpiryTick() {
    expiryTimer = null
    // 推进时钟 → activeGrantMap 重算 → 详情/搜索/问答/列表的受限内容即时收回
    now.value = new Date()
    // 补「到期收回」留痕（幂等，每条授权仅补一次）
    await sweepExpired()
    scheduleExpiry()
  }

  // 当前用户在某文档上的最新一条申请记录（无论状态，供申请页/详情页展示）
  function latestRequestFor(docId, userId) {
    return requests.value
      .filter((r) => r.docId === docId && r.applicantId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null
  }

  // 当前用户在某文档上的有效授权记录（无则 null）——详情/搜索/问答/编辑统一入口
  function activeGrantFor(docId, userId, at) {
    const r = requests.value.find((x) => x.docId === docId && x.applicantId === userId && isGrantActive(x, at || now.value))
    return r || null
  }

  // [docId+userId] -> 有效授权记录，供列表/搜索/问答批量过滤。
  // 依赖响应式时钟 now：授权到期调度推进时钟后，此处自动重算，各页面缓存同步失效
  const activeGrantMap = computed(() => {
    const m = {}
    for (const r of requests.value) {
      if (isGrantActive(r, now.value)) m[r.docId + '+' + r.applicantId] = r
    }
    return m
  })

  function grantOf(docId, userId) {
    return activeGrantMap.value[docId + '+' + userId] || null
  }

  // 文档上的全部申请（含历史授权记录），时间倒序
  function requestsOfDoc(docId) {
    return requests.value
      .filter((r) => r.docId === docId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 某人发起的申请
  function requestsByUser(userId) {
    return requests.value
      .filter((r) => r.applicantId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 待某用户（拥有者/管理员）审批的申请
  function pendingForApprover(userId, role, docs) {
    const docMap = docs && docs.length ? Object.fromEntries(docs.map((d) => [d.id, d])) : null
    return requests.value
      .filter((r) => r.status === ACCESS.PENDING)
      .filter((r) => {
        if (role === 'admin') return true
        const doc = docMap ? docMap[r.docId] : null
        return doc && doc.ownerId === userId
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  const pendingCount = computed(() => requests.value.filter((r) => r.status === ACCESS.PENDING).length)

  // 成员提交访问申请。同一文档存在待审批申请时直接返回，避免重复
  async function createRequest(docId, permission, reason, currentUser) {
    const { useKbStore } = await import('./kb')
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id
    let result = { status: 'error' }

    if (!userId) return { status: 'guest' }
    if (permission !== ACCESS_PERM.READ && permission !== ACCESS_PERM.COLLAB) {
      return { status: 'bad-permission' }
    }

    await db.transaction('rw', db.docs, db.accessRequests, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (doc.ownerId === userId || (doc.editors || []).includes(userId) || currentUser.role === 'admin') {
        result = { status: 'not-needed' }; return
      }
      const dup = await db.accessRequests
        .where('docId').equals(docId)
        .filter((r) => r.applicantId === userId && r.status === ACCESS.PENDING).first()
      if (dup) { result = { status: 'duplicate', request: dup }; return }

      const req = {
        id: uid('acc'),
        docId,
        applicantId: userId,
        status: ACCESS.PENDING,
        requestedPermission: permission,
        reason: String(reason || '').trim(),
        createdAt: now,
        decidedBy: null,
        decidedAt: null,
        decisionNote: '',
        // grant：审批通过时生成的授权快照（权限、起止时间、撤销时间）
        grant: null,
        timeline: [buildAccessTimelineEntry('apply', userId, reason, now)]
      }
      await db.accessRequests.add(req)
      result = { status: 'ok', request: req }
    })

    await reload()
    return result
  }

  // 拥有者/管理员审批：approve 通过（生成限时授权）/ reject 驳回
  async function decideRequest(requestId, decision, note, durationDays, currentUser) {
    const { useKbStore } = await import('./kb')
    const kb = useKbStore()
    await loadAll()
    const now = new Date()
    const nowIso = now.toISOString()
    const userId = currentUser?.id
    const isAdmin = currentUser?.role === 'admin'
    if (!userId || userId === 'u-guest') return { status: 'guest' }
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.accessRequests, async () => {
      const req = await db.accessRequests.get(requestId)
      if (!req) { result = { status: 'missing' }; return }
      if (req.status !== ACCESS.PENDING) { result = { status: 'closed', request: req }; return }
      const doc = await db.docs.get(req.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }
      if (!isAdmin && doc.ownerId !== userId) { result = { status: 'denied' }; return }

      const decisionNote = String(note || '').trim()
      if (decision === 'reject') {
        const rejected = {
          ...req,
          status: ACCESS.REJECTED,
          decidedBy: userId,
          decidedAt: nowIso,
          decisionNote,
          timeline: [...(req.timeline || []), buildAccessTimelineEntry('reject', userId, decisionNote, nowIso)]
        }
        await db.accessRequests.put(rejected)
        result = { status: 'ok', request: rejected, approved: false }
        return
      }

      // 通过：按申请权限生成授权快照，到期时间由拥有者给定的时长决定
      const days = Number(durationDays)
      const expiresAt = calcExpiresAt(days > 0 ? days : 7, now)
      const approved = {
        ...req,
        status: ACCESS.APPROVED,
        decidedBy: userId,
        decidedAt: nowIso,
        decisionNote,
        // 顶层 expiresAt 与授权快照同源，便于按到期时间建索引/查询
        expiresAt,
        revokedAt: null,
        grant: {
          permission: req.requestedPermission,
          grantedAt: nowIso,
          expiresAt,
          revokedAt: null
        },
        timeline: [
          ...(req.timeline || []),
          buildAccessTimelineEntry(
            'approve',
            userId,
            (req.requestedPermission === ACCESS_PERM.COLLAB ? '授权限时协作' : '授权限时阅读') + (expiresAt ? '，有效期 ' + days + ' 天' : '') + (decisionNote ? '：' + decisionNote : ''),
            nowIso
          )
        ]
      }
      await db.accessRequests.put(approved)
      result = { status: 'ok', request: approved, approved: true }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 拥有者/管理员提前撤销授权：撤销后详情/搜索/问答/编辑权限立即收回
  async function revokeGrant(requestId, note, currentUser) {
    const { useKbStore } = await import('./kb')
    const kb = useKbStore()
    await loadAll()
    const nowIso = new Date().toISOString()
    const userId = currentUser?.id
    const isAdmin = currentUser?.role === 'admin'
    if (!userId || userId === 'u-guest') return { status: 'guest' }
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.accessRequests, async () => {
      const req = await db.accessRequests.get(requestId)
      if (!req || req.status !== ACCESS.APPROVED || req.revokedAt) { result = { status: 'closed' }; return }
      const doc = await db.docs.get(req.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }
      if (!isAdmin && doc.ownerId !== userId) { result = { status: 'denied' }; return }

      const revoked = {
        ...req,
        status: ACCESS.REVOKED,
        revokedAt: nowIso,
        grant: { ...(req.grant || {}), revokedAt: nowIso },
        timeline: [...(req.timeline || []), buildAccessTimelineEntry('revoke', userId, note, nowIso)]
      }
      await db.accessRequests.put(revoked)
      result = { status: 'ok', request: revoked }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 申请人取消待审批申请
  async function cancelRequest(requestId, currentUser) {
    await loadAll()
    const nowIso = new Date().toISOString()
    const userId = currentUser?.id
    let result = { status: 'error' }

    await db.transaction('rw', db.accessRequests, async () => {
      const req = await db.accessRequests.get(requestId)
      if (!req) { result = { status: 'missing' }; return }
      if (req.status !== ACCESS.PENDING || req.applicantId !== userId) { result = { status: 'denied' }; return }
      const cancelled = {
        ...req,
        status: ACCESS.CANCELLED,
        timeline: [...(req.timeline || []), buildAccessTimelineEntry('cancel', userId, '', nowIso)]
      }
      await db.accessRequests.put(cancelled)
      result = { status: 'ok', request: cancelled }
    })

    await reload()
    return result
  }

  // 惰性到期扫描：已通过但超过有效期的授权补「到期收回」留痕（每条仅补一次）。
  // 状态不改变——各处以 isGrantActive 判定，授权在到期时刻即已不可用
  async function sweepExpired() {
    const now = new Date()
    const nowIso = now.toISOString()
    const due = requests.value.filter(
      (r) => r.status === ACCESS.APPROVED && !r.revokedAt && r.grant?.expiresAt && new Date(r.grant.expiresAt) <= now
    )
    if (!due.length) return
    await db.transaction('rw', db.accessRequests, async () => {
      for (const r of due) {
        const fresh = await db.accessRequests.get(r.id)
        if (!fresh || fresh.status !== ACCESS.APPROVED || fresh.revokedAt) continue
        const already = (fresh.timeline || []).some((t) => t.action === 'expire')
        if (already) continue
        await db.accessRequests.update(r.id, {
          timeline: [...(fresh.timeline || []), buildAccessTimelineEntry('expire', 'system', '授权到期，阅读与协作权限已自动收回', nowIso)]
        })
      }
    })
    await reload()
  }

  // 删除文档时连带清理访问申请（拥有者删除文档，申请与授权一并失效）
  async function deleteRequestsOfDoc(docId) {
    await db.accessRequests.where('docId').equals(docId).delete()
    if (loaded.value) await reload()
  }

  return {
    requests, loaded, now, loadAll, reload,
    activeGrantMap, grantOf, activeGrantFor, latestRequestFor, requestsOfDoc,
    requestsByUser, pendingForApprover, pendingCount,
    createRequest, decideRequest, revokeGrant, cancelRequest, sweepExpired, deleteRequestsOfDoc
  }
})
