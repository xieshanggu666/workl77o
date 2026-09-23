<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useGapStore } from '@/stores/gap'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  GAP, gapStatusLabel, gapStatusCls, gapTimelineLabel,
  isGroupPrimary, canClaimTicket, canReleaseTicket, canSubmitGapReview,
  canMergeTicket, canCommitMerge, canRemoveFromGroup, canDissolveGroup
} from '@/utils/gap'
import { canEditContent } from '@/utils/permission'
import { reviewStatusLabel } from '@/utils/review'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const gapStore = useGapStore()

const tab = ref(GAP.OPEN) // open | claimed | in_review | resolved | all
const pickDoc = ref({}) // 工单/主工单 id -> 待送审的关联文档 id
const busyId = ref('')
const toast = ref('')
const selectedIds = ref(new Set()) // 勾选待合并的独立工单

const TABS = [
  { key: GAP.OPEN, label: '待认领' },
  { key: GAP.CLAIMED, label: '处理中' },
  { key: GAP.IN_REVIEW, label: '送审中' },
  { key: GAP.RESOLVED, label: '已解决' },
  { key: 'all', label: '全部' }
]

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const canEdit = computed(() => canEditContent(auth.user?.role))

const sorted = computed(() =>
  [...gapStore.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
)

// 列表行：独立工单一行；同一 groupId 的工单折叠为一个合并组行（组状态以主工单为准）
const rows = computed(() => {
  const groupRows = new Map()
  const acc = []
  for (const t of sorted.value) {
    if (t.groupId) {
      let row = groupRows.get(t.groupId)
      if (!row) {
        row = { type: 'group', groupId: t.groupId, members: [], primary: null }
        groupRows.set(t.groupId, row)
        acc.push(row)
      }
      row.members.push(t)
    } else {
      acc.push({ type: 'single', ticket: t })
    }
  }
  for (const row of acc) {
    if (row.type !== 'group') continue
    row.members.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    row.primary = row.members.find((m) => isGroupPrimary(m)) || row.members[0]
  }
  const statusOf = (r) => (r.type === 'group' ? r.primary.status : r.ticket.status)
  const filtered = tab.value === 'all' ? acc : acc.filter((r) => statusOf(r) === tab.value)
  return filtered.sort((a, b) => {
    const ta = a.type === 'group' ? a.primary.createdAt : a.ticket.createdAt
    const tb = b.type === 'group' ? b.primary.createdAt : b.ticket.createdAt
    return new Date(tb) - new Date(ta)
  })
})

// 已勾选的工单对象（组内/已流转的工单不会出现在勾选集合中，提交前再做一次可合并校验）
const selectedTickets = computed(() =>
  [...selectedIds.value].map((id) => gapStore.tickets.find((t) => t.id === id)).filter(Boolean)
)
const mergeAllowed = computed(() =>
  canCommitMerge(auth.user?.role, selectedTickets.value, auth.user?.id)
)

const counts = computed(() => {
  const c = { all: gapStore.tickets.length }
  for (const s of [GAP.OPEN, GAP.CLAIMED, GAP.IN_REVIEW, GAP.RESOLVED]) {
    c[s] = gapStore.tickets.filter((t) => t.status === s).length
  }
  return c
})
const emptyText = computed(() => ({
  [GAP.OPEN]: '暂无待认领的补写需求',
  [GAP.CLAIMED]: '暂无处理中的工单',
  [GAP.IN_REVIEW]: '暂无送审中的工单',
  [GAP.RESOLVED]: '暂无已解决的工单',
  all: '暂无缺口工单，去智能问答提交未解决的问题吧'
}[tab.value]))

// 可关联的文档：当前没有流转中评审单的文档（送审会锁定文档，需错开）
const linkableDocs = computed(() =>
  [...kb.docs]
    .filter((d) => !reviewStore.pendingReviewOf(d.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

// 送审中工单对应的评审单状态（正常应为待审批，兜底展示历史结论）
function reviewOf(t) {
  return t.reviewId ? reviewStore.reviews.find((r) => r.id === t.reviewId) : null
}

function mergeable(t) {
  return canMergeTicket(auth.user?.role, t, auth.user?.id)
}

function toggleSelect(id) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function clearSelection() {
  selectedIds.value = new Set()
}

function showToast(msg) {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 3000)
}

async function claim(t) {
  if (busyId.value) return
  busyId.value = t.id
  try {
    const res = await gapStore.claimTicket(t.id, auth.user)
    if (res.status !== 'ok') alert('认领失败：工单状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

async function release(t) {
  if (busyId.value) return
  if (!confirm('确定取消认领？工单将退回「待认领」。')) return
  busyId.value = t.id
  try {
    const res = await gapStore.releaseTicket(t.id, auth.user)
    if (res.status !== 'ok') alert('取消认领失败：工单状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

// 合并认领：同类问题共用一个处理人与一次送审，各自提问与处理历史保留
async function mergeSelected() {
  if (!mergeAllowed.value || busyId.value) return
  const ids = [...selectedIds.value]
  busyId.value = 'merge'
  try {
    const res = await gapStore.mergeTickets(ids, auth.user)
    if (res.status === 'ok') {
      clearSelection()
      tab.value = GAP.CLAIMED
      showToast('已合并认领 ' + ids.length + ' 个同类问题，将共用一次文档送审')
    } else if (res.status === 'changed') {
      alert('合并失败：所选工单状态已变化（可能已被他人认领或已合并），请刷新后重试。')
    } else if (res.status === 'duplicate-question') {
      alert('所选工单中存在完全相同的问题，无需合并。')
    } else {
      alert('合并失败：工单状态已变化，请刷新后重试。')
    }
  } finally {
    busyId.value = ''
  }
}

// 把组成员移出本组（保留认领人独立处理）
async function removeMember(m) {
  if (busyId.value) return
  if (!confirm('确定把「' + m.question + '」移出合并组？移出后将作为独立工单继续处理。')) return
  busyId.value = m.id
  try {
    const res = await gapStore.removeFromGroup(m.id, auth.user)
    if (res.status !== 'ok') alert('移出失败：合并组状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

// 解散合并组：全部成员退回待认领
async function dissolve(row) {
  if (busyId.value) return
  if (!confirm('确定解散该合并组？组内 ' + row.members.length + ' 个工单将全部退回「待认领」，各自的提问与处理记录会保留。')) return
  busyId.value = row.groupId
  try {
    const res = await gapStore.dissolveGroup(row.groupId, auth.user)
    if (res.status !== 'ok') alert('解散失败：合并组状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

// 关联文档送审：评审单创建、文档锁定、（合并组）全组工单关联在 review store 的同一事务内完成，
// 任一步失败整体回滚（不会留下孤立评审单或卡在送审中的工单）
async function submitGapReview(t, memberCount) {
  const docId = pickDoc.value[t.id]
  if (!docId || busyId.value) return
  busyId.value = t.id
  try {
    const d = await kb.getDocFresh(docId)
    if (!d) { alert('文档不存在或已被删除'); return }
    const notePrefix = memberCount > 1
      ? '补写缺口合并组（' + memberCount + ' 个同类问题）'
      : '补写缺口工单'
    const res = await reviewStore.submitGapReview(t.id, docId, {
      title: d.title, body: d.body, categoryId: d.categoryId,
      tagIds: d.tagIds || [], visibility: d.visibility
    }, notePrefix + '：' + t.question, auth.user)
    if (res.status === 'ok') {
      showToast(memberCount > 1
        ? '合并组已共用该文档送审，审批通过后将统一回填答案来源'
        : '已关联文档并送审，管理员审批通过后将自动回填答案来源')
    } else if (res.status === 'duplicate') {
      alert('该文档已有流转中的评审单，请换一篇文档或等待审批完成。')
    } else if (res.status === 'ticket-changed') {
      alert('工单状态已变化（可能已被取消认领、移出或解散），请刷新查看。')
    } else if (res.status === 'guest') {
      alert('访客不能关联文档送审，请先登录。')
    } else if (res.status === 'denied') {
      alert('你没有该文档的送审权限：仅文档拥有者、协作成员或管理员可发起评审。')
    } else {
      alert('送审失败：工单或文档状态已变化，请刷新后重试。')
    }
  } finally {
    busyId.value = ''
  }
}

// 新建文档补写：携带主工单 id 与问题作为标题，发布文档后回到本页继续送审
function goNewDoc(t) {
  router.push({ path: '/docs/new', query: { gap: t.id, title: t.question } })
}

onMounted(async () => {
  await Promise.all([gapStore.loadAll(), reviewStore.loadAll()])
  // 从编辑器「新建文档补写」返回：定位到该工单并预选刚创建的文档
  if (route.query.pick) {
    tab.value = GAP.CLAIMED
    if (route.query.doc) pickDoc.value = { ...pickDoc.value, [route.query.pick]: route.query.doc }
    showToast('文档已创建，确认关联文档后点击「关联并送审」')
  }
})
</script>

<template>
  <div class="gap-page">
    <header class="head">
      <h2>📮 知识缺口工单</h2>
      <p class="sub">成员把未解决的问答转为补写需求 → 编辑者认领（可勾选多个同类问题<strong>合并认领</strong>，共用一次文档送审）→ 审批通过后统一回填答案来源，驳回或文档删除则同步退回，全程留痕。</p>
      <div class="tabs">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">
          {{ t.label }} <em>{{ counts[t.key] }}</em>
        </button>
      </div>
    </header>

    <div v-if="toast" class="card toast-line">✅ {{ toast }}</div>

    <div v-if="!rows.length" class="empty card">
      <div class="ico">📭</div>
      {{ emptyText }}
    </div>

    <div v-else class="tk-list">
      <!-- 合并组卡片 -->
      <div v-for="row in rows.filter((r) => r.type === 'group')" :key="'g-' + row.groupId" class="tk card group-card">
        <div class="grp-head">
          <span class="grp-badge">🧩 合并组 · {{ row.members.length }} 个同类问题</span>
          <span class="st" :class="gapStatusCls(row.primary.status)">{{ gapStatusLabel(row.primary.status) }}</span>
        </div>

        <template v-for="(m, idx) in row.members" :key="m.id">
          <div class="grp-item" :class="{ primary: isGroupPrimary(m), picked: route.query.pick === m.id }">
            <div class="tk-top">
              <div class="tk-q">
                {{ isGroupPrimary(m) ? '👑 ' : '❓ ' }}{{ m.question }}
                <em v-if="isGroupPrimary(m)" class="primary-tag">主问题</em>
              </div>
              <div class="tk-side">
                <span class="tk-time">{{ formatDate(m.createdAt) }}</span>
              </div>
            </div>
            <div v-if="m.detail" class="tk-detail">{{ m.detail }}</div>
            <div class="tk-info">
              <span class="who">
                <span class="ava" :style="{ background: avatarColor(m.createdBy) }">{{ userById[m.createdBy]?.avatar || '?' }}</span>
                {{ userById[m.createdBy]?.name || m.createdBy }} 提交
              </span>
            </div>

            <details class="timeline">
              <summary>处理记录（{{ (m.timeline || []).length }}）</summary>
              <div v-for="(e, i) in m.timeline || []" :key="i" class="tl">
                <span class="tl-act">{{ gapTimelineLabel(e.action) }}</span>
                <span class="tl-who">{{ e.by === 'system' ? '系统' : (userById[e.by]?.name || e.by) }}</span>
                <span v-if="e.note" class="tl-note">“{{ e.note }}”</span>
                <span class="tl-tm">{{ formatFull(e.at) }}</span>
              </div>
            </details>

            <!-- 处理中：组成员可被移出（主工单除外） -->
            <div v-if="canRemoveFromGroup(auth.user?.role, m, auth.user?.id)" class="grp-item-acts">
              <button class="btn xs ghost" :disabled="busyId === m.id" @click="removeMember(m)">↗ 移出本组</button>
            </div>
          </div>
          <div v-if="idx < row.members.length - 1" class="grp-sep"></div>
        </template>

        <!-- 组级信息与操作（以主工单为准） -->
        <div class="grp-foot">
          <div class="tk-info grp-owner">
            <span class="who">认领人：<b>{{ userById[row.primary.claimedBy]?.name || row.primary.claimedBy }}</b></span>
            <span v-if="row.primary.resolvedAt" class="resolved-at">已于 {{ formatFull(row.primary.resolvedAt) }} 统一解决</span>
          </div>

          <!-- 已解决：统一回填同一答案来源 -->
          <div v-if="row.primary.status === GAP.RESOLVED" class="answer-src" @click="docById[row.primary.docId] && router.push('/docs/' + row.primary.docId)">
            💡 答案来源：《{{ docById[row.primary.docId]?.title || '文档已删除' }}》
            <span v-if="docById[row.primary.docId]" class="go">查看文档 →</span>
          </div>

          <!-- 送审中/处理中已关联的文档 -->
          <div v-else-if="row.primary.docId" class="linked-doc">
            <span class="lk-label">共用关联文档：</span>
            <template v-if="docById[row.primary.docId]">
              <span class="lk-title" @click="router.push('/docs/' + row.primary.docId)">《{{ docById[row.primary.docId].title }}》</span>
              <DocPill :doc="docById[row.primary.docId]" />
            </template>
            <span v-else class="lk-missing">文档已删除</span>
          </div>

          <!-- 处理中（组处理人）：共用一次关联文档送审 -->
          <div v-if="canSubmitGapReview(auth.user?.role, row.primary, auth.user?.id)" class="claim-box">
            <div class="lk-row">
              <select v-model="pickDoc[row.primary.id]">
                <option value="" disabled>选择要关联的文档…</option>
                <option v-for="d in linkableDocs" :key="d.id" :value="d.id">{{ d.title }}</option>
              </select>
              <button class="btn sm primary" :disabled="!pickDoc[row.primary.id] || busyId === row.primary.id" @click="submitGapReview(row.primary, row.members.length)">📤 合并送审</button>
              <button class="btn sm" @click="goNewDoc(row.primary)">＋ 新建文档补写</button>
              <button v-if="canDissolveGroup(auth.user?.role, row.primary, auth.user?.id)" class="btn sm ghost" :disabled="busyId === row.groupId" @click="dissolve(row)">解散合并组</button>
            </div>
            <div class="lk-hint">送审后全组进入「送审中」，文档同步锁定待审；审批通过即统一回填答案来源，驳回/撤回/文档删除将整组退回处理。</div>
          </div>

          <!-- 其他成员视角的处理中 -->
          <div v-else-if="row.primary.status === GAP.CLAIMED" class="state-tip">🖊 认领人补写中，全组待关联文档统一送审…</div>

          <!-- 送审中 -->
          <div v-else-if="row.primary.status === GAP.IN_REVIEW" class="state-tip">
            ⏳ 已合并送审，等待管理员审批<template v-if="reviewOf(row.primary)">（评审单{{ reviewStatusLabel(reviewOf(row.primary).status) }}）</template>。
            <a v-if="row.primary.docId" @click="router.push('/docs/' + row.primary.docId)">查看评审进度 →</a>
          </div>
        </div>
      </div>

      <!-- 独立工单 -->
      <div v-for="t in rows.filter((r) => r.type === 'single')" :key="t.ticket.id" class="tk card" :class="{ picked: route.query.pick === t.ticket.id }">
        <div class="tk-top">
          <div class="tk-q with-check">
            <label v-if="mergeable(t.ticket)" class="merge-check" @click.stop>
              <input type="checkbox" :checked="selectedIds.has(t.ticket.id)" @change="toggleSelect(t.ticket.id)" />
            </label>
            <span>❓ {{ t.ticket.question }}</span>
          </div>
          <div class="tk-side">
            <span class="st" :class="gapStatusCls(t.ticket.status)">{{ gapStatusLabel(t.ticket.status) }}</span>
            <span class="tk-time">{{ formatDate(t.ticket.createdAt) }}</span>
          </div>
        </div>
        <div v-if="t.ticket.detail" class="tk-detail">{{ t.ticket.detail }}</div>

        <div class="tk-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(t.ticket.createdBy) }">{{ userById[t.ticket.createdBy]?.avatar || '?' }}</span>
            {{ userById[t.ticket.createdBy]?.name || t.ticket.createdBy }} 提交
          </span>
          <span v-if="t.ticket.claimedBy" class="who">认领人：<b>{{ userById[t.ticket.claimedBy]?.name || t.ticket.claimedBy }}</b></span>
          <span v-else class="who none">暂未认领</span>
          <span v-if="t.ticket.resolvedAt" class="resolved-at">已于 {{ formatFull(t.ticket.resolvedAt) }} 解决</span>
        </div>

        <!-- 已解决：审批通过后自动回填的答案来源 -->
        <div v-if="t.ticket.status === GAP.RESOLVED" class="answer-src" @click="docById[t.ticket.docId] && router.push('/docs/' + t.ticket.docId)">
          💡 答案来源：《{{ docById[t.ticket.docId]?.title || '文档已删除' }}》
          <span v-if="docById[t.ticket.docId]" class="go">查看文档 →</span>
        </div>

        <!-- 送审中/处理中已关联的文档 -->
        <div v-else-if="t.ticket.docId" class="linked-doc">
          <span class="lk-label">关联文档：</span>
          <template v-if="docById[t.ticket.docId]">
            <span class="lk-title" @click="router.push('/docs/' + t.ticket.docId)">《{{ docById[t.ticket.docId].title }}》</span>
            <DocPill :doc="docById[t.ticket.docId]" />
          </template>
          <span v-else class="lk-missing">文档已删除</span>
        </div>

        <!-- 待认领：编辑者/管理员可认领 -->
        <div v-if="canClaimTicket(auth.user?.role, t.ticket)" class="acts">
          <button class="btn sm primary" :disabled="busyId === t.ticket.id" @click="claim(t.ticket)">🙋 认领补写</button>
        </div>

        <!-- 处理中（认领人/管理员）：关联文档送审 -->
        <div v-else-if="canSubmitGapReview(auth.user?.role, t.ticket, auth.user?.id)" class="claim-box">
          <div class="lk-row">
            <select v-model="pickDoc[t.ticket.id]">
              <option value="" disabled>选择要关联的文档…</option>
              <option v-for="d in linkableDocs" :key="d.id" :value="d.id">{{ d.title }}</option>
            </select>
            <button class="btn sm primary" :disabled="!pickDoc[t.ticket.id] || busyId === t.ticket.id" @click="submitGapReview(t.ticket, 1)">📤 关联并送审</button>
            <button class="btn sm" @click="goNewDoc(t.ticket)">＋ 新建文档补写</button>
            <button v-if="canReleaseTicket(auth.user?.role, t.ticket, auth.user?.id)" class="btn sm ghost" :disabled="busyId === t.ticket.id" @click="release(t.ticket)">取消认领</button>
          </div>
          <div class="lk-hint">送审后工单进入「送审中」，文档同步锁定待审；审批通过即自动回填答案来源，驳回将退回处理。</div>
        </div>

        <!-- 其他成员视角的处理中 -->
        <div v-else-if="t.ticket.status === GAP.CLAIMED" class="state-tip">🖊 认领人补写中，待关联文档送审…</div>

        <!-- 送审中 -->
        <div v-else-if="t.ticket.status === GAP.IN_REVIEW" class="state-tip">
          ⏳ 已送审，等待管理员审批<template v-if="reviewOf(t.ticket)">（评审单{{ reviewStatusLabel(reviewOf(t.ticket).status) }}）</template>。
          <a v-if="t.ticket.docId" @click="router.push('/docs/' + t.ticket.docId)">查看评审进度 →</a>
        </div>

        <details class="timeline">
          <summary>处理记录（{{ (t.ticket.timeline || []).length }}）</summary>
          <div v-for="(e, i) in t.ticket.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ gapTimelineLabel(e.action) }}</span>
            <span class="tl-who">{{ e.by === 'system' ? '系统' : (userById[e.by]?.name || e.by) }}</span>
            <span v-if="e.note" class="tl-note">“{{ e.note }}”</span>
            <span class="tl-tm">{{ formatFull(e.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <!-- 勾选合并的浮动操作条 -->
    <transition name="slide-up">
      <div v-if="selectedIds.size > 0" class="merge-bar card">
        <label class="merge-bar-check" @click.stop>
          <input type="checkbox" checked readonly @click.prevent />
        </label>
        <span class="merge-info">已选择 <b>{{ selectedIds.size }}</b> 个工单</span>
        <span v-if="!mergeAllowed" class="merge-warn">仅可勾选「待认领」或自己处理中的独立工单，至少 2 个</span>
        <button class="btn sm primary" :disabled="!mergeAllowed || busyId === 'merge'" @click="mergeSelected">
          🧩 合并认领（{{ selectedIds.size }}）
        </button>
        <button class="btn sm ghost" @click="clearSelection">取消</button>
      </div>
    </transition>

    <p v-if="!canEdit" class="foot-tip">当前身份为只读成员：可在智能问答页提交补写需求，认领与合并送审由编辑者/管理员完成。</p>
  </div>
</template>

<style scoped>
.gap-page { max-width: 900px; margin: 0 auto; padding-bottom: 80px; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.sub strong { color: var(--primary); }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.toast-line { margin-top: 14px; padding: 10px 18px; font-size: 13px; color: #15803d; background: #f0fdf4; border-color: #16a34a; }
.tk-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.tk { padding: 16px 20px; }
.tk.picked { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-weak); }
.tk-top { display: flex; justify-content: space-between; gap: 14px; }
.tk-q { font-weight: 700; font-size: 15px; min-width: 0; }
.tk-q.with-check { display: flex; align-items: flex-start; gap: 8px; }
.primary-tag { font-style: normal; font-size: 11px; font-weight: 600; color: var(--primary); background: var(--primary-weak); border-radius: 4px; padding: 1px 6px; margin-left: 6px; vertical-align: 2px; }
.tk-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-claimed { background: var(--primary-weak); color: var(--primary); }
.st-review { background: #e0f2fe; color: #0369a1; }
.st-resolved { background: #dcfce7; color: #15803d; }
.tk-time { color: var(--text-3); font-size: 12px; }
.tk-detail { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.tk-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.who.none { color: var(--text-3); }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.resolved-at { font-size: 12px; color: var(--text-3); }
.answer-src { margin-top: 12px; padding: 10px 14px; border-radius: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.answer-src .go { margin-left: auto; font-size: 12px; }
.linked-doc { margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.lk-label { color: var(--text-3); }
.lk-title { color: var(--primary); font-weight: 600; cursor: pointer; }
.lk-title:hover { text-decoration: underline; }
.lk-missing { color: var(--text-3); }
.acts { margin-top: 12px; }
.claim-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.lk-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.lk-row select { flex: 1; min-width: 220px; padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; background: var(--panel); outline: none; }
.lk-row select:focus { border-color: var(--primary); }
.lk-hint { margin-top: 8px; font-size: 12px; color: var(--text-3); }
.state-tip { margin-top: 12px; font-size: 13px; color: var(--text-2); }
.state-tip a { cursor: pointer; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 150px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }

/* 合并勾选框 */
.merge-check { display: inline-flex; cursor: pointer; margin: 0; }
.merge-check input { width: 15px; height: 15px; accent-color: var(--primary); cursor: pointer; }

/* 合并组卡片 */
.group-card { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary-weak); }
.grp-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.grp-badge { font-size: 13px; font-weight: 700; color: var(--primary); }
.grp-item { padding: 10px 12px; border-radius: 8px; position: relative; }
.grp-item.primary { background: var(--primary-weak); }
.grp-item.picked { box-shadow: inset 0 0 0 2px var(--primary); }
.grp-sep { border-top: 1px dashed var(--border); margin: 2px 0; }
.grp-item .tk-info { margin-top: 8px; }
.grp-item-acts { margin-top: 6px; text-align: right; }
.btn.xs { padding: 3px 10px; font-size: 12px; }
.grp-foot { border-top: 1px dashed var(--border); margin-top: 10px; padding-top: 10px; }
.grp-owner { margin-top: 0; }

/* 底部合并操作条 */
.merge-bar { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 10px 18px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.14); z-index: 50; max-width: 860px; }
.merge-bar-check input { width: 16px; height: 16px; accent-color: var(--primary); }
.merge-info { font-size: 13px; color: var(--text-1); }
.merge-warn { font-size: 12px; color: #b45309; flex: 1; }
.slide-up-enter-active, .slide-up-leave-active { transition: all 0.2s ease; }
.slide-up-enter-from, .slide-up-leave-to { opacity: 0; transform: translate(-50%, 16px); }
</style>
