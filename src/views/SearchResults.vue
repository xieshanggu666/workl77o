<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useRetirementStore } from '@/stores/retirement'
import { canViewDoc } from '@/utils/permission'
import { isFreshTicketOpen } from '@/utils/freshness'
import { isDocSearchable } from '@/utils/retirement'
import { tokenize, stripHtml, highlightTitle, highlightText, extractSnippet } from '@/utils/search'
import { formatDate } from '@/utils/format'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const accessStore = useAccessStore()
const freshnessStore = useFreshnessStore()
const retirementStore = useRetirementStore()

const q = ref(route.query.q || '')
const catFilter = ref('all')
const tagFilter = ref('all')
const tokens = ref([])

async function run() {
  q.value = route.query.q || ''
  tokens.value = tokenize(q.value)
  if (!tokens.value.length) return
  // 普通输入框的实时过滤由 computed 完成
}

const results = computed(() => {
  const kw = tokenize(q.value)
  if (!kw.length) return []
  // 权限：撤销/到期的授权文档不再可被搜索命中；已退役文档停止搜索命中（详情仍可访问）
  let list = kb.docs.filter((d) =>
    canViewDoc(d, auth.user?.id, null, accessStore.grantOf(d.id, auth.user?.id)) &&
    isDocSearchable(d, retirementStore.activeRetirementOfDoc(d.id))
  )
  const textById = {}
  list = list.map((d) => {
    const text = stripHtml(d.body)
    textById[d.id] = text
    return d
  }).filter((d) => {
    const tagNames = (d.tagIds || []).map((id) => kb.tagMap[id]?.name || '')
    const hay = (d.title + ' ' + textById[d.id] + ' ' + tagNames.join(' ')).toLowerCase()
    return kw.every((t) => hay.includes(t.toLowerCase()))
  })

  if (catFilter.value !== 'all') list = list.filter((d) => d.categoryId === catFilter.value)
  if (tagFilter.value !== 'all') list = list.filter((d) => (d.tagIds || []).includes(tagFilter.value))

  return list.map((d) => ({
    ...d,
    bodyText: textById[d.id],
    snippet: extractSnippet(d.body, kw)
  }))
})

function clearAll() { q.value = ''; catFilter.value = 'all'; tagFilter.value = 'all'; router.push({ name: 'search' }) }

watch(() => route.query.q, run, { immediate: true })

onMounted(() => { retirementStore.loadAll() })
</script>

<template>
  <div class="search-page">
    <header class="head">
      <h2>全局搜索</h2>
      <div class="bar">
        <input v-model="q" placeholder="输入关键词，回车搜索标题 / 正文 / 标签…" @keyup.enter="router.replace({ name: 'search', query: { q: q.trim() } })" />
        <button class="btn primary" @click="router.replace({ name: 'search', query: { q: q.trim() } })">搜索</button>
      </div>
      <div class="filters">
        <select v-model="catFilter" class="sel">
          <option value="all">全部分类</option>
          <option v-for="c in kb.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model="tagFilter" class="sel">
          <option value="all">全部标签</option>
          <option v-for="t in kb.tags" :key="t.id" :value="t.id"># {{ t.name }}</option>
        </select>
        <span class="count">命中 {{ results.length }} 篇</span>
      </div>
    </header>

    <div v-if="results.length" class="results">
      <div v-for="d in results" :key="d.id" class="result card" @click="router.push('/docs/' + d.id)">
        <div class="r-title-line">
          <span class="r-title" v-html="highlightTitle(d.title, tokenize(q))"></span>
          <span v-if="reviewStore.pendingReviewOf(d.id)" class="rv-badge">⏳ 评审中</span>
          <span v-if="isFreshTicketOpen(freshnessStore.activeTicketOf(d.id))" class="fresh-badge" title="超过复核周期，问答引用已暂停，复核通过后恢复">🧊 保鲜复核中</span>
        </div>
        <div class="r-cat">{{ kb.catMap[d.categoryId]?.name }} · 更新于 {{ formatDate(d.updatedAt) }}</div>
        <div class="r-snippet" v-html="highlightText(d.snippet, tokenize(q))"></div>
        <div class="r-tags">
          <span v-for="t in d.tagIds" :key="t" class="pill tag" :style="{ background: kb.tagMap[t]?.color, color: '#fff' }">{{ kb.tagMap[t]?.name }}</span>
        </div>
      </div>
    </div>

    <div v-else-if="q" class="empty card"><div class="ico">🔎</div>未找到与「{{ q }}」匹配的文档</div>
    <div v-else class="empty card"><div class="ico">🔍</div>输入关键词开始全局搜索</div>
  </div>
</template>

<style scoped>
.search-page { max-width: 760px; margin: 0 auto; }
.head h2 { margin: 0 0 16px; }
.bar { display: flex; gap: 10px; }
.bar input { flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; outline: none; }
.bar input:focus { border-color: var(--primary); }
.filters { display: flex; align-items: center; gap: 10px; margin: 14px 0; }
.sel { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.count { color: var(--text-3); font-size: 13px; margin-left: auto; }
.results { display: flex; flex-direction: column; gap: 12px; }
.result { padding: 16px 20px; cursor: pointer; }
.result:hover { border-color: var(--primary); box-shadow: var(--shadow); }
.r-title { font-weight: 700; font-size: 16px; margin-bottom: 4px; }
.r-title-line { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.r-title-line .r-title { margin-bottom: 0; }
.rv-badge { font-size: 11px; background: #fef3c7; color: #b45309; border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.fresh-badge { font-size: 11px; background: #cffafe; color: #0e7490; border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.r-cat { color: var(--text-3); font-size: 12px; margin-bottom: 6px; }
.r-snippet { color: var(--text-2); font-size: 13px; margin-bottom: 10px; }
.r-tags { display: flex; gap: 6px; }
</style>