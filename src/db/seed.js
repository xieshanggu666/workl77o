import { db, getMeta, setMeta } from './index'

const now = Date.now()
const h = 3600 * 1000
const d = 24 * h
const ago = (ms) => new Date(now - ms).toISOString()

const seedUsers = [
  { id: 'u-admin', name: '林致远', email: 'admin@knowbase.dev', role: 'admin', avatar: 'LZ', title: '平台管理员' },
  { id: 'u-chen', name: '陈思涵', email: 'chen@knowbase.dev', role: 'editor', avatar: 'CS', title: '后端工程师' },
  { id: 'u-ziwei', name: '王子薇', email: 'ziwei@knowbase.dev', role: 'editor', avatar: 'WZ', title: '产品经理' },
  { id: 'u-xiaoye', name: '高晓叶', email: 'xiaoye@knowbase.dev', role: 'viewer', avatar: 'GX', title: '前端工程师' },
  { id: 'u-mochen', name: '莫尘', email: 'mochen@knowbase.dev', role: 'viewer', avatar: 'MC', title: '设计师' }
]

const seedCategories = [
  { id: 'c-dev', name: '开发文档', icon: 'code' },
  { id: 'c-product', name: '产品设计', icon: 'box' },
  { id: 'c-ops', name: '运维手册', icon: 'server' },
  { id: 'c-life', name: '团队文化', icon: 'heart' }
]

const seedTags = [
  { id: 't-api', name: 'API', color: '#4f6ef7' },
  { id: 't-guide', name: '指南', color: '#0fb981' },
  { id: 't-faq', name: 'FAQ', color: '#f7a24f' },
  { id: 't-vue', name: 'Vue', color: '#42b883' },
  { id: 't-db', name: '数据库', color: '#b062f7' },
  { id: 't-security', name: '安全', color: '#f2555c' },
  { id: 't-onboarding', name: '入职', color: '#28a7e8' }
]

// doc-3 正文提取为常量：缺口工单演示数据（rev-4 评审快照）需引用同一内容
const doc3Body = '<h2>统一鉴权链路</h2><p>所有请求进入网关后，先校验 <b>Token</b> 再校验 <i>权限点</i>。</p><h3>角色与权限点</h3><ul><li>admin：全部权限</li><li>editor：可新增与编辑</li><li>viewer：只读</li></ul><blockquote>文档级可见性：public / team / private。</blockquote>'

// doc-2 正文提取为常量：版本恢复演示数据（v1 初始 / v2 误删 / v3 恢复）需引用同一内容
const doc2Body = '<h2>IndexedDB 太繁琐？试试 Dexie</h2><p>Dexie 用关系型 <b>表</b> 与 <i>索引</i> 来封装 IndexedDB，极大简化读写。</p><pre><code>await db.docs.add({ title: "示例", body: "<p>内容</p>" })</code></pre><h3>常用查询</h3><ul><li>按主键：<code>db.docs.get(id)</code></li><li>按索引过滤：<code>db.docs.where("categoryId").equals(id)</code></li><li>计数：<code>db.docs.count()</code></li></ul><blockquote>版本迁移使用 schemaVersion，新增字段时手动迁移即可。</blockquote>'
// v2 误删版：「常用查询」与「版本迁移」说明被删掉（恢复评审要回滚的就是这次修改）
const doc2V2Body = '<h2>IndexedDB 太繁琐？试试 Dexie</h2><p>Dexie 用关系型 <b>表</b> 与 <i>索引</i> 来封装 IndexedDB，极大简化读写。</p><pre><code>await db.docs.add({ title: "示例", body: "<p>内容</p>" })</code></pre>'

// 版本记录的内容快照（与 utils/version 的 docSnapshot 结构一致，这里不依赖文档当前字段）
function snapOf(doc, bodyOverride) {
  return {
    title: doc.title,
    body: bodyOverride !== undefined ? bodyOverride : doc.body,
    categoryId: doc.categoryId,
    tagIds: [...(doc.tagIds || [])],
    visibility: doc.visibility
  }
}

const seedDocs = [
  {
    id: 'doc-1', title: '前端工程初始化与目录规范',
    categoryId: 'c-dev', tagIds: ['t-vue', 't-guide'],
    visibility: 'public', ownerId: 'u-chen', editors: ['u-chen', 'u-xiaoye'],
    createdAt: ago(20 * d), updatedAt: ago(2 * d),
    body: '<h2>创建你的第一个 Vue 项目</h2><p>使用 <b>Vite</b> 脚手架可以快速初始化一个 Vue 3 工程。</p><pre><code>npm create vite@latest my-app -- --template vue</code></pre><p>目录划分为 <i>src/components</i>、<i>src/views</i>、<i>src/stores</i> 等，保持关注点分离。</p><ul><li>组件：按功能拆分子目录</li><li>状态：统一交给 Pinia 管理</li><li>路由：懒加载视图</li></ul>'
  },
  {
    id: 'doc-2', title: 'Dexie 数据库操作指南',
    categoryId: 'c-dev', tagIds: ['t-db', 't-guide'],
    visibility: 'public', ownerId: 'u-chen', editors: ['u-chen'],
    createdAt: ago(15 * d), updatedAt: ago(5 * d),
    body: doc2Body
  },
  {
    id: 'doc-3', title: 'API 鉴权与权限模型',
    categoryId: 'c-dev', tagIds: ['t-api', 't-security'],
    visibility: 'team', ownerId: 'u-admin', editors: ['u-admin', 'u-chen'],
    createdAt: ago(10 * d), updatedAt: ago(3 * d),
    body: doc3Body
  },
  {
    id: 'doc-4', title: '产品需求评审 Checklist',
    categoryId: 'c-product', tagIds: ['t-guide', 't-faq'],
    visibility: 'public', ownerId: 'u-ziwei', editors: ['u-ziwei', 'u-mochen'],
    createdAt: ago(12 * d), updatedAt: ago(1 * d),
    body: '<h2>评审前必查项</h2><ol><li>目标用户与使用场景是否明确</li><li>数据埋点是否齐全</li><li>异常态与边界是否覆盖</li><li>是否有对应的验收标准</li></ol><p>请在 <b>评审前 24h</b> 将 PRD 同步到知识库并 @ 相关成员。</p>'
  },
  {
    id: 'doc-5', title: '新成员入职指引',
    categoryId: 'c-life', tagIds: ['t-onboarding', 't-faq'],
    visibility: 'public', ownerId: 'u-admin', editors: ['u-admin'],
    createdAt: ago(30 * d), updatedAt: ago(30 * d),
    body: '<h2>欢迎加入团队</h2><p>第一天你将完成：账号开通、环境搭建、代码仓库权限、内部工具说明。</p><ul><li>查看「入职 Checklist」文档</li><li>加入团队频道并设置头像</li><li>联系 mentor 安排一对一交流</li></ul><p>遇到问题可随时 <i>@行政</i> 获取帮助。</p>'
  },
  {
    id: 'doc-6', title: '线上故障排查手册',
    categoryId: 'c-ops', tagIds: ['t-security', 't-faq'],
    visibility: 'team', ownerId: 'u-admin', editors: ['u-chen', 'u-xiaoye', 'u-admin'],
    createdAt: ago(8 * d), updatedAt: ago(6 * h),
    body: '<h2>通用排查步骤</h2><ol><li>查看监控大盘与告警面板</li><li>拉取最近 15 分钟日志，定位错误堆栈</li><li>核对配置版本与灰度开关</li><li>依据 runbook 执行回滚或隔离</li></ol><blockquote>切勿在未知情的情况下直接改生产数据。</blockquote><p>若涉及 <b>密钥泄露</b> 请立即轮换并触发安全响应流程。</p>'
  },
  {
    id: 'doc-7', title: 'Vue 组件设计最佳实践',
    categoryId: 'c-dev', tagIds: ['t-vue', 't-api'],
    visibility: 'private', ownerId: 'u-xiaoye', editors: ['u-xiaoye'],
    createdAt: ago(6 * d), updatedAt: ago(6 * d),
    body: '<h2>组件分层</h2><p>推荐 <b>展示型 / 容器型</b> 拆分，展示型组件不感知数据源。</p><pre><code>defineProps({ items: Array })</code></pre><h3>口诀</h3><ul><li>Props 往下传事件往上抛</li><li>避免在组件内直接改 props</li><li>复杂逻辑外提 composable</li></ul>'
  },
  {
    id: 'doc-8', title: '企业安全基线要求',
    categoryId: 'c-dev', tagIds: ['t-security'],
    visibility: 'team', ownerId: 'u-admin', editors: ['u-admin', 'u-chen'],
    createdAt: ago(18 * d), updatedAt: ago(7 * d),
    body: '<h2>密码与会话策略</h2><ul><li>强制启用两步验证</li><li>会话 14 天过期，支持强制下线</li><li>敏感操作需二次确认</li></ul><p>详见 <i>安全响应手册</i> 相关章节。</p>'
  },
  {
    id: 'doc-9', title: '年度薪酬调整方案（保密）',
    categoryId: 'c-product', tagIds: ['t-security'],
    visibility: 'private', ownerId: 'u-admin', editors: ['u-admin'],
    createdAt: ago(20 * d), updatedAt: ago(2 * d),
    body: '<h2>调整原则</h2><p>本方案为保密材料，仅限拥有者与获授权成员访问，授权到期或撤销后自动收回阅读与协作权限。</p><ul><li>按绩效与市场分位综合评定</li><li>调整比例与预算挂钩</li><li>公示前严禁外传</li></ul>'
  }
]

const seedComments = [
  { id: 'cmt-1', docId: 'doc-1', authorId: 'u-xiaoye', mentionIds: ['u-chen'], content: '@陈思涵 补充一下 lint 规则部分吧？', createdAt: ago(1 * d) },
  { id: 'cmt-2', docId: 'doc-1', authorId: 'u-chen', mentionIds: [], content: '已补充，见代码块。', createdAt: ago(20 * h) },
  { id: 'cmt-3', docId: 'doc-4', authorId: 'u-mochen', mentionIds: ['u-ziwei'], content: '需要补一版交互还原图，麻烦 @王子薇 确认排期。', createdAt: ago(2 * d) },
  { id: 'cmt-4', docId: 'doc-6', authorId: 'u-xiaoye', mentionIds: ['u-admin'], content: '已按手册完成一次演练，@林致远 请审核。', createdAt: ago(8 * h) },
  // 评审意见（reviewId 关联评审单，同时联动文档评论区展示）
  { id: 'cmt-r1-1', docId: 'doc-1', reviewId: 'rev-1', authorId: 'u-xiaoye', mentionIds: [], content: '补充工程规范条目并统一包管理器为 pnpm，请审批。', createdAt: ago(5 * h) },
  { id: 'cmt-r1-2', docId: 'doc-1', reviewId: 'rev-1', authorId: 'u-chen', mentionIds: [], content: '规范补充得很全，建议再加一条 git commit message 约定。', createdAt: ago(3 * h) },
  { id: 'cmt-r2-1', docId: 'doc-6', reviewId: 'rev-2', authorId: 'u-chen', mentionIds: [], content: '增补故障复盘要求。', createdAt: ago(2 * d) },
  { id: 'cmt-r2-2', docId: 'doc-6', reviewId: 'rev-2', authorId: 'u-xiaoye', mentionIds: [], content: '支持，演练后确实需要复盘闭环。', createdAt: ago(30 * h) },
  { id: 'cmt-r3-1', docId: 'doc-8', reviewId: 'rev-3', authorId: 'u-chen', mentionIds: [], content: '调整密码轮换周期，并收紧可见性。', createdAt: ago(4 * d) }
]

const seedShares = [
  { id: 'sh-1', docId: 'doc-1', token: 'share-abc123', permission: 'edit', createdBy: 'u-chen', createdAt: ago(2 * d), expiresAt: null, revokedAt: null },
  { id: 'sh-2', docId: 'doc-6', token: 'share-xyz789', permission: 'view', createdBy: 'u-admin', createdAt: ago(5 * d), expiresAt: null, revokedAt: null }
]

// ---- 评审流程演示数据 ----
// doc-1 正处于评审中（编辑者发起、成员已评论、等待管理员审批），正文锁定保持旧版
const doc1PendingBody = '<h2>创建你的第一个 Vue 项目</h2><p>推荐使用 <b>Vite</b> 脚手架初始化 Vue 3 工程，并统一使用 pnpm 管理依赖。</p><pre><code>pnpm create vite my-app --template vue</code></pre><p>目录划分为 <i>src/components</i>、<i>src/views</i>、<i>src/stores</i> 等，保持关注点分离。</p><ul><li>组件：按功能拆分子目录，单文件不超过 300 行</li><li>状态：统一交给 Pinia 管理，跨页面状态放 stores</li><li>路由：全部懒加载视图并配置权限 meta</li><li>提交前执行 eslint 与 prettier 检查</li></ul>'

// doc-6 的待审批快照（已通过并回写，仅用于演示留痕）
const doc6ApprovedBody = '<h2>通用排查步骤</h2><ol><li>查看监控大盘与告警面板</li><li>拉取最近 15 分钟日志，定位错误堆栈</li><li>核对配置版本与灰度开关</li><li>依据 runbook 执行回滚或隔离</li><li>故障恢复后 24h 内输出复盘报告</li></ol><blockquote>切勿在未知情的情况下直接改生产数据。</blockquote><p>若涉及 <b>密钥泄露</b> 请立即轮换并触发安全响应流程。</p>'

const seedReviews = [
  {
    id: 'rev-1', docId: 'doc-1', status: 'pending',
    submittedBy: 'u-xiaoye', submittedAt: ago(5 * h),
    snapshot: {
      title: '前端工程初始化与目录规范',
      body: doc1PendingBody,
      categoryId: 'c-dev', tagIds: ['t-vue', 't-guide'], visibility: 'public'
    },
    baseVersion: 1,
    decidedBy: null, decidedAt: null, decisionNote: '',
    timeline: [
      { action: 'submit', by: 'u-xiaoye', at: ago(5 * h), note: '补充工程规范条目并统一包管理器为 pnpm，请审批。' },
      { action: 'comment', by: 'u-chen', at: ago(3 * h), note: '规范补充得很全，建议再加一条 git commit message 约定。' }
    ]
  },
  {
    id: 'rev-2', docId: 'doc-6', status: 'approved',
    submittedBy: 'u-chen', submittedAt: ago(2 * d),
    snapshot: {
      title: '线上故障排查手册',
      body: doc6ApprovedBody,
      categoryId: 'c-ops', tagIds: ['t-security', 't-faq'], visibility: 'team'
    },
    baseVersion: 1,
    decidedBy: 'u-admin', decidedAt: ago(6 * h), decisionNote: '复盘环节很有必要，通过。',
    timeline: [
      { action: 'submit', by: 'u-chen', at: ago(2 * d), note: '增补故障复盘要求。' },
      { action: 'comment', by: 'u-xiaoye', at: ago(30 * h), note: '支持，演练后确实需要复盘闭环。' },
      { action: 'approve', by: 'u-admin', at: ago(6 * h), note: '复盘环节很有必要，通过。' }
    ]
  },
  {
    id: 'rev-3', docId: 'doc-8', status: 'rejected',
    submittedBy: 'u-chen', submittedAt: ago(4 * d),
    snapshot: {
      title: '企业安全基线要求（草案修订）',
      body: doc8RejectedBody(),
      categoryId: 'c-dev', tagIds: ['t-security'], visibility: 'private'
    },
    baseVersion: 1,
    decidedBy: 'u-admin', decidedAt: ago(3 * d), decisionNote: '可见性从团队改为私有范围过大，且强制改密周期需与运维确认，暂不通过。',
    timeline: [
      { action: 'submit', by: 'u-chen', at: ago(4 * d), note: '调整密码轮换周期，并收紧可见性。' },
      { action: 'reject', by: 'u-admin', at: ago(3 * d), note: '可见性从团队改为私有范围过大，且强制改密周期需与运维确认，暂不通过。' }
    ]
  }
]

function doc8RejectedBody() {
  return '<h2>密码与会话策略</h2><ul><li>强制启用两步验证</li><li>密码每 30 天强制更换一次</li><li>会话 7 天过期，支持强制下线</li><li>敏感操作需二次确认</li></ul>'
}

// ---- 缺口工单演示数据（v2 增量种子）----
// gap-3 已解决：关联 doc-3 与已通过的 rev-4，演示「审批发布后自动回填答案来源」的完整链路
const seedReview4 = {
  id: 'rev-4', docId: 'doc-3', status: 'approved',
  submittedBy: 'u-chen', submittedAt: ago(2 * d),
  snapshot: {
    title: 'API 鉴权与权限模型',
    body: doc3Body,
    categoryId: 'c-dev', tagIds: ['t-api', 't-security'], visibility: 'team'
  },
  baseVersion: 1,
  decidedBy: 'u-admin', decidedAt: ago(1 * d), decisionNote: '内容已覆盖权限申请流程，通过。',
  timeline: [
    { action: 'submit', by: 'u-chen', at: ago(2 * d), note: '补写缺口工单：新成员如何申请知识库的管理员权限？' },
    { action: 'approve', by: 'u-admin', at: ago(1 * d), note: '内容已覆盖权限申请流程，通过。' }
  ]
}

const seedGapTickets = [
  {
    id: 'gap-1',
    question: '离线环境下如何同步知识库内容？',
    detail: '出差途中经常没网，希望能离线编辑、联网后自动同步，目前文档里没有说明。',
    status: 'open',
    createdBy: 'u-mochen', createdAt: ago(3 * h),
    claimedBy: null, claimedAt: null, docId: null, reviewId: null, groupId: null, resolvedAt: null,
    timeline: [{ action: 'create', by: 'u-mochen', at: ago(3 * h), note: '' }]
  },
  // gap-4 与 gap-1 同为「离线/无网」类问题：演示编辑者勾选多个待认领工单后合并认领
  {
    id: 'gap-4',
    question: '断网时还能查看已经打开过的文档吗？',
    detail: '客户现场网络不稳定，想问下有没有本地缓存，至少能看之前读过的文档。',
    status: 'open',
    createdBy: 'u-xiaoye', createdAt: ago(5 * h),
    claimedBy: null, claimedAt: null, docId: null, reviewId: null, groupId: null, resolvedAt: null,
    timeline: [{ action: 'create', by: 'u-xiaoye', at: ago(5 * h), note: '' }]
  },
  // gap-2（主工单）+ gap-5：已合并认领的同类问题，共用一次送审，各自保留提问与 timeline
  {
    id: 'gap-2',
    question: '知识库支持导出为哪些格式？',
    detail: '',
    status: 'claimed',
    createdBy: 'u-xiaoye', createdAt: ago(26 * h),
    claimedBy: 'u-ziwei', claimedAt: ago(20 * h),
    docId: null, reviewId: null, groupId: 'gap-2', resolvedAt: null,
    timeline: [
      { action: 'create', by: 'u-xiaoye', at: ago(26 * h), note: '' },
      { action: 'claim', by: 'u-ziwei', at: ago(20 * h), note: '' },
      { action: 'merge', by: 'u-ziwei', at: ago(18 * h), note: '合并认领 2 个同类问题：知识库支持导出为哪些格式？ / 导出的文档能直接发给客户吗？' }
    ]
  },
  {
    id: 'gap-5',
    question: '导出的文档能直接发给客户吗？',
    detail: '需要把几篇操作指南外发，想确认导出件是否带水印或权限说明。',
    status: 'claimed',
    createdBy: 'u-mochen', createdAt: ago(19 * h),
    claimedBy: 'u-ziwei', claimedAt: ago(18 * h),
    docId: null, reviewId: null, groupId: 'gap-2', resolvedAt: null,
    timeline: [
      { action: 'create', by: 'u-mochen', at: ago(19 * h), note: '' },
      { action: 'merge', by: 'u-ziwei', at: ago(18 * h), note: '并入合并组，与主问题「知识库支持导出为哪些格式？」共用一次送审' }
    ]
  },
  {
    id: 'gap-3',
    question: '新成员如何申请知识库的管理员权限？',
    detail: '入职指引里只讲了账号开通，没有说明权限申请入口。',
    status: 'resolved',
    createdBy: 'u-xiaoye', createdAt: ago(3 * d),
    claimedBy: 'u-chen', claimedAt: ago(2 * d + 2 * h),
    docId: 'doc-3', reviewId: 'rev-4', groupId: null, resolvedAt: ago(1 * d),
    timeline: [
      { action: 'create', by: 'u-xiaoye', at: ago(3 * d), note: '' },
      { action: 'claim', by: 'u-chen', at: ago(2 * d + 2 * h), note: '' },
      { action: 'submit', by: 'u-chen', at: ago(2 * d), note: '关联文档《API 鉴权与权限模型》送审' },
      { action: 'resolve', by: 'u-admin', at: ago(1 * d), note: '审批通过，答案来源已回填' }
    ]
  }
]

const seedFavorites = [
  { id: 'fav-1', userId: 'u-admin', docId: 'doc-1' },
  { id: 'fav-2', userId: 'u-admin', docId: 'doc-8' }
]

const seedRatings = [
  { id: 'rt-1', docId: 'doc-1', slug: 'helpful', authorId: 'u-chen', value: 1 },
  { id: 'rt-2', docId: 'doc-2', slug: 'helpful', authorId: 'u-ziwei', value: 1 }
]

// 文档种子补评审相关字段：
// - doc-1 评审中（锁定，正文为发起前旧版）
// - doc-6 已通过（待审快照已回写，追加 v2 审批通过版本）
// - doc-8 最近一次被驳回（内容不变，记录驳回结论）
// 所有版本记录均带内容快照（可比较/可恢复）
function withReviewFields(doc) {
  if (doc.id === 'doc-1') {
    return {
      ...doc,
      publishState: 'in_review',
      activeReviewId: 'rev-1',
      versions: [{ version: 1, savedAt: doc.updatedAt, savedBy: doc.ownerId, note: '初始版本', snapshot: snapOf(doc) }]
    }
  }
  if (doc.id === 'doc-6') {
    const approvedAt = ago(6 * h)
    return {
      ...doc,
      body: doc6ApprovedBody,
      updatedAt: approvedAt,
      publishState: 'published',
      activeReviewId: null,
      lastReview: { reviewId: 'rev-2', status: 'approved', by: 'u-admin', at: approvedAt, note: '复盘环节很有必要，通过。', version: 2 },
      versions: [
        { version: 1, savedAt: ago(8 * 24 * h), savedBy: doc.ownerId, note: '初始版本', snapshot: snapOf(doc) },
        { version: 2, savedAt: approvedAt, savedBy: 'u-chen', note: '评审通过后发布：复盘环节很有必要，通过。', reviewStatus: 'approved', reviewId: 'rev-2', decidedBy: 'u-admin', snapshot: snapOf(doc, doc6ApprovedBody) }
      ]
    }
  }
  if (doc.id === 'doc-8') {
    const rejectedAt = ago(3 * 24 * h)
    return {
      ...doc,
      publishState: 'published',
      activeReviewId: null,
      lastReview: { reviewId: 'rev-3', status: 'rejected', by: 'u-admin', at: rejectedAt, note: '可见性从团队改为私有范围过大，且强制改密周期需与运维确认，暂不通过。' },
      versions: [{ version: 1, savedAt: doc.updatedAt, savedBy: doc.ownerId, note: '初始版本', snapshot: snapOf(doc) }]
    }
  }
  return {
    ...doc,
    publishState: 'published',
    activeReviewId: null,
    versions: [{ version: 1, savedAt: doc.updatedAt, savedBy: doc.ownerId, note: '初始版本', snapshot: snapOf(doc) }]
  }
}

// ---- 版本恢复演示数据（doc-2）----
// v1 初始 → v2 误删「常用查询/版本迁移」→ 王子薇发起恢复评审（rev-5）→ 管理员通过生成 v3（恢复自 v1）
// v2 被标记为「已被 v3 恢复覆盖」，演示恢复边界；doc-2 当前内容 = v1 内容
const doc2Snap = (body) => ({ title: 'Dexie 数据库操作指南', body, categoryId: 'c-dev', tagIds: ['t-db', 't-guide'], visibility: 'public' })

function doc2RestoreVersions() {
  const restoredAt = ago(1 * d)
  return [
    { version: 1, savedAt: ago(15 * d), savedBy: 'u-chen', note: '初始版本', snapshot: doc2Snap(doc2Body) },
    { version: 2, savedAt: ago(3 * d), savedBy: 'u-chen', note: '编辑文档', snapshot: doc2Snap(doc2V2Body), supersededBy: { version: 3, at: restoredAt } },
    {
      version: 3, savedAt: restoredAt, savedBy: 'u-ziwei',
      note: '恢复至 v1：确认误删，恢复。',
      reviewStatus: 'approved', reviewId: 'rev-5', decidedBy: 'u-admin',
      restore: { fromVersion: 1, rolledBack: [2], rolledBackConcurrent: [], reviewId: 'rev-5', decidedBy: 'u-admin' },
      snapshot: doc2Snap(doc2Body)
    }
  ]
}

const seedReview5 = {
  id: 'rev-5', docId: 'doc-2', status: 'approved',
  submittedBy: 'u-ziwei', submittedAt: ago(2 * d),
  snapshot: doc2Snap(doc2Body),
  baseVersion: 2,
  restoreFrom: { version: 1, savedAt: ago(15 * d), savedBy: 'u-chen' },
  decidedBy: 'u-admin', decidedAt: ago(1 * d), decisionNote: '确认误删，恢复。',
  restoreResult: { rolledBack: [2], rolledBackConcurrent: [] },
  timeline: [
    { action: 'restore-submit', by: 'u-ziwei', at: ago(2 * d), note: 'v2 误删了常用查询与版本迁移说明，申请恢复至 v1。' },
    { action: 'approve', by: 'u-admin', at: ago(1 * d), note: '确认误删，恢复。' }
  ]
}

// 种子版本：v1 基础数据；v2 缺口工单演示数据（含 rev-4 评审留痕与 doc-3 审批回写）；
// v3 文档访问申请演示数据（doc-9 保密文档上的限时阅读/协作授权、撤销与到期留痕）；
// v4 版本快照回填与 doc-2 恢复演示（v2 误删 + rev-5 恢复评审通过 + v3 恢复边界标记）；
// v5 知识保鲜演示（doc-8 逾期整改中 / doc-1 修订送审中 / doc-5 复核通过 / doc-6 保鲜运行中）；
// v6 责任交接演示（ho-1 待确认 / ho-2 已完成含历史归属 / ho-3 并发变更失败回退）；
// v7 分类复核策略演示（fp-1 产品设计分类 180 天：doc-9 继承策略，doc-4 文档级覆盖 + 在途复核单保留快照）
const SEED_VER = '7'

async function isSeeded() {
  return (await getMeta('seeded')) === SEED_VER
}

// v2 增量种子：缺口工单 + 关联的评审留痕。老库升级时补充，全新安装在基础种子后顺带执行
async function ensureGapSeed() {
  if ((await db.gapTickets.count()) > 0) return
  if (!(await db.reviews.get('rev-4'))) await db.reviews.add(seedReview4)
  if (!(await db.comments.get('cmt-r4-1'))) {
    await db.comments.add({ id: 'cmt-r4-1', docId: 'doc-3', reviewId: 'rev-4', authorId: 'u-chen', mentionIds: [], content: '补写缺口工单：新成员如何申请知识库的管理员权限？', createdAt: ago(2 * d) })
  }
  // doc-3 回写审批结论：正文不变（送审快照即当前内容），追加「审批通过」版本留痕
  const doc3 = await db.docs.get('doc-3')
  if (doc3 && !doc3.lastReview) {
    const decidedAt = ago(1 * d)
    const versions = doc3.versions?.length
      ? doc3.versions
      : [{ version: 1, savedAt: doc3.createdAt, savedBy: doc3.ownerId, note: '初始版本', snapshot: snapOf(doc3) }]
    await db.docs.put({
      ...doc3,
      updatedAt: decidedAt,
      lastReview: { reviewId: 'rev-4', status: 'approved', by: 'u-admin', at: decidedAt, note: '内容已覆盖权限申请流程，通过。', version: versions.length + 1 },
      versions: [...versions, { version: versions.length + 1, savedAt: decidedAt, savedBy: 'u-chen', note: '评审通过后发布：内容已覆盖权限申请流程，通过。', reviewStatus: 'approved', reviewId: 'rev-4', decidedBy: 'u-admin', snapshot: snapOf(doc3) }]
    })
  }
  await db.gapTickets.bulkAdd(seedGapTickets)
}

// ---- 文档访问申请演示数据（v3 增量种子）----
// 在保密文档 doc-9 上覆盖完整链路：
// acc-1 限时阅读（生效中，30 天）→ 可登录高晓叶查看详情/搜索/问答命中
// acc-2 限时协作（生效中，7 天）→ 只读成员莫尘在授权期内可直接编辑该文档
// acc-3 已驳回（高晓叶更早的一次协作申请被驳回）
// acc-4 限时阅读（生效 1 天后被拥有者撤销）→ 撤销后权限即时收回，记录保留
// acc-5 限时阅读（30 天，已到期）→ 到期惰性收回，timeline 补到期留痕
const seedAccessRequests = [
  {
    id: 'acc-1', docId: 'doc-9', applicantId: 'u-xiaoye',
    status: 'approved', requestedPermission: 'read',
    reason: '需要对照薪酬结构梳理前端自助查询页面的字段，请开通短期阅读权限。',
    createdAt: ago(2 * d),
    decidedBy: 'u-admin', decidedAt: ago(2 * d - 2 * h), decisionNote: '仅用于页面字段核对，开通 30 天阅读。',
    expiresAt: ago(-28 * d), revokedAt: null,
    grant: { permission: 'read', grantedAt: ago(2 * d - 2 * h), expiresAt: ago(-28 * d), revokedAt: null },
    timeline: [
      { action: 'apply', by: 'u-xiaoye', at: ago(2 * d), note: '需要对照薪酬结构梳理前端自助查询页面的字段，请开通短期阅读权限。' },
      { action: 'approve', by: 'u-admin', at: ago(2 * d - 2 * h), note: '授权限时阅读，有效期 30 天：仅用于页面字段核对，开通 30 天阅读。' }
    ]
  },
  {
    id: 'acc-2', docId: 'doc-9', applicantId: 'u-mochen',
    status: 'approved', requestedPermission: 'collab',
    reason: '方案中的保密标识视觉样式需要我配合调整，申请协作权限。',
    createdAt: ago(30 * h),
    decidedBy: 'u-admin', decidedAt: ago(28 * h), decisionNote: '仅调整保密标识样式，开通 7 天协作。',
    expiresAt: ago(-6 * d + 28 * h), revokedAt: null,
    grant: { permission: 'collab', grantedAt: ago(28 * h), expiresAt: ago(-6 * d + 28 * h), revokedAt: null },
    timeline: [
      { action: 'apply', by: 'u-mochen', at: ago(30 * h), note: '方案中的保密标识视觉样式需要我配合调整，申请协作权限。' },
      { action: 'approve', by: 'u-admin', at: ago(28 * h), note: '授权限时协作，有效期 7 天：仅调整保密标识样式，开通 7 天协作。' }
    ]
  },
  {
    id: 'acc-3', docId: 'doc-9', applicantId: 'u-xiaoye',
    status: 'rejected', requestedPermission: 'collab',
    reason: '希望直接补充页面交互说明。',
    createdAt: ago(10 * d),
    decidedBy: 'u-admin', decidedAt: ago(9 * d), decisionNote: '薪酬方案不开放协作编辑，字段核对可重新申请只读权限。',
    grant: null,
    timeline: [
      { action: 'apply', by: 'u-xiaoye', at: ago(10 * d), note: '希望直接补充页面交互说明。' },
      { action: 'reject', by: 'u-admin', at: ago(9 * d), note: '薪酬方案不开放协作编辑，字段核对可重新申请只读权限。' }
    ]
  },
  {
    id: 'acc-4', docId: 'doc-9', applicantId: 'u-ziwei',
    status: 'revoked', requestedPermission: 'read',
    reason: '核对产品侧预算口径。',
    createdAt: ago(8 * d),
    decidedBy: 'u-admin', decidedAt: ago(8 * d - 3 * h), decisionNote: '开通 1 天阅读。',
    expiresAt: ago(7 * d - 3 * h), revokedAt: ago(7 * d),
    grant: { permission: 'read', grantedAt: ago(8 * d - 3 * h), expiresAt: ago(7 * d - 3 * h), revokedAt: ago(7 * d) },
    timeline: [
      { action: 'apply', by: 'u-ziwei', at: ago(8 * d), note: '核对产品侧预算口径。' },
      { action: 'approve', by: 'u-admin', at: ago(8 * d - 3 * h), note: '授权限时阅读，有效期 1 天：开通 1 天阅读。' },
      { action: 'revoke', by: 'u-admin', at: ago(7 * d), note: '预算口径调整，提前收回阅读权限。' }
    ]
  },
  {
    id: 'acc-5', docId: 'doc-9', applicantId: 'u-chen',
    status: 'approved', requestedPermission: 'read',
    reason: '评估调薪数据对服务端存储与加密的要求。',
    createdAt: ago(40 * d),
    decidedBy: 'u-admin', decidedAt: ago(39 * d), decisionNote: '开通 30 天阅读。',
    expiresAt: ago(9 * d), revokedAt: null,
    grant: { permission: 'read', grantedAt: ago(39 * d), expiresAt: ago(9 * d), revokedAt: null },
    timeline: [
      { action: 'apply', by: 'u-chen', at: ago(40 * d), note: '评估调薪数据对服务端存储与加密的要求。' },
      { action: 'approve', by: 'u-admin', at: ago(39 * d), note: '授权限时阅读，有效期 30 天：开通 30 天阅读。' },
      { action: 'expire', by: 'system', at: ago(9 * d), note: '授权到期，阅读与协作权限已自动收回' }
    ]
  },
  // doc-7 私有组件文档：一条待审批申请，登录拥有者高晓叶或管理员可在访问授权中心审批
  {
    id: 'acc-6', docId: 'doc-7', applicantId: 'u-mochen',
    status: 'pending', requestedPermission: 'read',
    reason: '设计组件库时想参考你文档里的展示型/容器型拆分约定，申请 7 天阅读。',
    createdAt: ago(4 * h),
    decidedBy: null, decidedAt: null, decisionNote: '',
    grant: null,
    timeline: [
      { action: 'apply', by: 'u-mochen', at: ago(4 * h), note: '设计组件库时想参考你文档里的展示型/容器型拆分约定，申请 7 天阅读。' }
    ]
  }
]

// v3 增量种子：访问申请与授权记录。老库升级时补充，全新安装在基础种子后顺带执行
async function ensureAccessSeed() {
  if ((await db.accessRequests.count()) > 0) return
  await db.accessRequests.bulkAdd(seedAccessRequests)
}

// ---- 版本快照与恢复演示（v4 增量种子）----
// 1) 回填：所有文档的最新版本补上当前内容快照（最新版本的内容即当前内容，回填总是正确；
//    更早的历史版本无法重建内容，保留为无快照的元数据记录，界面上标记「无快照」）
// 2) doc-2 恢复演示：仅在文档保持种子原样（未被用户编辑）时追加 v2 误删 + v3 恢复，
//    避免在用户已修改的文档上伪造历史
async function ensureRestoreSeed() {
  const allDocs = await db.docs.toArray()
  for (const d of allDocs) {
    const versions = d.versions || []
    if (!versions.length) continue
    const latest = versions[versions.length - 1]
    if (!latest.snapshot) {
      const fixed = [...versions]
      fixed[fixed.length - 1] = { ...latest, snapshot: snapOf(d) }
      await db.docs.update(d.id, { versions: fixed })
    }
  }
  const doc2 = await db.docs.get('doc-2')
  if (doc2 && (doc2.versions || []).length === 1 && doc2.body === doc2Body) {
    const restoredAt = ago(1 * d)
    await db.docs.update('doc-2', {
      updatedAt: restoredAt,
      lastReview: { reviewId: 'rev-5', status: 'approved', by: 'u-admin', at: restoredAt, note: '确认误删，恢复。', version: 3 },
      versions: doc2RestoreVersions()
    })
    if (!(await db.reviews.get('rev-5'))) await db.reviews.add(seedReview5)
  }
}

// ---- 知识保鲜演示（v5 增量种子）----
// doc-8：30 天周期，已逾期 2 天、管理员此前驳回过一次（fr-1 rejected，待整改），问答引用暂停。
// doc-4：180 天周期已逾期，王子薇修订后送保鲜复核（rev-6 pending，fr-2 submitted），文档锁定。
// doc-5：365 天周期，上一轮「确认内容有效」复核通过（rev-7 approved, noChange），周期重算中。
// doc-6：90 天周期，保鲜运行中，约 6 小时后到期（演示调度器临近到期但暂不触发）。

// doc-4 的保鲜修订快照（补充验收数据口径，rev-6 待审批）
const doc4FreshBody = '<h2>评审前必查项</h2><ol><li>目标用户与使用场景是否明确</li><li>数据埋点是否齐全</li><li>异常态与边界是否覆盖</li><li>是否有对应的验收标准</li><li>验收数据口径是否与数据团队对齐</li></ol><p>请在 <b>评审前 24h</b> 将 PRD 同步到知识库并 @ 相关成员。</p>'

const seedFreshReviews = [
  {
    id: 'rev-6', docId: 'doc-4', status: 'pending',
    submittedBy: 'u-ziwei', submittedAt: ago(3 * h),
    snapshot: {
      title: '产品需求评审 Checklist',
      body: doc4FreshBody,
      categoryId: 'c-product', tagIds: ['t-guide', 't-faq'], visibility: 'public'
    },
    baseVersion: 1,
    freshTicketId: 'fr-2', freshRound: 1, freshNoChange: false,
    decidedBy: null, decidedAt: null, decisionNote: '',
    timeline: [
      { action: 'fresh-submit', by: 'u-ziwei', at: ago(3 * h), note: '保鲜复核：补充验收数据口径一条，请复核。' }
    ]
  },
  {
    id: 'rev-7', docId: 'doc-5', status: 'approved',
    submittedBy: 'u-admin', submittedAt: ago(10 * d),
    snapshot: {
      title: '新成员入职指引',
      body: seedDocs.find((x) => x.id === 'doc-5').body,
      categoryId: 'c-life', tagIds: ['t-onboarding', 't-faq'], visibility: 'public'
    },
    baseVersion: 1,
    freshTicketId: 'fr-3', freshRound: 1, freshNoChange: true,
    decidedBy: 'u-admin', decidedAt: ago(10 * d), decisionNote: '入职流程本季度无变化，确认继续有效。',
    timeline: [
      { action: 'fresh-submit-nochange', by: 'u-admin', at: ago(10 * d), note: '年度复核：入职流程无变化。' },
      { action: 'approve', by: 'u-admin', at: ago(10 * d), note: '入职流程本季度无变化，确认继续有效。' }
    ]
  }
]

const seedFreshTickets = [
  {
    id: 'fr-1', docId: 'doc-8', round: 1, status: 'rejected',
    cycleDays: 30, ruleSource: 'doc', policyId: null, dueAt: ago(2 * d),
    reviewId: null, submittedBy: 'u-chen', submittedAt: ago(1 * d + 4 * h),
    decidedBy: 'u-admin', decidedAt: ago(1 * d),
    decisionNote: '强制改密周期需与运维确认后再修订，请补充具体策略。',
    createdAt: ago(2 * d),
    timeline: [
      { action: 'due', by: 'system', at: ago(2 * d), note: '复核周期到点，自动生成复核单并暂停问答引用' },
      { action: 'submit', by: 'u-chen', at: ago(1 * d + 4 * h), note: '复核安全基线条目，无实质修改，请确认。' },
      { action: 'reject', by: 'u-admin', at: ago(1 * d), note: '强制改密周期需与运维确认后再修订，请补充具体策略。' }
    ]
  },
  {
    id: 'fr-2', docId: 'doc-4', round: 1, status: 'submitted',
    cycleDays: 180, ruleSource: 'doc', policyId: null, dueAt: ago(1 * d),
    reviewId: 'rev-6', submittedBy: 'u-ziwei', submittedAt: ago(3 * h),
    decidedBy: null, decidedAt: null, decisionNote: '',
    createdAt: ago(1 * d),
    timeline: [
      { action: 'due', by: 'system', at: ago(1 * d), note: '复核周期到点，自动生成复核单并暂停问答引用' },
      { action: 'submit', by: 'u-ziwei', at: ago(3 * h), note: '保鲜复核：补充验收数据口径一条，请复核。' }
    ]
  },
  {
    id: 'fr-3', docId: 'doc-5', round: 1, status: 'approved',
    cycleDays: 365, ruleSource: 'doc', policyId: null, dueAt: ago(10 * d),
    reviewId: 'rev-7', submittedBy: 'u-admin', submittedAt: ago(10 * d),
    decidedBy: 'u-admin', decidedAt: ago(10 * d),
    decisionNote: '入职流程本季度无变化，确认继续有效。',
    nextDueAt: ago(-355 * d),
    createdAt: ago(10 * d),
    timeline: [
      { action: 'due', by: 'system', at: ago(10 * d), note: '复核周期到点，自动生成复核单并暂停问答引用' },
      { action: 'submit-nochange', by: 'u-admin', at: ago(10 * d), note: '年度复核：入职流程无变化。' },
      { action: 'approve', by: 'u-admin', at: ago(10 * d), note: '入职流程本季度无变化，确认继续有效。' }
    ]
  }
]

async function ensureFreshnessSeed() {
  if ((await db.freshnessTickets.count()) > 0) return
  await db.freshnessTickets.bulkAdd(seedFreshTickets)
  for (const rv of seedFreshReviews) {
    if (!(await db.reviews.get(rv.id))) await db.reviews.add(rv)
  }
  // doc-8：30 天周期逾期整改中（问答引用暂停），沿用 rev-3 的驳回结论与 v1 版本
  const doc8 = await db.docs.get('doc-8')
  if (doc8 && !doc8.freshness) {
    await db.docs.update('doc-8', { freshness: { cycleDays: 30, nextDueAt: ago(2 * d), round: 1, activeTicket: 'fr-1', source: 'doc', policyId: null } })
  }
  // doc-4：保鲜复核送审中，文档锁定，正文仍为旧版（rev-6 快照通过后才回写）
  const doc4 = await db.docs.get('doc-4')
  if (doc4 && !doc4.freshness) {
    await db.docs.update('doc-4', {
      publishState: 'in_review',
      activeReviewId: 'rev-6',
      freshness: { cycleDays: 180, nextDueAt: ago(1 * d), round: 1, activeTicket: 'fr-2', source: 'doc', policyId: null }
    })
  }
  // doc-5：上一轮「确认有效」复核通过，noChange 不产生新版本，周期重算至约 355 天后
  const doc5 = await db.docs.get('doc-5')
  if (doc5 && !doc5.freshness) {
    const approvedAt = ago(10 * d)
    await db.docs.update('doc-5', {
      updatedAt: approvedAt,
      lastReview: { reviewId: 'rev-7', status: 'approved', by: 'u-admin', at: approvedAt, note: '入职流程本季度无变化，确认继续有效。' },
      freshness: {
        cycleDays: 365, nextDueAt: ago(-355 * d), round: 1, activeTicket: null,
        source: 'doc', policyId: null,
        lastApprovedAt: approvedAt, lastApprovedBy: 'u-admin', lastReviewId: 'rev-7'
      }
    })
  }
  // doc-6：90 天周期保鲜运行中，约 6 小时后到期（不到点，不生成复核单、不影响引用）
  const doc6 = await db.docs.get('doc-6')
  if (doc6 && !doc6.freshness) {
    await db.docs.update('doc-6', { freshness: { cycleDays: 90, nextDueAt: ago(-6 * h), round: 0, activeTicket: null, source: 'doc', policyId: null } })
  }
}

// ---- 责任交接演示（v6 增量种子）----
// ho-1 流转中（逐篇接任者）：陈思涵同一批交接 doc-1 与 doc-2——doc-1 指定王子薇（待确认）、
//   doc-2 指定高晓叶（已确认待批准）；各接任者独立确认，管理员可按确认结果分批批准。
//   快照取自发起时刻——若先在评审中心处理了 rev-1 或编辑了这两篇文档，批准时将因并发
//   变更校验失败而回退对应篇，可直接演示交接期间的并发保护。
// ho-2 已完成：林致远把 doc-5（新成员入职指引，含保鲜责任）交接给陈思涵并收回自身协作权限，
//   doc-5 保留历史归属（ownerHistory），可对照「历任负责人」展示。
// ho-3 已失败回退：陈思涵早前交接 doc-2 给王子薇，流转期间王子薇的恢复评审 rev-5 通过、
//   文档内容更新，管理员批准时校验不一致，该篇回退未产生任何转移（随后重新发起为 ho-1）。
async function ensureHandoverSeed() {
  if ((await db.handovers.count()) > 0) return

  // ho-1 / ho-3 的快照取自库中最新文档，保证「立即确认并批准」可走完正常链路
  const doc1 = await db.docs.get('doc-1')
  const doc2 = await db.docs.get('doc-2')
  const snapOf = (d) => ({
    ownerId: d.ownerId,
    updatedAt: d.updatedAt,
    activeReviewId: d.activeReviewId || null,
    freshnessSig: d.freshness
      ? [d.freshness.cycleDays, d.freshness.nextDueAt, d.freshness.round, d.freshness.activeTicket || ''].join('|')
      : '-'
  })
  const itemOf = (doc, toUserId, status, extra = {}) => ({
    docId: doc.id, title: doc.title, toUserId, status, snapshot: snapOf(doc),
    confirmedAt: null, decidedBy: null, decidedAt: null, decideNote: '',
    completedAt: null, failReason: '', result: null,
    ...extra
  })
  const handovers = []
  if (doc1 && doc2) {
    handovers.push({
      id: 'ho-1', status: 'pending_confirm',
      fromUserId: 'u-chen',
      docIds: ['doc-1', 'doc-2'], revokeMode: 'keep',
      note: '轮岗调整：开发规范交接给子薇、数据库指南交接给晓叶，各自确认后请管理员分批批准。',
      items: [
        itemOf(doc1, 'u-ziwei', 'pending_confirm'),
        itemOf(doc2, 'u-xiaoye', 'confirmed', { confirmedAt: ago(1 * h) })
      ],
      createdAt: ago(3 * h),
      timeline: [
        { action: 'initiate', by: 'u-chen', at: ago(3 * h), note: '轮岗调整：开发规范交接给子薇、数据库指南交接给晓叶，各自确认后请管理员分批批准。' },
        { action: 'confirm', by: 'u-xiaoye', at: ago(1 * h), note: '《' + doc2.title + '》' }
      ]
    })
    handovers.push({
      id: 'ho-3', status: 'failed',
      fromUserId: 'u-chen',
      docIds: ['doc-2'], revokeMode: 'keep',
      note: 'Dexie 指南交接给子薇维护。',
      items: [
        itemOf(doc2, 'u-ziwei', 'failed', {
          snapshot: { ownerId: 'u-chen', updatedAt: ago(2 * d), activeReviewId: null, freshnessSig: '-' },
          confirmedAt: ago(30 * h), decidedBy: 'u-admin', decidedAt: ago(1 * d),
          failReason: '交接期间文档发生并发变更：内容已更新。该篇未执行任何转移，请确认后重新发起。'
        })
      ],
      createdAt: ago(2 * d),
      timeline: [
        { action: 'initiate', by: 'u-chen', at: ago(2 * d), note: 'Dexie 指南交接给子薇维护。' },
        { action: 'confirm', by: 'u-ziwei', at: ago(30 * h), note: '《' + doc2.title + '》' },
        { action: 'fail', by: 'u-admin', at: ago(1 * d), note: '《' + doc2.title + '》交接期间文档发生并发变更：内容已更新。该篇未执行任何转移，请确认后重新发起。' }
      ]
    })
  }

  // ho-2 已完成：doc-5 所有权移交陈思涵，历史归属与交接结果随单留档
  const doc5 = await db.docs.get('doc-5')
  if (doc5) {
    const completedAt = ago(5 * d)
    handovers.push({
      id: 'ho-2', status: 'completed',
      fromUserId: 'u-admin',
      docIds: ['doc-5'], revokeMode: 'revoke',
      note: '入职指引后续由思涵长期维护，我的协作权限一并收回。',
      items: [
        itemOf(doc5, 'u-chen', 'completed', {
          snapshot: { ownerId: 'u-admin', updatedAt: ago(10 * d), activeReviewId: null, freshnessSig: ['365', ago(-355 * d), 1, ''].join('|') },
          confirmedAt: ago(6 * d - 2 * h), decidedBy: 'u-admin', decidedAt: completedAt,
          decideNote: '同意交接，保鲜复核责任一并转移。', completedAt,
          result: { reviewIds: [], freshTicketId: null, accessPending: 0, revokedGrants: 0 }
        })
      ],
      createdAt: ago(6 * d),
      timeline: [
        { action: 'initiate', by: 'u-admin', at: ago(6 * d), note: '入职指引后续由思涵长期维护，我的协作权限一并收回。' },
        { action: 'confirm', by: 'u-chen', at: ago(6 * d - 2 * h), note: '《' + doc5.title + '》' },
        { action: 'approve', by: 'u-admin', at: completedAt, note: '《' + doc5.title + '》：同意交接，保鲜复核责任一并转移。' }
      ]
    })
    // 应用 ho-2 的转移结果：所有权 + 历史归属 + 按交接决定收回原负责人协作权限
    if (doc5.ownerId === 'u-admin' && !(doc5.ownerHistory || []).length) {
      await db.docs.update('doc-5', {
        ownerId: 'u-chen',
        editors: ['u-chen'],
        ownerHistory: [{ ownerId: 'u-admin', until: completedAt, handoverId: 'ho-2', toUserId: 'u-chen' }]
      })
    }
  }

  await db.handovers.bulkAdd(handovers)
}

// ---- 分类复核策略演示（v7 增量种子）----
// fp-1「产品设计」分类统一 180 天复核：
// - doc-9（保密薪酬方案）无单独配置 → 继承策略，批量纳入保鲜（约 180 天后到期）；
// - doc-4 有文档级 180 天配置且复核送审中 → 保留文档级覆盖与在途复核单规则快照，不受策略影响。
// 老库升级时补充；已有逐篇配置由 Dexie v9 迁移标记为文档级覆盖（source='doc'），此处不再改写。
async function ensurePolicySeed() {
  if ((await db.freshnessPolicies.count()) > 0) return
  const nowIso = new Date().toISOString()
  await db.freshnessPolicies.add({
    id: 'fp-1', categoryId: 'c-product', cycleDays: 180,
    createdBy: 'u-admin', updatedBy: 'u-admin', createdAt: nowIso, updatedAt: nowIso,
    timeline: [{ action: 'policy-setting', by: 'u-admin', at: nowIso, note: '产品设计分类统一按 180 天周期复核，文档可单独覆盖' }]
  })
  const doc9 = await db.docs.get('doc-9')
  if (doc9 && !doc9.freshness) {
    await db.docs.update('doc-9', {
      freshness: {
        cycleDays: 180, nextDueAt: ago(-180 * d), round: 0, activeTicket: null,
        source: 'policy', policyId: 'fp-1', updatedAt: nowIso
      }
    })
  }
}

export async function ensureSeeded() {
  if (await isSeeded()) return
  await db.transaction('rw', db.users, db.categories, db.tags, db.docs, db.comments, db.shares, db.favorites, db.ratings, db.reviews, db.gapTickets, db.accessRequests, db.freshnessTickets, db.handovers, db.freshnessPolicies, async () => {
    if ((await db.users.count()) === 0) {
      await db.users.bulkAdd(seedUsers)
      await db.categories.bulkAdd(seedCategories)
      await db.tags.bulkAdd(seedTags)
      await db.docs.bulkAdd(seedDocs.map(withReviewFields))
      await db.comments.bulkAdd(seedComments)
      await db.shares.bulkAdd(seedShares)
      await db.favorites.bulkAdd(seedFavorites)
      await db.ratings.bulkAdd(seedRatings)
      await db.reviews.bulkAdd(seedReviews)
    }
    await ensureGapSeed()
    await ensureAccessSeed()
    await ensureRestoreSeed()
    await ensureFreshnessSeed()
    await ensureHandoverSeed()
    await ensurePolicySeed()
  })
  await setMeta('seeded', SEED_VER)
}