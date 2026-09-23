<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useEngagementStore } from '@/stores/engagement'
import { useAccessStore } from '@/stores/access'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, avatarColor } from '@/utils/format'
import { canEditContent, canViewDoc } from '@/utils/permission'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const engagement = useEngagementStore()
const accessStore = useAccessStore()

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
// 仅保留当前用户可查看的文档（含有效限时授权；撤销/到期后从首页各列表收回）
const visibleDocs = computed(() =>
  kb.docs.filter((d) => canViewDoc(d, auth.user?.id, null, accessStore.grantOf(d.id, auth.user?.id)))
)
const stats = computed(() => ({
  docs: visibleDocs.value.length,
  cats: kb.categories.length,
  tags: kb.tags.length,
  members: auth.users.length,
  comments: kb.comments.length
}))
const recents = computed(() => engagement.recentViews.map((r) => docById.value[r.docId]).filter((d) => d && canViewDoc(d, auth.user?.id, null, accessStore.grantOf(d.id, auth.user?.id))).slice(0, 6))
const latest = computed(() => [...visibleDocs.value].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 6))
const collab = computed(() => visibleDocs.value.filter((d) => (d.editors?.length || 0) > 1).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 6))
const catOverview = computed(() => kb.categories.map((c) => ({ c, n: visibleDocs.value.filter((d) => d.categoryId === c.id).length })))
const canEdit = computed(() => canEditContent(auth.user?.role))
</script>

<template>
  <div class="dash">
    <header class="hero">
      <h1>欢迎回来，{{ auth.user?.name }}</h1>
      <p>知识库共沉淀 <b>{{ stats.docs }}</b> 篇文档，与团队成员共建、共享、共答。</p>
      <div class="cta">
        <button v-if="canEdit" class="btn primary" @click="router.push('/docs/new')">＋ 新建文档</button>
        <button class="btn" @click="router.push('/qa')">🤖 去提问</button>
        <button class="btn" @click="router.push('/docs')">浏览文档库</button>
      </div>
    </header>

    <section class="stats">
      <div class="stat card"><span class="num">{{ stats.docs }}</span><span class="lab">文档</span></div>
      <div class="stat card"><span class="num">{{ stats.cats }}</span><span class="lab">分类</span></div>
      <div class="stat card"><span class="num">{{ stats.tags }}</span><span class="lab">标签</span></div>
      <div class="stat card"><span class="num">{{ stats.members }}</span><span class="lab">成员</span></div>
      <div class="stat card"><span class="num">{{ stats.comments }}</span><span class="lab">评论</span></div>
    </section>

    <section class="grid">
      <div class="col">
        <div class="sec-title">最近更新</div>
        <div class="card list">
          <div v-for="d in latest" :key="d.id" class="row" @click="router.push('/docs/' + d.id)">
            <div class="row-main">
              <span class="title">{{ d.title }}</span>
              <DocPill :doc="d" />
            </div>
            <span class="time">{{ formatDate(d.updatedAt) }}</span>
          </div>
        </div>
      </div>

      <div class="col">
        <div class="sec-title">团队成员协作</div>
        <div class="card list">
          <div v-for="d in collab" :key="d.id" class="row" @click="router.push('/docs/' + d.id)">
            <div class="row-main">
              <span class="title">{{ d.title }}</span>
              <span class="avatars">
                <span v-for="ed in d.editors.slice(0, 4)" :key="ed" class="ava" :style="{ background: avatarColor(ed) }">{{ ed.slice(0, 1) }}</span>
                <span class="count">×{{ d.editors.length }}</span>
              </span>
            </div>
            <span class="time">{{ formatDate(d.updatedAt) }}</span>
          </div>
        </div>
      </div>

      <div class="col">
        <div class="sec-title">最近浏览</div>
        <div class="card list">
          <div v-if="!recents.length" class="empty"><div class="ico">🕘</div>浏览过的文档会显示在这里</div>
          <div v-for="d in recents" :key="d.id" class="row" @click="router.push('/docs/' + d.id)">
            <div class="row-main"><span class="title">{{ d.title }}</span><DocPill :doc="d" /></div>
            <span class="time">{{ formatDate(d.updatedAt) }}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="cat-sec">
      <div class="sec-title">按分类浏览</div>
      <div class="cat-grid">
        <div v-for="item in catOverview" :key="item.c.id" class="cat card" @click="router.push({ path: '/docs', query: { cat: item.c.id } })">
          <span class="ico">{{ item.c.icon === 'code' ? '⌨' : item.c.icon === 'box' ? '▧' : item.c.icon === 'server' ? '▣' : '♥' }}</span>
          <span class="cname">{{ item.c.name }}</span>
          <span class="cnum">{{ item.n }} 篇</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dash { max-width: 1080px; margin: 0 auto; }
.hero { padding: 24px 0 12px; }
.hero h1 { margin: 0 0 6px; font-size: 24px; }
.hero p { margin: 0 0 16px; color: var(--text-2); }
.hero p b { color: var(--primary); }
.cta { display: flex; gap: 10px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0; }
.stat { display: flex; align-items: baseline; gap: 8px; padding: 16px 20px; }
.stat .num { font-size: 28px; font-weight: 700; color: var(--primary); }
.stat .lab { color: var(--text-2); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.sec-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 8px; padding-left: 2px; }
.card.list { padding: 4px 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; cursor: pointer; border-bottom: 1px solid var(--panel-2); }
.row:last-child { border-bottom: none; }
.row:hover { background: var(--panel-2); }
.row-main { min-width: 0; }
.title { font-weight: 600; font-size: 14px; display: block; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.time { color: var(--text-3); font-size: 12px; white-space: nowrap; }
.avatars { display: flex; align-items: center; margin-top: 4px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 11px; display: grid; place-items: center; margin-left: -6px; border: 2px solid #fff; }
.ava:first-child { margin-left: 0; }
.count { font-size: 11px; color: var(--text-3); margin-left: 6px; }
.cat-sec { margin: 28px 0; }
.cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.cat { display: flex; align-items: center; gap: 10px; padding: 16px; cursor: pointer; }
.cat:hover { border-color: var(--primary); }
.cat .ico { font-size: 20px; width: 28px; height: 28px; display: grid; place-items: center; background: var(--primary-weak); border-radius: 8px; color: var(--primary); }
.cat .cname { font-weight: 600; flex: 1; }
.cat .cnum { color: var(--text-3); font-size: 12px; }
</style>