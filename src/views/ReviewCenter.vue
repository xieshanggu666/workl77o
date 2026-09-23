<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import { REVIEW, reviewStatusLabel, canReviewDecision, timelineActionLabel, isRestoreReview, isFreshReview, isFreshNoChangeReview } from '@/utils/review'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()

const tab = ref('pending') // pending | mine | all
const noteMap = ref({})
const busyId = ref('')

const isAdmin = computed(() => auth.user?.role === 'admin')

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

const sorted = computed(() =>
  [...reviewStore.reviews].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
)

const list = computed(() => {
  if (tab.value === 'pending') return sorted.value.filter((r) => r.status === REVIEW.PENDING)
  if (tab.value === 'mine') return sorted.value.filter((r) => r.submittedBy === auth.user?.id)
  return sorted.value
})

const counts = computed(() => ({
  pending: reviewStore.reviews.filter((r) => r.status === REVIEW.PENDING).length,
  mine: reviewStore.reviews.filter((r) => r.submittedBy === auth.user?.id).length,
  all: reviewStore.reviews.length
}))

function statusCls(status) {
  return { pending: 'st-pending', approved: 'st-ok', rejected: 'st-no', withdrawn: 'st-off' }[status]
}

function commentCount(r) {
  return kb.comments.filter((c) => c.reviewId === r.id).length
}

async function decide(r, decision) {
  if (busyId.value) return
  busyId.value = r.id
  try {
    const res = await reviewStore.decideReview(r.id, decision, (noteMap.value[r.id] || '').trim(), auth.user)
    if (res.status === 'ok') noteMap.value[r.id] = ''
    else if (res.status === 'guest' || res.status === 'denied') alert('只有管理员可以审批评审单。')
    else alert('操作失败：评审单状态已变化')
  } finally {
    busyId.value = ''
  }
}

onMounted(async () => {
  await reviewStore.loadAll()
})
</script>

<template>
  <div class="rc-page">
    <header class="head">
      <h2>🧾 评审中心</h2>
      <p class="sub">编辑者发起评审 → 成员发表意见 → 管理员审批留痕；通过后内容与可见性自动回写文档。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'pending' }" @click="tab = 'pending'">待审批 <em>{{ counts.pending }}</em></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我发起的 <em>{{ counts.mine }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部记录 <em>{{ counts.all }}</em></button>
      </div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">📭</div>
      {{ tab === 'pending' ? '暂无待审批的评审单' : tab === 'mine' ? '你还没有发起过评审' : '暂无评审记录' }}
    </div>

    <div v-else class="rv-list">
      <div v-for="r in list" :key="r.id" class="rv card">
        <div class="rv-top" @click="router.push('/docs/' + r.docId)">
          <div class="rv-main">
            <span class="rv-doc-title">{{ docById[r.docId]?.title || '已删除文档' }}</span>
            <DocPill v-if="docById[r.docId]" :doc="docById[r.docId]" />
          </div>
          <div class="rv-side">
            <span class="st" :class="statusCls(r.status)">{{ reviewStatusLabel(r.status) }}</span>
            <span class="rv-time">{{ formatDate(r.submittedAt) }}</span>
          </div>
        </div>

        <div class="rv-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(r.submittedBy) }">{{ userById[r.submittedBy]?.avatar || '?' }}</span>
            {{ userById[r.submittedBy]?.name || r.submittedBy }} 发起
          </span>
          <span v-if="isRestoreReview(r)" class="restore-tag">↩ 恢复至 v{{ r.restoreFrom.version }}</span>
          <span v-if="isFreshReview(r)" class="fresh-tag">🧊 知识保鲜复核 · 第 {{ r.freshRound }} 轮{{ isFreshNoChangeReview(r) ? '（确认有效）' : '（修订）' }}</span>
          <span class="base">基于 v{{ r.baseVersion }}</span>
          <span class="cc">💬 {{ commentCount(r) }} 条意见</span>
          <span v-if="r.decidedAt" class="decided">
            {{ userById[r.decidedBy]?.name || r.decidedBy }} 于 {{ formatFull(r.decidedAt) }} {{ reviewStatusLabel(r.status) }}
          </span>
        </div>

        <div v-if="r.restoreResult && r.restoreResult.rolledBack.length" class="restore-result">
          已回滚 v{{ r.restoreResult.rolledBack[0] }}–v{{ r.restoreResult.rolledBack[r.restoreResult.rolledBack.length - 1] }}（{{ r.restoreResult.rolledBack.length }} 个版本，历史保留并标记为被覆盖）<template v-if="r.restoreResult.rolledBackConcurrent.length">，含并发修改 {{ r.restoreResult.rolledBackConcurrent.length }} 处</template>
        </div>

        <div v-if="r.decisionNote" class="dnote">审批意见：“{{ r.decisionNote }}”</div>

        <!-- 待审批：管理员可直接处理 -->
        <div v-if="canReviewDecision(auth.user?.role, r)" class="decide-box">
          <textarea
            v-model="noteMap[r.id]"
            rows="2"
            placeholder="审批意见（可选，将写入留痕时间线）"
          ></textarea>
          <div class="decide-actions">
            <button class="btn sm" :disabled="busyId === r.id" @click="decide(r, 'reject')">✕ 驳回</button>
            <button class="btn sm ok-solid" :disabled="busyId === r.id" @click="decide(r, 'approve')">✓ 通过并发布</button>
          </div>
        </div>

        <details class="timeline">
          <summary>查看留痕时间线（{{ (r.timeline || []).length }}）</summary>
          <div v-for="(t, i) in r.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ timelineActionLabel(t.action) }}</span>
            <span class="tl-who">{{ userById[t.by]?.name || t.by }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <p v-if="!isAdmin && tab === 'pending'" class="foot-tip">当前身份为非管理员，可浏览待审批单并在文档详情页发表评审意见，审批操作由管理员完成。</p>
  </div>
</template>

<style scoped>
.rc-page { max-width: 900px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.rv-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.rv { padding: 16px 20px; }
.rv-top { display: flex; justify-content: space-between; gap: 14px; cursor: pointer; }
.rv-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.rv-doc-title { font-weight: 700; font-size: 15px; }
.rv-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.rv-time { color: var(--text-3); font-size: 12px; }
.rv-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.base, .cc { color: var(--text-3); font-size: 12px; }
.restore-tag { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: #e0e7ff; color: #4338ca; font-weight: 600; }
.fresh-tag { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: #cffafe; color: #0e7490; font-weight: 600; }
.restore-result { margin-top: 8px; font-size: 12px; color: #3730a3; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 6px 12px; }
.decided { font-size: 12px; color: var(--text-3); }
.dnote { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.decide-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.decide-box textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
.decide-box textarea:focus { border-color: var(--primary); }
.decide-actions { display: flex; gap: 8px; margin-top: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 76px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
</style>
