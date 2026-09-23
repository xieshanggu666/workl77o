<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useFreshnessStore } from '@/stores/freshness'
import DocPill from '@/components/common/DocPill.vue'
import { formatFull, formatDate, avatarColor } from '@/utils/format'
import {
  FRESH, FRESH_CYCLES, freshStatusLabel, freshStatusCls, dueText, freshTimelineLabel,
  cycleDaysLabel, isFreshnessEnabled, isDocOverride, ruleSourceLabel, canManagePolicy
} from '@/utils/freshness'
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const freshness = useFreshnessStore()

const tab = ref('active') // active | mine | all | policies

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

const sorted = computed(() =>
  [...freshness.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
)

const list = computed(() => {
  if (tab.value === 'active') {
    return sorted.value.filter((t) => t.status === FRESH.OPEN || t.status === FRESH.SUBMITTED || t.status === FRESH.REJECTED)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
  }
  if (tab.value === 'mine') return sorted.value.filter((t) => docById.value[t.docId]?.ownerId === auth.user?.id)
  return sorted.value
})

const counts = computed(() => ({
  active: freshness.tickets.filter((t) => t.status === FRESH.OPEN || t.status === FRESH.SUBMITTED || t.status === FRESH.REJECTED).length,
  submitted: freshness.submittedCount,
  mine: freshness.tickets.filter((t) => docById.value[t.docId]?.ownerId === auth.user?.id).length,
  all: freshness.tickets.length
}))

// 已启用保鲜、尚未到期的文档（周期运行状况一览）
const upcoming = computed(() =>
  kb.docs
    .filter((d) => isFreshnessEnabled(d) && !freshness.activeTicketOf(d.id))
    .sort((a, b) => new Date(a.freshness.nextDueAt) - new Date(b.freshness.nextDueAt))
    .slice(0, 8)
)

// ---- 分类复核策略 ----
const isPolicyAdmin = computed(() => canManagePolicy(auth.user?.role))
// 每个分类的策略表单（chips 选择 + 自定义天数）
const pForm = ref({})
const pBusy = ref(false)
const pToast = ref('')

function formOf(catId) {
  if (!pForm.value[catId]) {
    const cur = freshness.policyOfCategory(catId)
    pForm.value = { ...pForm.value, [catId]: { days: cur?.cycleDays || 90, custom: '' } }
  }
  return pForm.value[catId]
}

function pickDays(catId, days) {
  pForm.value = { ...pForm.value, [catId]: { ...formOf(catId), days, custom: '' } }
}

function setCustom(catId, val) {
  pForm.value = { ...pForm.value, [catId]: { ...formOf(catId), custom: val } }
}

// 分类下保鲜配置统计：跟随策略 / 文档级覆盖 / 在途复核单
function catStats(catId) {
  const docs = kb.docs.filter((d) => d.categoryId === catId)
  return {
    total: docs.length,
    inherit: docs.filter((d) => d.freshness && !isDocOverride(d.freshness)).length,
    override: docs.filter((d) => isDocOverride(d.freshness)).length,
    open: docs.filter((d) => freshness.activeTicketOf(d.id)).length
  }
}

function toast(msg) {
  pToast.value = msg
  setTimeout(() => { pToast.value = '' }, 4000)
}

async function savePolicy(cat) {
  if (pBusy.value) return
  const f = formOf(cat.id)
  const days = Number(f.custom) > 0 ? Math.floor(Number(f.custom)) : Number(f.days)
  if (!(days > 0)) { alert('请填写有效的复核周期天数'); return }
  pBusy.value = true
  try {
    const res = await freshness.setCategoryPolicy(cat.id, days, auth.user)
    if (res.status === 'ok') {
      const parts = ['已' + (res.action === 'change' ? '调整' : '设置') + '「' + cat.name + '」复核周期为 ' + days + ' 天']
      parts.push('重算到期 ' + res.applied + ' 篇')
      if (res.skipped) parts.push(res.skipped + ' 篇在途复核保留规则快照')
      if (res.kept) parts.push(res.kept + ' 篇文档级覆盖未动')
      toast('✅ ' + parts.join('，'))
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('仅管理员可以设置分类复核策略。')
    } else {
      alert('保存失败，请重试')
    }
  } finally {
    pBusy.value = false
  }
}

async function clearPolicy(cat) {
  if (pBusy.value) return
  if (!confirm('关闭「' + cat.name + '」的分类复核策略？\n跟随策略且无在途复核的文档将退出保鲜并恢复问答引用；有在途复核单的文档按规则快照转为文档级配置继续本轮。')) return
  pBusy.value = true
  try {
    const res = await freshness.clearCategoryPolicy(cat.id, auth.user)
    if (res.status === 'ok') {
      const parts = ['已关闭「' + cat.name + '」分类复核策略']
      if (res.cleared) parts.push(res.cleared + ' 篇退出保鲜')
      if (res.converted) parts.push(res.converted + ' 篇在途复核转为文档级配置')
      toast('✅ ' + parts.join('，'))
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('仅管理员可以关闭分类复核策略。')
    }
  } finally {
    pBusy.value = false
  }
}

onMounted(async () => {
  await Promise.all([kb.loadAll(), freshness.loadAll()])
})
</script>

<template>
  <div class="fc-page">
    <header class="head">
      <h2>🧊 知识保鲜中心</h2>
      <p class="sub">管理员可按分类批量设置复核策略，文档可单独覆盖；策略调整自动重算到期计划，在途复核单保留规则快照。到期自动生成复核单并暂停问答引用，批准后恢复引用并重算周期。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'active' }" @click="tab = 'active'">待处理 <em>{{ counts.active }}</em></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我负责的 <em>{{ counts.mine }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部复核记录 <em>{{ counts.all }}</em></button>
        <button :class="{ on: tab === 'policies' }" @click="tab = 'policies'">分类策略 <em>{{ freshness.policies.length }}</em></button>
      </div>
    </header>

    <!-- 分类复核策略：批量设置，文档可单独覆盖 -->
    <div v-if="tab === 'policies'" class="policies">
      <div v-if="pToast" class="p-toast card">{{ pToast }}</div>
      <div class="p-tip card">
        分类策略对该分类下「未单独设置」的文档统一生效；文档级单独设置优先于分类策略。调整策略会立即重算跟随文档的到期计划，在途复核单仍按生成时的规则快照执行。
      </div>
      <div v-for="cat in kb.categories" :key="cat.id" class="policy card">
        <div class="p-head">
          <span class="p-name">{{ cat.name }}</span>
          <template v-if="freshness.policyOfCategory(cat.id)">
            <span class="st st-ok">❄ {{ cycleDaysLabel(freshness.policyOfCategory(cat.id).cycleDays) }}复核</span>
            <span class="dim">
              {{ userById[freshness.policyOfCategory(cat.id).updatedBy]?.name || freshness.policyOfCategory(cat.id).updatedBy }}
              更新于 {{ formatDate(freshness.policyOfCategory(cat.id).updatedAt) }}
            </span>
          </template>
          <span v-else class="st st-off">未设置策略</span>
          <span class="p-stats dim">
            {{ catStats(cat.id).total }} 篇文档 · {{ catStats(cat.id).inherit }} 篇跟随策略 · {{ catStats(cat.id).override }} 篇单独设置<template v-if="catStats(cat.id).open"> · {{ catStats(cat.id).open }} 篇在途复核</template>
          </span>
        </div>
        <div v-if="isPolicyAdmin" class="p-form">
          <div class="chips">
            <span
              v-for="c in FRESH_CYCLES" :key="c.days" class="chip"
              :class="{ on: !formOf(cat.id).custom && Number(formOf(cat.id).days) === c.days }"
              @click="pickDays(cat.id, c.days)"
            >{{ c.label }}</span>
          </div>
          <input
            :value="formOf(cat.id).custom" class="custom" type="number" min="1" placeholder="自定义天数"
            @input="setCustom(cat.id, $event.target.value)"
          />
          <button class="btn sm primary" :disabled="pBusy" @click="savePolicy(cat)">
            {{ freshness.policyOfCategory(cat.id) ? '保存策略并重算' : '开启分类策略' }}
          </button>
          <button v-if="freshness.policyOfCategory(cat.id)" class="btn sm ghost" :disabled="pBusy" @click="clearPolicy(cat)">关闭策略</button>
        </div>
        <details v-if="freshness.policyOfCategory(cat.id)?.timeline?.length" class="p-timeline">
          <summary>策略留痕（{{ freshness.policyOfCategory(cat.id).timeline.length }}）</summary>
          <div v-for="(x, i) in freshness.policyOfCategory(cat.id).timeline" :key="i" class="tl">
            <span class="tl-act">{{ freshTimelineLabel(x.action) }}</span>
            <span class="tl-who">{{ userById[x.by]?.name || x.by }}</span>
            <span v-if="x.note" class="tl-note">“{{ x.note }}”</span>
            <span class="tl-tm">{{ formatFull(x.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <template v-else>
    <div v-if="tab === 'active' && upcoming.length" class="upcoming card">
      <div class="up-title">⏳ 临近复核（保鲜运行中）</div>
      <div class="up-list">
        <span v-for="d in upcoming" :key="d.id" class="up-item" @click="router.push('/docs/' + d.id)">
          <span class="up-name">{{ d.title }}</span>
          <span class="up-due">{{ cycleDaysLabel(d.freshness.cycleDays) }} · {{ ruleSourceLabel(d.freshness.source) }} · {{ dueText(d, null, freshness.now) }}</span>
        </span>
      </div>
    </div>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🧊</div>
      {{ tab === 'active' ? '暂无待处理的保鲜复核单' : tab === 'mine' ? '你负责的文档还没有复核记录' : '暂无保鲜复核记录' }}
    </div>

    <div v-else class="fr-list">
      <div v-for="t in list" :key="t.id" class="fr card">
        <div class="fr-top" @click="router.push('/docs/' + t.docId)">
          <div class="fr-main">
            <span class="fr-doc-title">{{ docById[t.docId]?.title || '已删除文档' }}</span>
            <DocPill v-if="docById[t.docId]" :doc="docById[t.docId]" />
          </div>
          <div class="fr-side">
            <span class="st" :class="freshStatusCls(t.status)">第 {{ t.round }} 轮 · {{ freshStatusLabel(t.status) }}</span>
            <span class="fr-time">到期点 {{ formatFull(t.dueAt) }}（{{ dueText(docById[t.docId], t, freshness.now) }}）</span>
          </div>
        </div>

        <div class="fr-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(docById[t.docId]?.ownerId || '?') }">{{ (userById[docById[t.docId]?.ownerId]?.avatar || '?') }}</span>
            负责人：{{ userById[docById[t.docId]?.ownerId]?.name || docById[t.docId]?.ownerId || '—' }}
          </span>
          <span class="dim">周期 {{ cycleDaysLabel(t.cycleDays) }} · {{ ruleSourceLabel(t.ruleSource) }}</span>
          <span v-if="t.submittedBy" class="dim">
            {{ userById[t.submittedBy]?.name || t.submittedBy }} 送审
          </span>
          <span v-if="t.decidedAt" class="dim">
            {{ userById[t.decidedBy]?.name || t.decidedBy }} 于 {{ formatFull(t.decidedAt) }} {{ freshStatusLabel(t.status) }}
          </span>
        </div>

        <div v-if="t.status === 'rejected' && t.decisionNote" class="dnote">驳回意见：“{{ t.decisionNote }}”</div>

        <details class="timeline">
          <summary>查看本轮复核时间线（{{ (t.timeline || []).length }}）</summary>
          <div v-for="(x, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ freshTimelineLabel(x.action) }}</span>
            <span class="tl-who">{{ userById[x.by]?.name || x.by }}</span>
            <span v-if="x.note" class="tl-note">“{{ x.note }}”</span>
            <span class="tl-tm">{{ formatFull(x.at) }}</span>
          </div>
        </details>
      </div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.fc-page { max-width: 920px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: #0e7490; border-color: #0e7490; color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.upcoming { margin-top: 16px; padding: 14px 18px; }
.up-title { font-weight: 600; font-size: 13px; color: var(--text-2); margin-bottom: 10px; }
.up-list { display: flex; flex-wrap: wrap; gap: 8px; }
.up-item { display: inline-flex; flex-direction: column; gap: 2px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: var(--panel-2); }
.up-item:hover { border-color: #0e7490; }
.up-name { font-size: 13px; font-weight: 500; }
.up-due { font-size: 11px; color: var(--text-3); }
.fr-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.fr { padding: 16px 20px; }
.fr-top { display: flex; justify-content: space-between; gap: 14px; cursor: pointer; }
.fr-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.fr-doc-title { font-weight: 700; font-size: 15px; }
.fr-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #cffafe; color: #0e7490; }
.st-review { background: #fef3c7; color: #b45309; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.fr-time { color: var(--text-3); font-size: 12px; }
.fr-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.dim { color: var(--text-3); font-size: 12px; }
.dnote { margin-top: 8px; font-size: 13px; color: #b91c1c; background: #fee2e2; border-radius: 8px; padding: 8px 12px; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: #0e7490; min-width: 180px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.policies { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
.p-toast { padding: 12px 18px; color: #15803d; font-size: 13px; }
.p-tip { padding: 12px 18px; font-size: 12.5px; color: var(--text-2); background: #eef2ff; border-color: #c7d2fe; }
.policy { padding: 16px 20px; }
.p-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.p-name { font-weight: 700; font-size: 14px; }
.p-stats { margin-left: auto; }
.p-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; font-size: 13px; }
.chip.on { background: #0e7490; border-color: #0e7490; color: #fff; }
.custom { width: 110px; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; }
.p-timeline { margin-top: 10px; }
.p-timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
</style>
