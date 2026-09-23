import Dexie from 'dexie'

// Dexie 封装 IndexedDB。采用显式作用域来避免导出的模块级 token 被 Ctrl+Enter
export class KnowledgeDB extends Dexie {
  constructor(name) {
    super(name)
    this.version(1).stores({
      users: 'id, name, role, email',
      categories: 'id, name',
      tags: 'id, name',
      docs: 'id, title, categoryId, visibility, ownerId, updatedAt, createdAt, *tagIds',
      comments: 'id, docId, authorId, createdAt',
      shares: 'id, docId, token',
      favorites: 'id, [userId+docId], docId',
      recentViews: 'id, [userId+docId], docId, viewedAt',
      ratings: 'id, [docId+slug]'
    })
    // v2：知识文档评审流程
    // - reviews：评审单（编辑者发起 → 成员评论 → 管理员审批并留痕）
    // - comments 增加 reviewId 索引，区分普通评论与评审意见
    // docs/versions 上的评审字段无需建索引，直接随记录读写
    this.version(2).stores({
      reviews: 'id, docId, status, submittedBy, submittedAt, decidedBy, decidedAt',
      comments: 'id, docId, authorId, createdAt, reviewId'
    })
    // v3：知识缺口工单
    // - gapTickets：未解决问答 → 补写需求（成员提交 → 编辑者认领 → 关联文档送审 →
    //   审批通过回填答案来源 / 驳回退回处理），timeline 字段随记录读写处理留痕
    this.version(3).stores({
      gapTickets: 'id, status, createdBy, claimedBy, docId, reviewId, createdAt'
    })
    // v4：文档访问申请
    // - accessRequests：成员访问受限文档时申请限时阅读/协作权限（申请 → 拥有者审批 →
    //   授权记录生效；撤销/到期收回详情、搜索、问答、编辑权限），授权快照与 timeline 随记录读写留痕
    this.version(4).stores({
      accessRequests: 'id, docId, applicantId, status, requestedPermission, createdAt, decidedAt, expiresAt, revokedAt'
    })
    // v5：缺口工单合并认领
    // - gapTickets 增加 groupId 索引：编辑者可把多个同类问题合并为一组共同处理，
    //   组内工单保留各自提问与 timeline，共用一次文档送审；groupId 挂在主工单 id 上，
    //   旧工单无该字段（undefined），按独立工单兼容处理。
    this.version(5).stores({
      gapTickets: 'id, status, createdBy, claimedBy, docId, reviewId, groupId, createdAt'
    })
    // v6：知识保鲜
    // - freshnessTickets：复核周期到期自动生成复核单（到期即暂停问答引用）→
    //   编辑者修订送审（复用评审单锁定/审批通道）→ 管理员批准恢复引用并重算周期 /
    //   驳回继续整改；每轮复核单与时间线全程保留，审批通过同步追加带保鲜标记的版本记录。
    //   docs.freshness（周期配置/下次到期点/当前复核单）随记录读写，不单独建索引。
    this.version(6).stores({
      freshnessTickets: 'id, docId, status, round, dueAt, createdAt'
    })
    // v7：知识责任交接
    // - handovers：负责人批量发起文档交接（接任者确认 → 管理员批准 → 同事务统一转移所有权、
    //   待办审批与保鲜责任）；发起时为每篇文档打快照，批准执行时复核并发变更，不一致即整体
    //   失败回退；历史归属随 doc.ownerHistory 保留，原负责人权限按交接决定保留/收回。
    //   items（逐篇快照与转移结果）与 timeline 随记录读写留痕。
    this.version(7).stores({
      handovers: 'id, status, fromUserId, toUserId, createdAt, decidedAt'
    })
    // v8：知识退役替代
    // - retirements：负责人发起文档退役并指定替代文档（pending 待管理员审批 → approved 生效 /
    //   rejected 驳回 / cancelled 发起人撤销 / revoked 退役撤销）；批准后同事务停止旧文档的
    //   问答引用、撤销其共享链接（记录保留）、把已解决缺口工单的答案来源改挂替代文档；
    //   退役可撤销并全程保留记录。doc.retirement（当前生效退役）随记录读写，不单独建索引。
    this.version(8).stores({
      retirements: 'id, status, docId, replacementDocId, initiatedBy, decidedBy, createdAt, decidedAt'
    })
    // v9：分类复核策略
    // - freshnessPolicies：按分类批量设置复核周期（每分类一条），无文档级覆盖的文档继承策略并
    //   物化到 doc.freshness（source='policy'）；策略调整时重算无在途复核单文档的到期计划，
    //   在途复核单保留规则快照（ruleSource/policyId/cycleDays），结案时按当时策略重算下一周期。
    //   doc.freshness.source / freshnessTickets.ruleSource 随记录读写，不单独建索引。
    this.version(9).stores({
      freshnessPolicies: 'id, categoryId, updatedAt'
    }).upgrade(migrateFreshnessPolicyV9)
    // v10：交接逐篇接任者
    // - handovers.items 逐篇携带 toUserId 与独立状态机：同一批交接可逐篇指定不同接任者，
    //   各接任者按篇独立确认/谢绝，管理员按确认结果分批批准（已确认篇先批先转）；
    //   批次整体状态由篇状态派生。旧交接单按整体状态映射到每一篇，接任者取单级 toUserId，
    //   单级确认/审批时间戳与备注同步到篇。
    this.version(10).stores({
      handovers: 'id, status, fromUserId, toUserId, createdAt, decidedAt'
    }).upgrade(migrateHandoverItemsV10)
    // v11：知识退役批量送审
    // - retirementBatches：负责人一次为多篇文档分别指定替代文档并统一送审（一个批次挂 N 张退役单），
    //   管理员仍逐篇批准/驳回，批次状态由各篇退役单派生；批次可在审批前整体取消、生效后逐篇/批量撤销。
    // - retirements 增加 batchId 索引：无 batchId 的历史单篇退役单按独立记录兼容处理。
    this.version(11).stores({
      retirements: 'id, status, docId, replacementDocId, initiatedBy, decidedBy, createdAt, decidedAt, batchId',
      retirementBatches: 'id, initiatedBy, createdAt'
    })
  }
}

// v9 数据迁移（导出供升级与回归测试共用）：
// 已有逐篇保鲜配置标记为文档级覆盖（source='doc'），历史/在途复核单补规则来源快照，
// 升级前后语义一致——策略批量重算只认显式 source='policy' 的继承配置，不会误伤既有逐篇配置
export async function migrateFreshnessPolicyV9(tx) {
  await tx.table('docs').toCollection().modify((d) => {
    if (d.freshness && d.freshness.source !== 'policy' && d.freshness.source !== 'doc') {
      d.freshness.source = 'doc'
      d.freshness.policyId = null
    }
  })
  await tx.table('freshnessTickets').toCollection().modify((t) => {
    if (t.ruleSource !== 'policy' && t.ruleSource !== 'doc') {
      t.ruleSource = 'doc'
      t.policyId = null
    }
  })
}

// v10 数据迁移（导出供升级与回归测试共用）：
// 旧交接单为「整单一个接任者、整单流转」，items 无独立状态；逐篇补 toUserId（取单级）与
// 按单状态映射的篇状态，单级确认/审批时间戳与备注同步到篇。升级前后语义一致——
// 已终态的单其每一篇同为对应终态，待批准的单每一篇视为已确认待批准。
export async function migrateHandoverItemsV10(tx) {
  const itemStatusOf = {
    pending_confirm: 'pending_confirm',
    pending_approval: 'confirmed',
    completed: 'completed',
    declined: 'declined',
    rejected: 'rejected',
    cancelled: 'cancelled',
    failed: 'failed'
  }
  await tx.table('handovers').toCollection().modify((h) => {
    if (!Array.isArray(h.items)) return
    const st = itemStatusOf[h.status] || 'pending_confirm'
    for (const it of h.items) {
      if (it.status) continue // 已是逐篇新格式
      it.toUserId = it.toUserId || h.toUserId || null
      it.status = st
      it.confirmedAt = h.confirmedAt || null
      it.decidedBy = h.decidedBy || null
      it.decidedAt = h.decidedAt || null
      it.decideNote = h.decideNote || ''
      it.completedAt = h.completedAt || null
      it.failReason = h.failReason || ''
      if (it.result === undefined) it.result = null
    }
  })
}

export const db = new KnowledgeDB('knowbase')

// 顶层 initMeta 供 ensureSeeded 使用，避免循环引用问题由导入方 resolve
export const metaKey = { seeded: 'seeded' }

export async function getMeta(key) {
  return localStorage.getItem('kb:meta:' + key)
}
export async function setMeta(key, val) {
  localStorage.setItem('kb:meta:' + key, val)
}
