<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useAccessStore } from '@/stores/access'
import { useRetirementStore } from '@/stores/retirement'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, avatarColor } from '@/utils/format'
import { canEditContent, canViewDoc, roleLabel } from '@/utils/permission'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const accessStore = useAccessStore()
const retirementStore = useRetirementStore()
retirementStore.loadAll()

const viewMode = ref('cards') // cards | list

const filtered = computed(() => {
  let list = kb.docs.filter(() => true)
  const cat = route.query.cat
  const tag = route.query.tag
  if (cat && cat !== 'all') list = list.filter((d) => d.categoryId === cat)
  if (tag) list = list.filter((d) => (d.tagIds || []).includes(tag))
  // 权限：只显示当前用户可查看的（含有效期内的访问授权；撤销/到期后立即从列表消失）
  list = list.filter((d) => canViewDoc(d, auth.user?.id, null, accessStore.grantOf(d.id, auth.user?.id)))
  // 排序：最近更新优先
  return [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
})

const activeCat = computed(() => route.query.cat || 'all')
const activeTagName = computed(() => (route.query.tag ? kb.tagMap[route.query.tag]?.name : ''))

function clearFilter() { router.push({ path: '/docs' }) }

function ownerName(id) { return kb.catMap[id]?.name }
</script>

<template>
  <div class="list-page">
    <header class="head">
      <div>
        <h2>文档库</h2>
        <div class="crumbs">
          <span class="crumb" :class="{ on: activeCat === 'all' }" @click="router.push({ path: '/docs' })">全部</span>
          <span v-for="c in kb.categories" :key="c.id" class="crumb" :class="{ on: activeCat === c.id }" @click="router.push({ path: '/docs', query: { cat: c.id } })">{{ c.name }}</span>
        </div>
        <div v-if="route.query.tag" class="tag-f" >标签：#{{ activeTagName }} <button class="btn sm ghost" @click="clearFilter">× 清除</button></div>
      </div>
      <div class="head-right">
        <div class="seg">
          <button :class="{ on: viewMode === 'cards' }" @click="viewMode = 'cards'">▦ 卡片</button>
          <button :class="{ on: viewMode === 'list' }" @click="viewMode = 'list'">☰ 列表</button>
        </div>
        <button v-if="canEditContent(auth.user?.role)" class="btn primary" @click="router.push('/docs/new')">＋ 新建</button>
      </div>
    </header>

    <p v-if="route.query.denied" class="notice">当前角色（{{ roleLabel(auth.user?.role) }}）无编辑权限，已切换为浏览模式。</p>

    <div v-if="filtered.length" class="cards" :class="viewMode">
      <div v-for="d in filtered" :key="d.id" class="doc card" :class="{ retired: retirementStore.activeRetirementOfDoc(d.id) }" @click="router.push('/docs/' + d.id)">
        <div class="doc-title">{{ d.title }}</div>
        <div class="doc-body" v-html="d.body.slice(0, 300)"></div>
        <div class="doc-pills"><DocPill :doc="d" /></div>
        <div class="doc-meta">
          <span class="authors">
            <span v-for="ed in d.editors.slice(0, 3)" :key="ed" class="ava" :style="{ background: avatarColor(ed) }">{{ ed.slice(0, 1) }}</span>
          </span>
          <span class="time">{{ formatDate(d.updatedAt) }}</span>
        </div>
      </div>
    </div>

    <div v-else class="empty card"><div class="ico">🗂</div>暂无文档<button class="btn sm" @click="clearFilter">清除筛选</button></div>
  </div>
</template>

<style scoped>
.list-page { max-width: 980px; margin: 0 auto; }
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
.head h2 { margin: 0 0 10px; }
.crumbs { display: flex; gap: 8px; flex-wrap: wrap; }
.crumb { padding: 3px 12px; border-radius: 999px; cursor: pointer; color: var(--text-2); font-size: 13px; border: 1px solid transparent; }
.crumb:hover { background: var(--panel-2); }
.crumb.on { background: var(--primary); color: #fff; }
.tag-f { margin-top: 8px; color: var(--text-2); font-size: 13px; display: flex; align-items: center; gap: 8px; }
.head-right { display: flex; align-items: center; gap: 10px; }
.seg { display: flex; background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.seg button { border: none; background: transparent; padding: 6px 12px; cursor: pointer; color: var(--text-3); font-size: 13px; }
.seg button.on { background: var(--panel); color: var(--primary); font-weight: 600; box-shadow: inset 0 -2px 0 var(--primary); }
.notice { background: var(--warn); color: #fff; padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.cards.list { grid-template-columns: 1fr; }
.doc { padding: 16px; cursor: pointer; display: flex; flex-direction: column; gap: 10px; }
.cards.list .doc { flex-direction: row; align-items: center; }
.cards.list .doc-body { display: none; }
.doc:hover { border-color: var(--primary); box-shadow: var(--shadow); }
.doc.retired { opacity: 0.62; background: var(--panel-2); }
.doc.retired:hover { border-color: #94a3b8; }
.doc-title { font-weight: 600; font-size: 15px; }
.cards.list .doc-title { flex: 1; }
.doc-body { color: var(--text-2); font-size: 13px; max-height: 56px; overflow: hidden; }
.doc-meta { display: flex; align-items: center; justify-content: space-between; margin-top: auto; }
.authors { display: flex; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 11px; display: grid; place-items: center; margin-left: -6px; border: 2px solid #fff; }
.ava:first-child { margin-left: 0; }
.time { color: var(--text-3); font-size: 12px; }
</style>