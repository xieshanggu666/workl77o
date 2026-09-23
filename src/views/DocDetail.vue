<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useEngagementStore } from '@/stores/engagement'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useHandoverStore } from '@/stores/handover'
import { useRetirementStore } from '@/stores/retirement'
import DocPill from '@/components/common/DocPill.vue'
import MemberSelect from '@/components/common/MemberSelect.vue'
import ShareDialog from '@/components/doc/ShareDialog.vue'
import ReviewPanel from '@/components/doc/ReviewPanel.vue'
import FreshnessPanel from '@/components/doc/FreshnessPanel.vue'
import RetirementPanel from '@/components/doc/RetirementPanel.vue'
import AccessApplyCard from '@/components/doc/AccessApplyCard.vue'
import AccessPanel from '@/components/doc/AccessPanel.vue'
import { formatFull, formatDate, avatarColor } from '@/utils/format'
import { canEditDoc, canDeleteDoc, canViewDoc, GUEST_ID } from '@/utils/permission'
import { versionReviewBadge, versionRestoreBadges, canSubmitReview } from '@/utils/review'
import { freshVersionBadge } from '@/utils/freshness'
import { diffVersionFields, diffBodyLines, docSnapshot, fieldLabels, versionRangeText } from '@/utils/version'
import { ACCESS, accessPermLabel, grantExpireText } from '@/utils/access'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const engagement = useEngagementStore()
const reviewStore = useReviewStore()
const accessStore = useAccessStore()
const freshnessStore = useFreshnessStore()
const handoverStore = useHandoverStore()
const retirementStore = useRetirementStore()

const doc = ref(null)
const notFound = ref(false)
const commentText = ref('')
const commentMentions = ref([])
const showVersions = ref(false)
const shareOpen = ref(false)
// 保存时自动合并了其他窗口修改的提示（由编辑器跳转携带）
const mergeNotice = ref('')
// 已提交评审的提示（由编辑器「提交评审」跳转携带）
const reviewSubmittedNotice = ref('')
// 已提交保鲜复核的提示（由编辑器「保鲜整改」跳转携带）
const freshSubmittedNotice = ref('')

const docId = computed(() => route.params.id)
// 兼容旧数据：早期文档可能没有 versions 字段
const versionList = computed(() => (doc.value?.versions?.length ? doc.value.versions : []))

// ---- 版本对比与恢复 ----
const compareVersion = ref(null) // 对比基准版本号（与当前内容对比）
const restoreVersion = ref(null) // 待恢复的版本号
const restoreNote = ref('')
const restoreBusy = ref(false)
const restoreDone = ref('')

const latestVersion = computed(() => versionList.value.length)
const currentSnap = computed(() => (doc.value ? docSnapshot(doc.value) : null))
const compareTarget = computed(() => versionList.value.find((v) => v.version === compareVersion.value) || null)
const compareFields = computed(() =>
  compareTarget.value?.snapshot && doc.value ? diffVersionFields(compareTarget.value.snapshot, currentSnap.value) : []
)
// 标准「旧 → 新」差异：红色为旧版本有而当前没有，绿色为当前有而旧版本没有
const compareLines = computed(() =>
  compareTarget.value?.snapshot && doc.value ? diffBodyLines(compareTarget.value.snapshot.body, doc.value.body) : []
)
const restoreTarget = computed(() => versionList.value.find((v) => v.version === restoreVersion.value) || null)
// 当前流转中的评审单（恢复按钮与发起资格均据此判定）
const pendingReview = computed(() => (doc.value ? reviewStore.pendingReviewOf(doc.value.id) : null))
// 知识保鲜：当前流转中的复核单（存在即代表问答引用已暂停）
const freshTicket = computed(() => (doc.value ? freshnessStore.activeTicketOf(doc.value.id) : null))
// 当前用户在该文档上的有效限时协作授权（发起恢复评审需文档级写入资格）
const restoreGrant = computed(() => (doc.value ? accessStore.grantOf(doc.value.id, auth.user?.id) : null))
// 恢复预览：fromV 之后到当前的所有版本将被回滚并标记边界
const restorePreview = computed(() => {
  if (!restoreTarget.value || !doc.value) return null
  const fromV = restoreTarget.value.version
  const rolledBack = versionList.value.filter((v) => v.version > fromV).map((v) => v.version)
  return { fromV, rolledBack }
})
// 编辑者/管理员且文档不在评审中、且对本文档有写入资格时可发起恢复评审
const canRestore = computed(() => canSubmitReview(doc.value, {
  userId: auth.user?.id || GUEST_ID,
  role: auth.user?.role,
  grant: restoreGrant.value
}, pendingReview.value))

function isIdentical(v) {
  if (!v?.snapshot || !doc.value) return false
  return diffVersionFields(v.snapshot, currentSnap.value).length === 0
}
function toggleCompare(v) {
  if (!v.snapshot) return
  compareVersion.value = compareVersion.value === v.version ? null : v.version
  restoreVersion.value = null
}
function openRestore(v) {
  restoreVersion.value = v.version
  compareVersion.value = v.version // 恢复时同步展开对比，所见即所得
  restoreNote.value = ''
}
async function submitRestore() {
  if (!restoreTarget.value || restoreBusy.value) return
  restoreBusy.value = true
  try {
    const res = await reviewStore.submitRestoreReview(doc.value.id, restoreTarget.value.version, restoreNote.value.trim(), auth.user)
    if (res.status === 'ok') {
      restoreDone.value = '已提交恢复评审：文档进入「评审中」，管理员审批通过后将恢复至 v' + restoreTarget.value.version
      restoreVersion.value = null
      restoreNote.value = ''
      await refresh()
      setTimeout(() => { restoreDone.value = '' }, 5000)
    } else if (res.status === 'duplicate') {
      alert('该文档已有流转中的评审单，请等待审批后再发起恢复。')
    } else if (res.status === 'identical') {
      alert('该版本与当前内容一致，无需恢复。')
    } else if (res.status === 'no-snapshot') {
      alert('该版本没有内容快照，无法恢复。')
    } else if (res.status === 'guest') {
      alert('访客不能发起恢复评审，请先登录。')
    } else {
      alert('你没有该文档的评审发起权限，无法提交恢复评审。')
    }
  } finally {
    restoreBusy.value = false
  }
}

async function refresh() {
  if (!docId.value) return
  await Promise.all([reviewStore.loadAll(), accessStore.loadAll(), freshnessStore.loadAll(), retirementStore.loadAll()])
  const d = await kb.getDoc(docId.value)
  if (!d) { notFound.value = true; doc.value = null; return }
  notFound.value = false
  // 受限文档仍保留引用：能否查看由 hasAccess 响应式判定——
  // 授权被撤销/到期时 store 变化会即时切到「访问申请」卡片，无需刷新
  doc.value = d
  if (hasViewAccess.value) {
    await engagement.recordView(auth.user?.id, d.id)
    await engagement.refresh(auth.user?.id)
  }
}

// 当前用户在该文档上的有效限时授权（阅读/协作）
const activeGrant = computed(() => (doc.value ? accessStore.grantOf(doc.value.id, auth.user?.id) : null))
// 是否可查看详情（随授权记录响应式变化：撤销/到期即时收回）
const hasViewAccess = computed(() => doc.value ? canViewDoc(doc.value, auth.user?.id, null, activeGrant.value) : false)
const canEdit = computed(() => canEditDoc(doc.value, { userId: auth.user?.id || GUEST_ID, role: auth.user?.role, grant: activeGrant.value, pendingReview: pendingReview.value, activeRetirement: activeRetirement.value }))
// 删除是破坏性操作：限时协作授权不授予删除权，独立于正文编辑资格判定；已退役文档不允许删除
const canDelete = computed(() => canDeleteDoc(doc.value, { userId: auth.user?.id || GUEST_ID, role: auth.user?.role, pendingReview: pendingReview.value, activeRetirement: activeRetirement.value }))
const isFav = computed(() => engagement.isFavorite(docId.value))
const comments = computed(() => (doc.value ? kb.commentsOf(doc.value.id) : []))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
// 文档锁定提示：评审中正文保持旧版，编辑入口（非管理员）不可用
const reviewLocked = computed(() => !!pendingReview.value && auth.user?.role !== 'admin')
// 拥有者视角：管理本文档的访问申请
const isOwnerOrAdmin = computed(() => doc.value && (auth.user?.role === 'admin' || doc.value.ownerId === auth.user?.id))
// 责任交接：本文档存在流转中的交接篇时提示（交接期间修改将导致批准时校验失败、该篇回退）
const activeHandover = computed(() => (doc.value ? handoverStore.activeItemOfDoc(doc.value.id) : null))
// 知识退役：本文档当前生效退役（已退役则只读，停止搜索/问答，引导至替代文档）
const activeRetirement = computed(() => (doc.value ? retirementStore.activeRetirementOfDoc(doc.value.id) : null))

async function doDelete() {
  if (!confirm('确定删除该文档？此操作不可恢复。')) return
  const res = await kb.deleteDoc(doc.value.id, auth.user)
  if (res?.status === 'forbidden') {
    alert('你没有删除该文档的权限：仅拥有者、协作成员、管理员或持有效限时协作授权的成员可删除。')
    return
  }
  if (res?.status === 'in-retirement') {
    alert('该文档存在流转中的退役申请，请先完成审批或撤销退役后再删除。')
    return
  }
  if (res?.status === 'is-replacement') {
    alert('该文档正作为某篇已退役文档的替代文档，请先撤销对应退役后再删除。')
    return
  }
  router.push('/docs')
}

async function postComment() {
  const content = commentText.value.trim()
  if (!content) return
  const cmt = await kb.addComment(doc.value.id, content, commentMentions.value, auth.user?.id)
  if (cmt?.status === 'forbidden') {
    alert('访客不能发表评论，请先登录。')
    return
  }
  commentText.value = ''
  commentMentions.value = []
}

function onMention(id) { if (!commentMentions.value.includes(id)) commentMentions.value.push(id) }

function renderMention(content) {
  return content.replace(/@([\u4e00-\u9fa5\w]+)/g, ($0, $1) => {
    const u = auth.users.find((x) => x.name === $1)
    return `<a class="at" href="#/docs/${route.params.id}">${$0}</a>`
  })
}

onMounted(() => {
  mergeNotice.value = route.query.merged || ''
  reviewSubmittedNotice.value = route.query.reviewSubmitted || ''
  freshSubmittedNotice.value = route.query.freshSubmitted || ''
  refresh()
})
watch(docId, () => { if (route.name === 'docDetail') { refresh(); showVersions.value = false } })
</script>

<template>
  <div class="detail">
    <div v-if="notFound" class="empty"><div class="ico">❔</div>文档不存在或已被删除</div>

    <!-- 受限文档：可申请限时阅读/协作权限，由拥有者审批并生成授权记录；撤销/到期即时回到此卡片 -->
    <AccessApplyCard v-else-if="doc && !hasViewAccess" :doc="doc" />

    <template v-else-if="doc">
      <div v-if="mergeNotice" class="card merge-note">
        <span>ℹ️ 保存时已自动合并其他窗口对「{{ mergeNotice }}」的修改，双方内容均已保留</span>
        <button class="btn sm ghost" @click="mergeNotice = ''">知道了</button>
      </div>
      <div v-if="reviewSubmittedNotice" class="card review-submitted-note">
        <span>✅ 已提交评审：文档进入「评审中」，成员可发表意见，管理员审批通过后修改才会发布。</span>
        <button class="btn sm ghost" @click="reviewSubmittedNotice = ''">知道了</button>
      </div>
      <div v-if="freshSubmittedNotice" class="card fresh-submitted-note">
        <span>🧊 已提交保鲜复核：管理员复核通过后修订生效、问答引用恢复并重新计算复核周期；驳回则继续整改。</span>
        <button class="btn sm ghost" @click="freshSubmittedNotice = ''">知道了</button>
      </div>
      <div v-if="reviewLocked" class="card review-lock">
        <span>⏳ 该文档正在评审中（{{ userById[pendingReview.submittedBy]?.name }} 发起）：当前展示的是评审前版本，正文已锁定，审批通过后更新。</span>
      </div>
      <div v-if="freshTicket" class="card fresh-banner">
        <span>🧊 知识保鲜：本文档已超过复核周期（第 {{ freshTicket.round }} 轮，{{ freshTicket.status === 'submitted' ? '复核送审中' : freshTicket.status === 'rejected' ? '已驳回待整改' : '待整改' }}），问答引用已暂停；复核通过后自动恢复引用并重算周期。</span>
      </div>
      <div v-if="activeGrant" class="card grant-banner">
        <span>🔑 你正以「{{ accessPermLabel(activeGrant.grant.permission) }}」授权访问本文档，{{ grantExpireText(activeGrant) }}；到期或被撤销后访问权限将自动收回。</span>
      </div>
      <div v-if="activeHandover" class="card handover-banner">
        <span>🤝 本文档正在责任交接中（{{ userById[activeHandover.handover.fromUserId]?.name }} → {{ userById[activeHandover.item.toUserId]?.name }}）：{{ activeHandover.item.status === 'pending_confirm' ? '等待接任者确认' : '等待管理员批准' }}，期间请避免修改，否则批准时将因并发变更校验失败而回退该篇。</span>
      </div>
      <div v-if="activeRetirement" class="card retire-banner">
        <span>🗄 本文档已退役（{{ userById[activeRetirement.initiatedBy]?.name || activeRetirement.approvedBy }} 发起，{{ userById[activeRetirement.approvedBy] }} 批准）：已停止搜索与问答引用，正文只读保留。</span>
        <a v-if="kb.docs.find((d) => d.id === activeRetirement.replacementDocId)" class="rt-go" @click="router.push('/docs/' + activeRetirement.replacementDocId)">前往替代文档《{{ activeRetirement.replacementTitle }}》→</a>
      </div>
      <div class="page-head card">
        <div class="title-row">
          <h1 class="title">{{ doc.title }}</h1>
          <div class="actions">
            <button class="btn" :class="{ on: isFav }" @click="engagement.toggleFavorite(auth.user.id, doc.id)">{{ isFav ? '★ 已收藏' : '☆ 收藏' }}</button>
            <button class="btn" @click="shareOpen = true">🔗 分享</button>
            <button v-if="canEdit" class="btn" @click="router.push('/docs/' + doc.id + '/edit')">✎ 编辑</button>
            <button v-else-if="reviewLocked" class="btn" disabled title="评审中，请等待管理员审批">🔒 评审中</button>
            <button v-if="canDelete" class="btn danger" @click="doDelete">🗑 删除</button>
          </div>
        </div>
        <div class="meta-row">
          <DocPill :doc="doc" class="pills" />
          <span class="who">作者：{{ userById[doc.ownerId]?.name || doc.ownerId }}</span>
          <span class="who">更新：{{ formatFull(doc.updatedAt) }}</span>
          <button class="btn sm ghost" @click="showVersions = !showVersions">{{ showVersions ? '隐藏' : '查看' }}版本记录 ({{ versionList.length }})</button>
        </div>
      </div>

      <div v-if="showVersions" class="card versions">
        <div class="ver-head">
          <span class="ver-title">版本记录（{{ versionList.length }}）</span>
          <span class="ver-hint">点击「对比」查看与当前内容的差异；编辑者可对历史版本发起恢复评审</span>
        </div>
        <div v-if="restoreDone" class="restore-done">✅ {{ restoreDone }}</div>
        <div v-for="v in [...versionList].reverse()" :key="v.version" class="ver" :class="{ superseded: v.supersededBy }">
          <span class="vnum">v{{ v.version }}</span>
          <div class="vmain">
            <span class="vnote">{{ v.note || '编辑' }}</span>
            <span v-if="versionReviewBadge(v)" class="vbadge" :class="'vb-' + versionReviewBadge(v).cls">{{ versionReviewBadge(v).text }}</span>
            <span v-if="freshVersionBadge(v)" class="vbadge vb-fresh">{{ freshVersionBadge(v).text }}</span>
            <span v-for="b in versionRestoreBadges(v)" :key="b.text" class="vbadge" :class="'vb-' + b.cls">{{ b.text }}</span>
            <span v-if="!v.snapshot" class="vnosnap" title="旧版本记录未保存内容快照，无法对比或恢复">无快照</span>
          </div>
          <span class="vwho">{{ userById[v.savedBy]?.name || v.savedBy }}</span>
          <span class="vtime">{{ formatFull(v.savedAt) }}</span>
          <div class="vacts">
            <button v-if="v.snapshot" class="btn sm ghost" @click="toggleCompare(v)">{{ compareVersion === v.version ? '收起' : '对比' }}</button>
            <button v-if="canRestore && v.snapshot && !isIdentical(v)" class="btn sm" @click="openRestore(v)">恢复</button>
            <span v-else-if="v.snapshot && isIdentical(v)" class="vcur">当前内容</span>
          </div>
        </div>

        <!-- 对比面板：选中版本（旧）与当前内容（新）的字段与正文差异 -->
        <div v-if="compareTarget?.snapshot" class="diff-panel">
          <div class="diff-head">
            v{{ compareTarget.version }}（{{ formatFull(compareTarget.savedAt) }}）与当前内容（v{{ latestVersion }}）的差异
          </div>
          <div class="diff-fields">
            <template v-if="compareFields.length">字段差异：<b>{{ fieldLabels(compareFields).join('、') }}</b></template>
            <template v-else>两个版本内容一致</template>
          </div>
          <div v-if="compareFields.includes('body')" class="diff-body">
            <div class="diff-legend">红色：v{{ compareTarget.version }} 有而当前没有；绿色：当前有而 v{{ compareTarget.version }} 没有</div>
            <div v-for="(line, i) in compareLines" :key="i" class="dl" :class="'dl-' + line.type">
              <span class="dl-sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }}</span>{{ line.text }}
            </div>
          </div>

          <!-- 恢复确认：提交恢复评审，通过后生成新版本并重标旧记录边界 -->
          <div v-if="restoreTarget && restoreTarget.version === compareTarget.version" class="restore-form">
            <div class="rf-title">↩ 恢复至 v{{ restoreTarget.version }}</div>
            <div class="rf-desc" v-if="restorePreview">
              审批通过后将生成新版本 v{{ latestVersion + 1 }}（内容为 v{{ restoreTarget.version }} 的快照）；
              {{ versionRangeText(restorePreview.rolledBack) }} 共 {{ restorePreview.rolledBack.length }} 个版本将被标记为「被恢复覆盖」，
              历史记录保留不删除，问答引用同步指向恢复后的内容。
            </div>
            <textarea v-model="restoreNote" rows="2" placeholder="恢复说明（可选，将作为评审意见留痕）"></textarea>
            <div class="rf-acts">
              <button class="btn sm primary" :disabled="restoreBusy" @click="submitRestore">{{ restoreBusy ? '提交中…' : '提交恢复评审' }}</button>
              <button class="btn sm ghost" @click="restoreVersion = null">取消</button>
            </div>
          </div>
        </div>
      </div>

      <article class="render card" v-html="doc.body"></article>

      <div class="meta card">
        <div class="row"><span class="k">协作成员</span><span class="v">
          <span v-for="ed in doc.editors" :key="ed" class="collab">
            <span class="ava" :style="{ background: avatarColor(ed) }">{{ ed.slice(0, 1) }}</span>{{ userById[ed]?.name || ed }}
          </span>
        </span></div>
        <div class="row"><span class="k">最近编辑</span><span class="v">{{ formatDate(doc.updatedAt) }} · {{ userById[doc.ownerId]?.name }}</span></div>
        <div v-if="doc.ownerHistory?.length" class="row"><span class="k">历任负责人</span><span class="v">
          <span v-for="(hh, i) in doc.ownerHistory" :key="i" class="owner-his">
            {{ userById[hh.ownerId]?.name || hh.ownerId }}<em>（{{ formatDate(hh.until) }} 交接卸任）</em>
          </span>
          <span class="owner-cur">现任：{{ userById[doc.ownerId]?.name || doc.ownerId }}</span>
        </span></div>
      </div>

      <ReviewPanel :doc="doc" />

      <FreshnessPanel :doc="doc" />

      <RetirementPanel :doc="doc" />

      <!-- 拥有者/管理员：审批访问申请、管理限时授权（撤销到期同步收回四处权限） -->
      <AccessPanel v-if="isOwnerOrAdmin" :doc="doc" />

      <div class="comments card">
        <div class="c-title">评论与讨论（{{ comments.length }}）</div>
        <div v-if="!comments.length" class="c-empty">暂无评论，成为第一个讨论者吧</div>
        <div v-for="c in comments" :key="c.id" class="comment">
          <span class="ava big" :style="{ background: avatarColor(c.authorId) }">{{ userById[c.authorId]?.avatar || '?' }}</span>
          <div class="c-body">
            <div class="c-meta"><b>{{ userById[c.authorId]?.name || c.authorId }}</b><span class="c-time">{{ formatDate(c.createdAt) }}</span><span v-if="c.reviewId" class="c-review-tag">评审意见</span></div>
            <div class="c-content" v-html="renderMention(c.content)"></div>
            <div v-if="c.mentionIds.length" class="c-mention">提及：<span v-for="m in c.mentionIds" :key="m" class="pill">{{ userById[m]?.name }}</span></div>
          </div>
        </div>
        <div class="c-input">
          <MemberSelect v-model="commentText" @mention="onMention" />
          <button class="btn primary" :disabled="!commentText.trim()" @click="postComment">发表评论</button>
        </div>
      </div>

      <ShareDialog :open="shareOpen" :doc="doc" @close="shareOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.detail { max-width: 860px; margin: 0 auto; }
.merge-note { padding: 10px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: var(--primary); border-color: var(--primary); background: var(--primary-weak); }
.page-head { padding: 20px 24px; }
.title-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.title { margin: 0; font-size: 24px; }
.actions { display: flex; gap: 8px; }
.btn.on { background: var(--warn); border-color: var(--warn); color: #fff; }
.meta-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; color: var(--text-3); font-size: 12px; }
.pills { margin-right: 8px; }
.who { color: var(--text-3); }
.versions { margin-top: 14px; padding: 12px 20px 16px; }
.ver-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding: 4px 0 10px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.ver-title { font-weight: 700; font-size: 14px; }
.ver-hint { color: var(--text-3); font-size: 12px; }
.restore-done { margin: 8px 0; padding: 8px 14px; border-radius: 8px; font-size: 13px; color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0; }
.ver { display: flex; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.ver:last-of-type { border-bottom: none; }
.ver.superseded { opacity: 0.62; }
.vnum { font-weight: 700; color: var(--primary); min-width: 36px; }
.ver.superseded .vnum { color: var(--text-3); }
.vmain { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vnote { color: var(--text); }
.vwho { color: var(--text-2); white-space: nowrap; }
.vtime { color: var(--text-3); white-space: nowrap; }
.vacts { display: flex; gap: 6px; align-items: center; }
.vcur { font-size: 11px; color: var(--text-3); padding: 1px 8px; border-radius: 999px; background: var(--panel-2); }
.vnosnap { font-size: 11px; color: var(--text-3); padding: 1px 8px; border-radius: 999px; border: 1px dashed var(--border); }
.vb-restore { background: #e0e7ff; color: #4338ca; }
.vb-superseded { background: var(--panel-2); color: var(--text-3); }

/* 对比面板 */
.diff-panel { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; background: var(--panel-2); }
.diff-head { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.diff-fields { font-size: 13px; color: var(--text-2); margin-bottom: 8px; }
.diff-fields b { color: var(--primary); }
.diff-body { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel); }
.diff-legend { padding: 6px 12px; font-size: 11px; color: var(--text-3); border-bottom: 1px solid var(--border); background: var(--panel-2); }
.dl { display: flex; gap: 8px; padding: 4px 12px; font-size: 12.5px; line-height: 1.6; border-bottom: 1px solid #f1f5f9; }
.dl:last-child { border-bottom: none; }
.dl-sign { width: 14px; text-align: center; font-weight: 700; flex-shrink: 0; }
.dl-same { color: var(--text-2); }
.dl-add { background: #f0fdf4; color: #15803d; }
.dl-add .dl-sign { color: #16a34a; }
.dl-del { background: #fef2f2; color: #b91c1c; }
.dl-del .dl-sign { color: #dc2626; }

/* 恢复确认 */
.restore-form { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.rf-title { font-weight: 700; font-size: 14px; color: #4338ca; margin-bottom: 6px; }
.rf-desc { font-size: 12.5px; color: var(--text-2); margin-bottom: 10px; line-height: 1.6; }
.restore-form textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
.restore-form textarea:focus { border-color: var(--primary); }
.rf-acts { display: flex; gap: 8px; margin-top: 8px; }

.render { padding: 28px 32px; margin-top: 14px; line-height: 1.8; }
.render :deep(h1) { font-size: 26px; margin: 14px 0 8px; }
.render :deep(h2) { font-size: 21px; margin: 12px 0 8px; }
.render :deep(h3) { font-size: 17px; }
.render :deep(p) { margin: 8px 0; }
.render :deep(pre) { background: #1f2733; color: #dff2ff; padding: 12px 14px; border-radius: 8px; overflow: auto; }
.render :deep(code) { font-family: Menlo, Consolas, monospace; font-size: 13px; }
.render :deep(blockquote) { border-left: 3px solid var(--primary); margin: 8px 0; padding: 4px 12px; color: var(--text-2); background: var(--primary-weak); }
.render :deep(img) { max-width: 100%; border-radius: 6px; }

.meta { margin-top: 14px; padding: 16px 24px; }
.meta .row { display: flex; gap: 16px; padding: 6px 0; }
.meta .k { color: var(--text-3); width: 80px; }
.collab { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; }
.ava { width: 24px; height: 24px; border-radius: 50%; color: #fff; font-size: 11px; display: inline-grid; place-items: center; }
.ava.big { width: 34px; height: 34px; }

.comments { margin-top: 14px; padding: 20px 24px; }
.c-title { font-weight: 600; margin-bottom: 12px; }
.c-empty { color: var(--text-3); font-size: 13px; padding: 12px 0; }
.comment { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--panel-2); }
.c-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.c-time { color: var(--text-3); font-size: 12px; }
.c-content { color: var(--text); }
.c-mention { margin-top: 6px; display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-3); }
.c-input { display: flex; gap: 10px; align-items: flex-end; margin-top: 14px; }
.c-input > div { flex: 1; }
.versions a.at, .c-content :deep(a.at) { color: var(--primary); font-weight: 500; }
.review-lock { padding: 10px 18px; margin-bottom: 14px; font-size: 13px; color: #b45309; background: #fffbeb; border-color: #f59e0b; }
.fresh-banner { padding: 10px 18px; margin-bottom: 14px; font-size: 13px; color: #155e75; background: #ecfeff; border-color: #22d3ee; }
.grant-banner { padding: 10px 18px; margin-bottom: 14px; font-size: 13px; color: #6d28d9; background: #faf5ff; border-color: #a855f7; }
.handover-banner { padding: 10px 18px; margin-bottom: 14px; font-size: 13px; color: #9a3412; background: #fff7ed; border-color: #fb923c; }
.retire-banner { padding: 10px 18px; margin-bottom: 14px; font-size: 13px; color: #475569; background: #f8fafc; border-color: #cbd5e1; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.retire-banner .rt-go { color: var(--primary); font-weight: 600; cursor: pointer; white-space: nowrap; }
.owner-his { margin-right: 14px; color: var(--text-2); }
.owner-his em { font-style: normal; color: var(--text-3); font-size: 12px; }
.owner-cur { color: var(--text); font-weight: 600; }
.review-submitted-note { padding: 10px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: #15803d; background: #f0fdf4; border-color: #16a34a; }
.fresh-submitted-note { padding: 10px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: #155e75; background: #ecfeff; border-color: #22d3ee; }
.vbadge { font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.vb-ok { background: #dcfce7; color: #15803d; }
.vb-no { background: #fee2e2; color: #b91c1c; }
.vb-wait { background: #fef3c7; color: #b45309; }
.vb-fresh { background: #cffafe; color: #0e7490; }
.c-review-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--primary-weak); color: var(--primary); }
</style>