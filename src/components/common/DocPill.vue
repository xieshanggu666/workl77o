<script setup>
import { computed } from 'vue'
import { useKbStore } from '@/stores/kb'
import { useReviewStore } from '@/stores/review'
import { useFreshnessStore } from '@/stores/freshness'
import { useRetirementStore } from '@/stores/retirement'
import { FRESH, isFreshnessEnabled, isFreshTicketOpen, cycleDaysLabel, dueText } from '@/utils/freshness'

const props = defineProps({
  doc: { type: Object, required: true }
})
const kb = useKbStore()
const reviewStore = useReviewStore()
const freshnessStore = useFreshnessStore()
const retirementStore = useRetirementStore()

const catName = computed(() => kb.catMap[props.doc.categoryId]?.name || '未分类')
const tags = computed(() => (props.doc.tagIds || []).map((id) => kb.tagMap[id]).filter(Boolean))

// 评审中优先以内存中流转的评审单为准（跨文档列表也能实时反映）
const inReview = computed(() => !!reviewStore.pendingReviewOf(props.doc.id))
const rejectedLast = computed(() => props.doc.lastReview?.status === 'rejected')

// 知识保鲜：流转中复核单（待整改/送审中/已驳回）会暂停问答引用
const freshTicket = computed(() => freshnessStore.activeTicketOf(props.doc.id))
const freshEnabled = computed(() => isFreshnessEnabled(props.doc))
const freshPaused = computed(() => isFreshTicketOpen(freshTicket.value))
const freshLabel = computed(() => {
  if (freshPaused.value) {
    if (freshTicket.value.status === FRESH.SUBMITTED) return '🧊 保鲜复核中'
    if (freshTicket.value.status === FRESH.REJECTED) return '🧊 复核驳回待整改'
    return '🧊 已逾期待复核'
  }
  if (freshEnabled.value) return '❄ ' + cycleDaysLabel(props.doc.freshness.cycleDays)
  return ''
})
const freshTitle = computed(() => {
  if (!freshEnabled.value) return ''
  if (freshPaused.value) return '知识保鲜：第 ' + freshTicket.value.round + ' 轮复核（' + dueText(props.doc, freshTicket.value, freshnessStore.now) + '），问答引用已暂停'
  return '知识保鲜：' + cycleDaysLabel(props.doc.freshness.cycleDays) + '复核，' + dueText(props.doc, null, freshnessStore.now)
})

// 知识退役：生效退役的文档只读归档（搜索/问答已停止）
const retired = computed(() => !!retirementStore.activeRetirementOfDoc(props.doc.id))

const visibilityLabel = { public: '公开', team: '团队', private: '私有' }
</script>

<template>
  <div class="docbadges">
    <span v-if="retired" class="pill rt-retired" title="已退役：停止搜索与问答引用，由替代文档承接">🗄 已退役</span>
    <span v-if="inReview" class="pill rv-review">⏳ 评审中</span>
    <span v-else-if="rejectedLast" class="pill rv-rejected">↩ 已驳回</span>
    <span v-if="freshPaused" class="pill fresh-paused" :title="freshTitle">{{ freshLabel }}</span>
    <span v-else-if="freshEnabled" class="pill fresh-ok" :title="freshTitle">{{ freshLabel }}</span>
    <span class="pill v" :class="'v-' + doc.visibility">{{ visibilityLabel[doc.visibility] || doc.visibility }}</span>
    <span class="pill cat">{{ catName }}</span>
    <span v-for="t in tags" :key="t.id" class="pill tag" :style="{ background: t.color }">{{ t.name }}</span>
  </div>
</template>

<style scoped>
.docbadges { display: flex; flex-wrap: wrap; gap: 6px; }
.v { font-size: 11px; }
.rv-review { background: #b45309; color: #fff; font-size: 11px; }
.rt-retired { background: #64748b; color: #fff; font-size: 11px; }
.rv-rejected { background: var(--danger); color: #fff; font-size: 11px; }
.fresh-paused { background: #0e7490; color: #fff; font-size: 11px; }
.fresh-ok { background: #ecfeff; color: #0e7490; border: 1px solid #a5f3fc; font-size: 11px; }
</style>
