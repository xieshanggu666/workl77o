<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useFreshnessStore } from '@/stores/freshness'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import { GUEST_ID } from '@/utils/permission'
import { canReviewDecision, canSubmitReview } from '@/utils/review'
import {
  FRESH, FRESH_CYCLES, cycleDaysLabel, freshStatusLabel, freshStatusCls,
  canManageFreshness, dueText, freshTimelineLabel, isFreshnessEnabled,
  isDocOverride, ruleSourceLabel
} from '@/utils/freshness'

const props = defineProps({
  doc: { type: Object, required: true }
})

const router = useRouter()
const auth = useAuthStore()
const freshness = useFreshnessStore()
const reviewStore = useReviewStore()
const accessStore = useAccessStore()

// 周期设置表单
const cycleDays = ref(props.doc.freshness?.cycleDays || 90)
const customDays = ref('')
const setting = ref(false)
const justSaved = ref('')
const busy = ref(false)
const noteText = ref('')
const decisionOpen = ref(false)
const justDecided = ref('')
const expanded = ref({})

const ticket = computed(() => freshness.activeTicketOf(props.doc.id))
const history = computed(() => freshness.ticketsOfDoc(props.doc.id).filter((t) => !ticket.value || t.id !== ticket.value.id))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

const isManager = computed(() => canManageFreshness(props.doc, auth.user?.id, auth.user?.role))
const activeGrant = computed(() => accessStore.grantOf(props.doc.id, auth.user?.id))
const pendingReview = computed(() => reviewStore.pendingReviewOf(props.doc.id))
// 本文档分类的复核策略（存在时文档可选择跟随或单独覆盖）
const catPolicy = computed(() => freshness.policyOfCategory(props.doc.categoryId))
const inherited = computed(() => isFreshnessEnabled(props.doc) && !isDocOverride(props.doc.freshness))

// 编辑者修订/确认送审资格：与发起评审一致（拥有者/协作成员/管理员，限时协作授权的只读成员不走此通道）
const canSubmitFresh = computed(() => {
  if (!ticket.value || ticket.value.status === FRESH.SUBMITTED) return false
  return canSubmitReview(props.doc, {
    userId: auth.user?.id || GUEST_ID,
    role: auth.user?.role,
    grant: activeGrant.value
  }, pendingReview.value)
})
const canDecide = computed(() => canReviewDecision(auth.user?.role, pendingReview.value, auth.user?.id))
const canWithdraw = computed(() =>
  ticket.value?.status === FRESH.SUBMITTED && pendingReview.value?.submittedBy === auth.user?.id
)

function pickedDays() {
  const c = Number(customDays.value)
  return c > 0 ? Math.floor(c) : Number(cycleDays.value)
}

async function saveCycle() {
  if (busy.value) return
  const days = pickedDays()
  if (!(days > 0)) { alert('请填写有效的复核周期天数'); return }
  busy.value = true
  try {
    const res = await freshness.setFreshCycle(props.doc.id, days, auth.user)
    if (res.status === 'ok') {
      justSaved.value = '已' + (res.action === 'change' ? '调整复核周期为 ' + days + ' 天' : '开启知识保鲜，复核周期 ' + days + ' 天') + '（文档单独设置）'
      customDays.value = ''
      setTimeout(() => { justSaved.value = '' }, 3000)
    } else if (res.status === 'has-open') {
      alert('当前存在流转中的复核单，请先完成本轮复核后再调整周期。')
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('仅文档拥有者或管理员可以设置复核周期。')
    } else {
      alert('保存失败，请重试')
    }
  } finally {
    busy.value = false
  }
}

// 取消文档级覆盖，恢复跟随分类策略
async function resetToPolicyAction() {
  if (busy.value || !catPolicy.value) return
  if (!confirm('恢复跟随分类策略？本文档将按分类统一周期（' + catPolicy.value.cycleDays + ' 天）重算到期点，文档级单独设置将被移除。')) return
  busy.value = true
  try {
    const res = await freshness.resetToPolicy(props.doc.id, auth.user)
    if (res.status === 'ok') {
      justSaved.value = '已恢复跟随分类策略（' + catPolicy.value.cycleDays + ' 天）'
      setTimeout(() => { justSaved.value = '' }, 3000)
    } else if (res.status === 'has-open') {
      alert('当前存在流转中的复核单，请先完成本轮复核。')
    } else if (res.status === 'no-policy') {
      alert('本文档所在分类暂无复核策略。')
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('仅文档拥有者或管理员可以调整保鲜配置。')
    }
  } finally {
    busy.value = false
  }
}

async function disableFreshnessAction() {
  if (busy.value) return
  if (ticket.value?.status === FRESH.SUBMITTED) {
    alert('本轮复核已送审，请先在评审中撤回后再关闭知识保鲜。')
    return
  }
  if (!confirm('关闭后将取消复核周期并作废当前复核单，文档恢复正常问答引用（历史复核记录保留）。确定关闭？')) return
  busy.value = true
  try {
    const res = await freshness.disableFreshness(props.doc.id, auth.user)
    if (res.status === 'ok') {
      justSaved.value = '已关闭知识保鲜'
      setTimeout(() => { justSaved.value = '' }, 3000)
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('仅文档拥有者或管理员可以关闭知识保鲜。')
    } else if (res.status === 'in-review') {
      alert('本轮复核已送审，请先撤回送审。')
    }
  } finally {
    busy.value = false
  }
}

// 确认内容有效、无需修订：直接以当前内容快照送管理员复核
async function submitNoChange() {
  if (busy.value || !ticket.value) return
  busy.value = true
  try {
    const res = await freshness.submitFreshReview(props.doc.id, {}, noteText.value.trim(), true, auth.user)
    if (res.status === 'ok') {
      noteText.value = ''
      justDecided.value = '已确认内容有效并送管理员复核'
      setTimeout(() => { justDecided.value = '' }, 3000)
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('你没有该文档的复核送审权限：仅拥有者、协作成员、管理员或持有效限时协作授权的成员可送审。')
    } else if (res.status === 'duplicate') {
      alert('该文档已有流转中的评审单。')
    } else if (res.status === 'no-ticket') {
      alert('当前没有待整改的复核单。')
    }
  } finally {
    busy.value = false
  }
}

function goRevise() {
  router.push('/docs/' + props.doc.id + '/edit?freshReview=1')
}

async function decide(decision) {
  if (!pendingReview.value || busy.value) return
  busy.value = true
  try {
    const res = await reviewStore.decideReview(pendingReview.value.id, decision, noteText.value.trim(), auth.user)
    if (res.status === 'ok') {
      justDecided.value = decision === 'approve' ? '复核通过，问答引用已恢复并重算周期' : '已驳回，编辑者继续整改'
      decisionOpen.value = false
      noteText.value = ''
      setTimeout(() => { justDecided.value = '' }, 3000)
    } else if (res.status === 'guest' || res.status === 'denied') {
      alert('只有管理员可以复核审批。')
    }
  } finally {
    busy.value = false
  }
}

async function withdraw() {
  if (!pendingReview.value || busy.value) return
  if (!confirm('撤回复核送审？复核单将回到待整改，问答引用继续暂停。')) return
  busy.value = true
  try {
    await reviewStore.withdrawReview(pendingReview.value.id, auth.user)
  } finally {
    busy.value = false
  }
}

function isExpanded(id) { return !!expanded.value[id] }
function toggle(id) { expanded.value = { ...expanded.value, [id]: !expanded.value[id] } }
function statusCls(s) { return freshStatusCls(s) }
</script>

<template>
  <div class="fresh card">
    <div class="fr-head">
      <span class="fr-title">🧊 知识保鲜</span>
      <span v-if="ticket" class="st" :class="statusCls(ticket.status)">{{ freshStatusLabel(ticket.status) }}</span>
      <span v-else-if="isFreshnessEnabled(doc)" class="st st-ok">
        ❄ {{ cycleDaysLabel(doc.freshness.cycleDays) }}复核 · {{ dueText(doc, null, freshness.now) }}
      </span>
      <span v-else class="st st-off">未启用</span>
      <span v-if="isFreshnessEnabled(doc)" class="st" :class="inherited ? 'st-policy' : 'st-doc'">
        {{ ruleSourceLabel(doc.freshness.source) }}
      </span>
    </div>

    <div v-if="justSaved" class="toast-line">✅ {{ justSaved }}</div>

    <!-- 流转中的复核单 -->
    <template v-if="ticket">
      <div class="ticket">
        <div class="t-meta">
          <span>第 <b>{{ ticket.round }}</b> 轮复核</span>
          <span class="dim">到期点：{{ formatFull(ticket.dueAt) }}（{{ dueText(doc, ticket, freshness.now) }}）</span>
          <span class="dim">本轮规则快照：{{ cycleDaysLabel(ticket.cycleDays) }} · {{ ruleSourceLabel(ticket.ruleSource) }}</span>
        </div>
        <div class="pause-note">⏸ 问答引用已暂停：本文档已超过复核周期，复核通过后自动恢复引用并重算周期。</div>

        <div v-if="ticket.status === 'rejected'" class="reject-note">
          管理员驳回：{{ ticket.decisionNote || '请按评审意见继续整改' }}（{{ userById[ticket.decidedBy]?.name || ticket.decidedBy }} · {{ formatDate(ticket.decidedAt) }}）
        </div>

        <div v-if="ticket.status === 'submitted'" class="submitted">
          <span class="dim">
            {{ userById[ticket.submittedBy]?.name || ticket.submittedBy }} 已于 {{ formatFull(ticket.submittedAt) }}
            {{ pendingReview?.freshNoChange ? '确认内容有效、直接送审' : '修订后送审' }}，等待管理员复核。
          </span>
        </div>

        <!-- 管理员审批 -->
        <div v-if="canDecide" class="decision">
          <button v-if="!decisionOpen" class="btn sm" @click="decisionOpen = true">复核审批</button>
          <template v-else>
            <textarea v-model="noteText" rows="2" placeholder="复核意见（可选，将留痕到本轮复核时间线）"></textarea>
            <div class="decision-actions">
              <button class="btn sm" :disabled="busy" @click="decide('reject')">✕ 驳回继续整改</button>
              <button class="btn sm ok-solid" :disabled="busy" @click="decide('approve')">✓ 复核通过并恢复引用</button>
              <button class="btn sm ghost" @click="decisionOpen = false">取消</button>
            </div>
          </template>
        </div>

        <!-- 编辑者操作 -->
        <template v-else>
          <div v-if="ticket.status !== 'submitted'" class="editor-acts">
            <button v-if="canSubmitFresh" class="btn sm primary" :disabled="busy" @click="goRevise">✎ 修订后送审</button>
            <button v-if="canSubmitFresh" class="btn sm" :disabled="busy" @click="submitNoChange">✓ 内容仍有效，直接送复核</button>
            <span v-if="!canSubmitFresh" class="dim">仅拥有者、协作成员、管理员或持有效限时协作授权的成员可处理本轮复核。</span>
          </div>
          <div v-if="canWithdraw" class="editor-acts">
            <button class="btn sm ghost" :disabled="busy" @click="withdraw">撤回复核送审</button>
          </div>
        </template>
      </div>
    </template>

    <!-- 周期配置（负责人/管理员） -->
    <div v-if="isManager" class="config">
      <template v-if="!ticket">
        <div v-if="inherited && catPolicy" class="src-note">
          当前跟随分类策略（{{ cycleDaysLabel(catPolicy.cycleDays) }}），策略调整会自动重算本文档到期点；在下方保存周期将转为本文档单独设置。
        </div>
        <div class="cfg-line">
          <label>复核周期</label>
          <div class="chips">
            <span v-for="c in FRESH_CYCLES" :key="c.days" class="chip" :class="{ on: !customDays && Number(cycleDays) === c.days }" @click="cycleDays = c.days; customDays = ''">{{ c.label }}</span>
          </div>
          <input v-model="customDays" class="custom" type="number" min="1" placeholder="自定义天数" />
        </div>
        <div class="cfg-acts">
          <button class="btn sm primary" :disabled="busy" @click="saveCycle">{{ isFreshnessEnabled(doc) ? (inherited ? '转为单独设置' : '保存周期') : '开启知识保鲜' }}</button>
          <button v-if="isDocOverride(doc.freshness) && catPolicy" class="btn sm" :disabled="busy" @click="resetToPolicyAction">↩ 恢复跟随分类策略（{{ cycleDaysLabel(catPolicy.cycleDays) }}）</button>
          <button v-if="isFreshnessEnabled(doc)" class="btn sm ghost" :disabled="busy" @click="disableFreshnessAction">关闭保鲜</button>
        </div>
        <p v-if="isFreshnessEnabled(doc) && doc.freshness?.lastApprovedAt" class="dim last">
          上一轮复核由 {{ userById[doc.freshness.lastApprovedBy]?.name || doc.freshness.lastApprovedBy }} 于 {{ formatDate(doc.freshness.lastApprovedAt) }} 通过。
        </p>
      </template>
      <div v-else class="cfg-locked dim">
        本轮复核完成后可调整/关闭复核周期。当前周期：{{ cycleDaysLabel(ticket.cycleDays) }}（{{ ruleSourceLabel(ticket.ruleSource) }} · 规则快照）。
      </div>
    </div>
    <p v-else-if="!isFreshnessEnabled(doc)" class="dim no-perm">该文档未启用知识保鲜，仅拥有者或管理员可设置复核周期。</p>

    <!-- 历史复核轮次 -->
    <div v-if="history.length" class="history">
      <div class="h-title">复核记录（{{ history.length + (ticket ? 1 : 0) }} 轮）</div>
      <div v-for="t in history" :key="t.id" class="h-item">
        <div class="h-head" @click="toggle(t.id)">
          <span class="st sm" :class="statusCls(t.status)">第 {{ t.round }} 轮 · {{ freshStatusLabel(t.status) }}</span>
          <span class="h-tm">{{ formatFull(t.createdAt) }}</span>
          <span class="h-arrow">{{ isExpanded(t.id) ? '收起 ▲' : '展开 ▼' }}</span>
        </div>
        <div v-if="isExpanded(t.id)" class="h-timeline">
          <div v-for="(x, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ freshTimelineLabel(x.action) }}</span>
            <span class="tl-who">{{ userById[x.by]?.name || x.by }}</span>
            <span v-if="x.note" class="tl-note">“{{ x.note }}”</span>
            <span class="tl-tm">{{ formatFull(x.at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fresh { margin-top: 14px; padding: 18px 24px; }
.fr-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.fr-title { font-weight: 700; font-size: 15px; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st.sm { font-size: 11px; padding: 1px 8px; }
.st-open { background: #cffafe; color: #0e7490; }
.st-review { background: #fef3c7; color: #b45309; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-policy { background: #e0e7ff; color: #4338ca; }
.st-doc { background: var(--panel-2); color: var(--text-2); }
.src-note { font-size: 12px; color: #4338ca; background: #eef2ff; border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
.toast-line { color: #15803d; font-size: 13px; margin-bottom: 10px; }
.ticket { border: 1px solid #a5f3fc; background: #ecfeff; border-radius: 10px; padding: 12px 14px; }
.t-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; margin-bottom: 6px; }
.dim { color: var(--text-3); font-size: 12px; }
.pause-note { font-size: 13px; color: #155e75; margin: 4px 0 8px; }
.reject-note { font-size: 12.5px; color: #b91c1c; background: #fee2e2; border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }
.submitted { margin-bottom: 8px; }
.editor-acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.decision { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #a5f3fc; }
.decision textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; margin-bottom: 8px; }
.decision textarea:focus { border-color: var(--primary); }
.decision-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.config { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); }
.cfg-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.cfg-line label { font-size: 13px; color: var(--text-2); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; font-size: 13px; }
.chip.on { background: #0e7490; border-color: #0e7490; color: #fff; }
.custom { width: 120px; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; }
.cfg-acts { display: flex; gap: 8px; }
.last { margin-top: 8px; }
.cfg-locked { padding: 8px 12px; background: var(--panel-2); border-radius: 8px; }
.no-perm { font-size: 12px; color: var(--text-3); margin-top: 10px; }
.history { margin-top: 14px; }
.h-title { font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
.h-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; overflow: hidden; }
.h-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; font-size: 13px; background: var(--panel-2); }
.h-tm { color: var(--text-3); font-size: 12px; }
.h-arrow { margin-left: auto; color: var(--text-3); font-size: 12px; }
.h-timeline { padding: 8px 14px; }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 5px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: #0e7490; min-width: 150px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
