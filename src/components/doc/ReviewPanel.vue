<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useReviewStore } from '@/stores/review'
import { useAuthStore } from '@/stores/auth'
import { useAccessStore } from '@/stores/access'
import MemberSelect from '@/components/common/MemberSelect.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  REVIEW, reviewStatusLabel, canWithdrawReview, canReviewDecision,
  canCommentReview, canSubmitReview, timelineActionLabel, isRestoreReview,
  isFreshReview, isFreshNoChangeReview
} from '@/utils/review'
import { GUEST_ID } from '@/utils/permission'
import { diffBodyLines, versionRangeText } from '@/utils/version'

const props = defineProps({
  doc: { type: Object, required: true }
})

const router = useRouter()
const reviewStore = useReviewStore()
const auth = useAuthStore()
const accessStore = useAccessStore()

const commentText = ref('')
const commentMentions = ref([])
const noteText = ref('')
const decisionOpen = ref(false)
const busy = ref(false)
const justDecided = ref('')
// 恢复评审的正文差异展开状态
const restoreDiffOpen = ref(false)

// 展开的历史评审单 id（最新一条默认展开）
const expanded = ref({})

const reviews = computed(() => reviewStore.reviewsOfDoc(props.doc.id))
const latest = computed(() => reviews.value[0] || null)
const pending = computed(() => reviewStore.pendingReviewOf(props.doc.id))
const history = computed(() => reviews.value.slice(pending.value ? 0 : 1, reviews.value.length))
const shownFirst = computed(() => pending.value || latest.value)

const pendingComments = computed(() =>
  pending.value ? reviewStore.commentsOfReview(pending.value.id) : []
)
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

// 恢复评审：恢复来源与回滚预览（含评审期间的并发修改）
const restoreFrom = computed(() => (isRestoreReview(pending.value) ? pending.value.restoreFrom : null))
const rollbackPreview = computed(() => {
  if (!restoreFrom.value || !props.doc?.versions?.length) return null
  const fromV = restoreFrom.value.version
  const currentV = props.doc.versions.length
  const rolledBack = []
  for (let v = fromV + 1; v <= currentV; v++) rolledBack.push(v)
  const concurrent = rolledBack.filter((v) => v > pending.value.baseVersion)
  return { fromV, rolledBack, concurrent }
})
// 恢复后的内容变化（当前 → 恢复快照）：绿=恢复的内容，红=将移除的内容
const restoreDiffLines = computed(() =>
  restoreFrom.value && props.doc ? diffBodyLines(props.doc.body, pending.value.snapshot?.body || '') : []
)

// 待审批快照与当前文档的字段差异（提示审批通过后将发生的变化）
const diffs = computed(() => {
  if (!pending.value) return []
  const s = pending.value.snapshot || {}
  const d = props.doc
  const out = []
  if ((s.title || '') !== (d.title || '')) out.push('标题')
  if ((s.body || '') !== (d.body || '')) out.push('正文')
  if ((s.categoryId || '') !== (d.categoryId || '')) out.push('分类')
  if (JSON.stringify(s.tagIds || []) !== JSON.stringify(d.tagIds || [])) out.push('标签')
  if ((s.visibility || '') !== (d.visibility || '')) out.push('可见性')
  return out
})

function isExpanded(id) {
  if (id === shownFirst.value?.id) return true
  return !!expanded.value[id]
}
function toggle(id) { expanded.value = { ...expanded.value, [id]: !expanded.value[id] } }

async function postComment() {
  const content = commentText.value.trim()
  if (!content || !pending.value || busy.value) return
  busy.value = true
  try {
    const cmt = await reviewStore.addReviewComment(pending.value.id, content, commentMentions.value, auth.user)
    if (cmt?.status === 'guest') alert('访客不能发表评审意见，请先登录。')
    else { commentText.value = ''; commentMentions.value = [] }
  } finally {
    busy.value = false
  }
}
function onMention(id) { if (!commentMentions.value.includes(id)) commentMentions.value.push(id) }

async function decide(decision) {
  if (!pending.value || busy.value) return
  busy.value = true
  try {
    const res = await reviewStore.decideReview(pending.value.id, decision, noteText.value.trim(), auth.user)
    if (res.status === 'ok') {
      justDecided.value = decision === 'approve' ? '已通过，待审内容已发布' : '已驳回，文档保持原内容'
      decisionOpen.value = false
      noteText.value = ''
      setTimeout(() => { justDecided.value = '' }, 3000)
    } else if (res.status === 'guest' || res.status === 'denied') {
      alert('只有管理员可以审批评审单。')
    } else {
      alert('操作失败：评审单状态已变化，请刷新后重试')
    }
  } finally {
    busy.value = false
  }
}

async function withdraw() {
  if (!pending.value) return
  if (!confirm('确定撤回本次评审？待审内容不会生效。')) return
  busy.value = true
  try {
    const res = await reviewStore.withdrawReview(pending.value.id, auth.user)
    if (res.status === 'guest') alert('访客不能撤回评审，请先登录。')
    else if (res.status !== 'ok') alert('撤回失败：评审单状态已变化，请刷新后重试。')
  } finally {
    busy.value = false
  }
}

const canDecide = computed(() => canReviewDecision(auth.user?.role, pending.value, auth.user?.id))
const canWithdraw = computed(() => canWithdrawReview(pending.value, auth.user?.id))
const canComment = computed(() => canCommentReview(auth.user?.role, pending.value, auth.user?.id))
// 当前用户在本文档上的有效限时协作授权（仅协作者授权，不构成发起评审资格）
const activeGrant = computed(() => accessStore.grantOf(props.doc.id, auth.user?.id))
// 无流转评审单时的「发起评审」入口：同样要过文档级写入资格（访客/只读/无关系编辑者不可见）
const canSubmit = computed(() => canSubmitReview(props.doc, {
  userId: auth.user?.id || GUEST_ID,
  role: auth.user?.role,
  grant: activeGrant.value
}, pending.value))

function statusCls(r) {
  return { [REVIEW.PENDING]: 'st-pending', [REVIEW.APPROVED]: 'st-ok', [REVIEW.REJECTED]: 'st-no', [REVIEW.WITHDRAWN]: 'st-off' }[r.status]
}

watch(pending, (p) => { if (!p) decisionOpen.value = false })
</script>

<template>
  <div class="review card">
    <div class="rv-head">
      <span class="rv-title">🧾 知识评审</span>
      <span v-if="pending" class="st st-pending">⏳ 待管理员审批</span>
      <span v-else-if="doc.lastReview" class="st" :class="statusCls({ status: doc.lastReview.status })">
        最近审批：{{ reviewStatusLabel(doc.lastReview.status) }}
      </span>
      <button v-if="canSubmit" class="btn sm primary" @click="router.push('/docs/' + doc.id + '/edit?submitReview=1')">
        发起评审
      </button>
      <span v-else-if="!pending" class="submit-tip">仅拥有者、协作成员或管理员可发起评审</span>
    </div>

    <div v-if="justDecided" class="toast-line">✅ {{ justDecided }}</div>

    <!-- 流转中的评审单 -->
    <div v-if="pending" class="rv-body">
      <div class="rv-meta">
        <span class="who"><span class="ava" :style="{ background: avatarColor(pending.submittedBy) }">{{ userById[pending.submittedBy]?.avatar || '?' }}</span>
          {{ userById[pending.submittedBy]?.name || pending.submittedBy }} {{ restoreFrom ? '发起恢复评审' : '发起评审' }}
        </span>
        <span class="tm">{{ formatFull(pending.submittedAt) }}</span>
        <span class="ver">基于 v{{ pending.baseVersion }}</span>
        <span v-if="restoreFrom" class="restore-tag">↩ 恢复至 v{{ restoreFrom.version }}</span>
        <span v-if="isFreshReview(pending)" class="fresh-tag">
          🧊 知识保鲜复核 · 第 {{ pending.freshRound }} 轮{{ isFreshNoChangeReview(pending) ? '（确认内容有效）' : '（修订）' }}
        </span>
      </div>

      <!-- 恢复评审：恢复目标、回滚边界预览与正文差异 -->
      <div v-if="restoreFrom" class="restore-info">
        <div class="ri-line">
          恢复目标：v{{ restoreFrom.version }}（{{ userById[restoreFrom.savedBy]?.name || restoreFrom.savedBy }} 于 {{ formatFull(restoreFrom.savedAt) }} 保存的版本）
        </div>
        <div v-if="rollbackPreview && rollbackPreview.rolledBack.length" class="ri-line">
          通过后将回滚 {{ versionRangeText(rollbackPreview.rolledBack) }}（共 {{ rollbackPreview.rolledBack.length }} 个版本），这些版本保留历史并标记为「被恢复覆盖」。
          <span v-if="rollbackPreview.concurrent.length" class="concurrent-warn">
            ⚠️ 其中 {{ versionRangeText(rollbackPreview.concurrent) }} 是评审提交后的并发修改，恢复将一并回滚。
          </span>
        </div>
        <button class="btn sm ghost" @click="restoreDiffOpen = !restoreDiffOpen">{{ restoreDiffOpen ? '收起正文差异' : '查看正文差异' }}</button>
        <div v-if="restoreDiffOpen" class="restore-diff">
          <div class="rd-legend">恢复后的内容变化（当前 → v{{ restoreFrom.version }}）：绿色为恢复的内容，红色为将移除的内容</div>
          <div v-for="(line, i) in restoreDiffLines" :key="i" class="dl" :class="'dl-' + line.type">
            <span class="dl-sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }}</span>{{ line.text }}
          </div>
        </div>
      </div>

      <div v-if="diffs.length" class="diff-line">
        审批通过后将更新：<b v-for="(f, i) in diffs" :key="f">{{ i ? '、' : '' }}{{ f }}</b>
      </div>

      <!-- 评审意见（与文档评论区联动，此处是评审视角的聚合） -->
      <div class="rv-c-title">评审意见（{{ pendingComments.length }}）</div>
      <div v-if="!pendingComments.length" class="rv-c-empty">暂无评审意见，成员可在此发表看法</div>
      <div v-for="c in pendingComments" :key="c.id" class="rv-comment">
        <span class="ava" :style="{ background: avatarColor(c.authorId) }">{{ userById[c.authorId]?.avatar || '?' }}</span>
        <div class="rv-c-body">
          <div class="rv-c-meta"><b>{{ userById[c.authorId]?.name || c.authorId }}</b><span>{{ formatDate(c.createdAt) }}</span></div>
          <div>{{ c.content }}</div>
        </div>
      </div>

      <div v-if="canComment" class="rv-input">
        <MemberSelect v-model="commentText" @mention="onMention" />
        <button class="btn primary" :disabled="!commentText.trim() || busy" @click="postComment">发表意见</button>
      </div>
      <div v-else-if="pending" class="rv-login-tip">登录成员均可评论</div>

      <!-- 管理员审批 -->
      <div v-if="canDecide" class="decision">
        <button v-if="!decisionOpen" class="btn sm" @click="decisionOpen = true">审批处理</button>
        <template v-else>
          <textarea v-model="noteText" rows="2" placeholder="审批意见（可选，将留痕并同步到评论区时间线）"></textarea>
          <div class="decision-actions">
            <button class="btn sm" :disabled="busy" @click="decide('reject')">✕ 驳回（内容不变）</button>
            <button class="btn sm ok-solid" :disabled="busy" @click="decide('approve')">✓ 通过并发布</button>
            <button class="btn sm ghost" @click="decisionOpen = false">取消</button>
          </div>
        </template>
      </div>

      <div v-if="canWithdraw" class="withdraw-row">
        <button class="btn sm ghost" :disabled="busy" @click="withdraw">撤回评审</button>
      </div>
    </div>

    <!-- 无流转中的评审单：展示最近结论 -->
    <div v-else-if="doc.lastReview" class="last-decision">
      <p>
        <b>{{ userById[doc.lastReview.by]?.name || doc.lastReview.by }}</b>
        于 {{ formatDate(doc.lastReview.at) }} {{ reviewStatusLabel(doc.lastReview.status) }}
      </p>
      <p v-if="doc.lastReview.note" class="dnote">“{{ doc.lastReview.note }}”</p>
    </div>

    <!-- 历史评审单留痕 -->
    <div v-if="history.length || (shownFirst && !pending)" class="rv-history">
      <div class="rv-h-title">评审记录（{{ reviews.length }}）</div>
      <div v-if="shownFirst && !pending" class="h-item">
        <div class="h-head" @click="toggle(shownFirst.id)">
          <span class="st sm" :class="statusCls(shownFirst)">{{ reviewStatusLabel(shownFirst.status) }}</span>
          <span v-if="isRestoreReview(shownFirst)" class="restore-tag sm">↩ 恢复至 v{{ shownFirst.restoreFrom.version }}</span>
          <span v-if="isFreshReview(shownFirst)" class="fresh-tag sm">🧊 保鲜第 {{ shownFirst.freshRound }} 轮</span>
          <span class="h-who">{{ userById[shownFirst.submittedBy]?.name }}</span>
          <span class="h-tm">{{ formatDate(shownFirst.submittedAt) }}</span>
          <span class="h-arrow">{{ isExpanded(shownFirst.id) ? '收起 ▲' : '展开 ▼' }}</span>
        </div>
        <div v-if="isExpanded(shownFirst.id)" class="h-timeline">
          <div v-for="(t, i) in shownFirst.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ timelineActionLabel(t.action) }}</span>
            <span class="tl-who">{{ userById[t.by]?.name || t.by }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </div>
      </div>
      <div v-for="r in history" :key="r.id" class="h-item">
        <div class="h-head" @click="toggle(r.id)">
          <span class="st sm" :class="statusCls(r)">{{ reviewStatusLabel(r.status) }}</span>
          <span v-if="isRestoreReview(r)" class="restore-tag sm">↩ 恢复至 v{{ r.restoreFrom.version }}</span>
          <span v-if="isFreshReview(r)" class="fresh-tag sm">🧊 保鲜第 {{ r.freshRound }} 轮</span>
          <span class="h-who">{{ userById[r.submittedBy]?.name }}</span>
          <span class="h-tm">{{ formatDate(r.submittedAt) }}</span>
          <span class="h-arrow">{{ isExpanded(r.id) ? '收起 ▲' : '展开 ▼' }}</span>
        </div>
        <div v-if="isExpanded(r.id)" class="h-timeline">
          <div v-for="(t, i) in r.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ timelineActionLabel(t.action) }}</span>
            <span class="tl-who">{{ userById[t.by]?.name || t.by }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.review { margin-top: 14px; padding: 18px 24px; }
.rv-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.rv-title { font-weight: 700; font-size: 15px; }
.rv-head .btn { margin-left: auto; }
.submit-tip { margin-left: auto; font-size: 12px; color: var(--text-3); }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st.sm { font-size: 11px; padding: 1px 8px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.toast-line { color: #15803d; font-size: 13px; margin-bottom: 10px; }
.rv-meta { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-2); flex-wrap: wrap; }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 24px; height: 24px; border-radius: 50%; color: #fff; font-size: 11px; display: inline-grid; place-items: center; }
.tm, .ver { color: var(--text-3); font-size: 12px; }
.restore-tag { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: #e0e7ff; color: #4338ca; font-weight: 600; }
.restore-tag.sm { font-size: 10px; padding: 0 7px; }
.fresh-tag { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: #cffafe; color: #0e7490; font-weight: 600; }
.fresh-tag.sm { font-size: 10px; padding: 0 7px; }
.restore-info { margin-top: 10px; padding: 10px 14px; border-radius: 8px; background: #eef2ff; border: 1px solid #c7d2fe; }
.ri-line { font-size: 12.5px; color: #3730a3; margin-bottom: 6px; line-height: 1.6; }
.concurrent-warn { color: #b45309; font-weight: 600; }
.restore-info .btn { margin-top: 2px; }
.restore-diff { margin-top: 10px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel); }
.rd-legend { padding: 6px 12px; font-size: 11px; color: var(--text-3); border-bottom: 1px solid var(--border); background: var(--panel-2); }
.dl { display: flex; gap: 8px; padding: 4px 12px; font-size: 12.5px; line-height: 1.6; border-bottom: 1px solid #f1f5f9; }
.dl:last-child { border-bottom: none; }
.dl-sign { width: 14px; text-align: center; font-weight: 700; flex-shrink: 0; }
.dl-same { color: var(--text-2); }
.dl-add { background: #f0fdf4; color: #15803d; }
.dl-add .dl-sign { color: #16a34a; }
.dl-del { background: #fef2f2; color: #b91c1c; }
.dl-del .dl-sign { color: #dc2626; }
.diff-line { margin-top: 10px; font-size: 13px; color: var(--text-2); background: var(--primary-weak); border-radius: 8px; padding: 8px 12px; }
.diff-line b { color: var(--primary); margin-right: 2px; }
.rv-c-title { font-weight: 600; font-size: 13px; margin: 14px 0 8px; }
.rv-c-empty { color: var(--text-3); font-size: 13px; padding: 6px 0; }
.rv-comment { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--panel-2); }
.rv-c-meta { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-3); margin-bottom: 2px; }
.rv-c-body { font-size: 13px; }
.rv-input { display: flex; gap: 10px; align-items: flex-end; margin-top: 12px; }
.rv-input > div { flex: 1; }
.rv-login-tip { margin-top: 10px; color: var(--text-3); font-size: 12px; }
.decision { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--border); }
.decision textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; margin-bottom: 8px; }
.decision textarea:focus { border-color: var(--primary); }
.decision-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.withdraw-row { margin-top: 10px; }
.last-decision { font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 10px 14px; }
.last-decision p { margin: 2px 0; }
.dnote { color: var(--text-3); }
.rv-history { margin-top: 14px; border-top: 1px solid var(--panel-2); padding-top: 10px; }
.rv-h-title { font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
.h-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; overflow: hidden; }
.h-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; font-size: 13px; background: var(--panel-2); }
.h-who { font-weight: 600; }
.h-tm { color: var(--text-3); font-size: 12px; }
.h-arrow { margin-left: auto; color: var(--text-3); font-size: 12px; }
.h-timeline { padding: 8px 14px; }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 5px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 76px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
