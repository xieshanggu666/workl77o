<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useEngagementStore } from '@/stores/engagement'
import { useReviewStore } from '@/stores/review'
import { useGapStore } from '@/stores/gap'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useHandoverStore } from '@/stores/handover'
import { useRetirementStore } from '@/stores/retirement'
import { canEditContent, canViewDoc, roleLabel } from '@/utils/permission'
import { avatarColor } from '@/utils/format'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const engagement = useEngagementStore()
const reviewStore = useReviewStore()
const gapStore = useGapStore()
const accessStore = useAccessStore()
const freshnessStore = useFreshnessStore()
const handoverStore = useHandoverStore()
const retirementStore = useRetirementStore()

// 侧栏各文档列表统一过权限：授权撤销/到期后标题也不再从最近浏览/收藏/协作入口泄露
function visible(d) {
  return d && canViewDoc(d, auth.user?.id, null, accessStore.grantOf(d.id, auth.user?.id))
}

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))

// 待我审批的访问申请数（侧边栏角标）
const accessPending = computed(() =>
  accessStore.pendingForApprover(auth.user?.id, auth.user?.role, kb.docs).length
)

// 待我确认的交接 + （管理员）待批准的交接（侧边栏角标）
const handoverPending = computed(() =>
  handoverStore.pendingCountFor(auth.user?.id, auth.user?.role)
)

// （管理员）待审批的知识退役申请（侧边栏角标）
const retirementPending = computed(() =>
  retirementStore.pendingCountFor(auth.user?.role)
)

const catCounts = computed(() => {
  const m = {}
  // 分类角标同样按当前身份过滤，避免访客从计数推断受限文档的存在与数量
  kb.docs.filter(visible).forEach((d) => { m[d.categoryId] = (m[d.categoryId] || 0) + 1 })
  return m
})

const activeCat = computed(() => route.query.cat || 'all')
const activeTag = computed(() => route.query.tag || '')

const recents = computed(() =>
  engagement.recentViews.map((r) => docById.value[r.docId]).filter(visible).slice(0, 5)
)
const favDocs = computed(() =>
  engagement.favorites.map((f) => docById.value[f.docId]).filter(visible)
)
const collabDocs = computed(() =>
  kb.docs.filter((d) => visible(d) && (d.editors?.length || 0) > 1).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 5)
)

function go(path, query) {
  router.push({ path, query })
}
function goDoc(id) {
  router.push('/docs/' + id)
}
</script>

<template>
  <aside class="sidebar">
    <nav class="links">
      <div class="link" :class="{ on: route.name === 'dashboard' }" @click="go('/', {})">🏠 首页总览</div>
      <div class="link" :class="{ on: route.name === 'qa' }" @click="go('/qa', {})">🤖 智能问答</div>
      <div class="link" :class="{ on: route.name === 'search' }" @click="go('/search', {})">🔍 全局搜索</div>
      <div class="link" :class="{ on: route.name === 'reviewCenter' }" @click="go('/reviews', {})">
        🧾 评审中心<span v-if="reviewStore.pendingCount" class="link-badge">{{ reviewStore.pendingCount }}</span>
      </div>
      <div class="link" :class="{ on: route.name === 'gapTickets' }" @click="go('/gaps', {})">
        📮 缺口工单<span v-if="gapStore.openCount" class="link-badge">{{ gapStore.openCount }}</span>
      </div>
      <div class="link" :class="{ on: route.name === 'accessCenter' }" @click="go('/access', {})">
        🔑 访问授权<span v-if="accessPending" class="link-badge">{{ accessPending }}</span>
      </div>
      <div class="link" :class="{ on: route.name === 'freshnessCenter' }" @click="go('/freshness', {})">
        🧊 知识保鲜<span v-if="freshnessStore.pausedCount" class="link-badge fresh-badge">{{ freshnessStore.pausedCount }}</span>
      </div>
      <div class="link" :class="{ on: route.name === 'handoverCenter' }" @click="go('/handover', {})">
        🤝 责任交接<span v-if="handoverPending" class="link-badge">{{ handoverPending }}</span>
      </div>
      <div class="link" :class="{ on: route.name === 'retirementCenter' }" @click="go('/retirements', {})">
        🗄 知识退役<span v-if="retirementPending" class="link-badge">{{ retirementPending }}</span>
      </div>
      <div class="link" :class="{ on: route.name === 'profile' }" @click="go('/profile', {})">⚙️ 账号与权限</div>
    </nav>

    <div class="section">
      <div class="section-title">分类</div>
      <div class="cat" :class="{ on: activeCat === 'all' }" @click="go('/docs', {})">全部文档</div>
      <div v-for="c in kb.categories" :key="c.id" class="cat" :class="{ on: activeCat === c.id }" @click="go('/docs', { cat: c.id })">
        <span class="ico">{{ c.icon === 'code' ? '⌨' : c.icon === 'box' ? '▧' : c.icon === 'server' ? '▣' : '♥' }}</span>
        {{ c.name }} <em>{{ catCounts[c.id] || 0 }}</em>
      </div>
    </div>

    <div class="section">
      <div class="section-title">标签</div>
      <div class="tags">
        <span v-for="t in kb.tags" :key="t.id" class="tag" :style="{ background: activeTag === t.id ? t.color : 'transparent', color: activeTag === t.id ? '#fff' : '', borderColor: t.color }"
              @click="go('/docs', activeTag === t.id ? {} : { tag: t.id })">
          # {{ t.name }}
        </span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">最近协作</div>
      <div v-for="d in collabDocs" :key="d.id" class="mini" @click="goDoc(d.id)">
        <span class="mini-title">{{ d.title }}</span>
        <span class="mini-meta">
          <span class="avatars">
            <span v-for="ed in d.editors.slice(0, 3)" :key="ed" class="mini-ava" :style="{ background: avatarColor(ed) }">{{ ed.slice(0, 1) }}</span>
          </span>
        </span>
      </div>
      <div v-if="!collabDocs.length" class="mini-empty">暂无协作文档</div>
    </div>

    <div class="section">
      <div class="section-title">☆ 收藏</div>
      <div v-for="d in favDocs" :key="d.id" class="mini" @click="goDoc(d.id)">{{ d.title }}</div>
      <div v-if="!favDocs.length" class="mini-empty">暂无收藏</div>
    </div>

    <div class="section">
      <div class="section-title">最近浏览</div>
      <div v-for="d in recents" :key="d.id" class="mini" @click="goDoc(d.id)">{{ d.title }}</div>
      <div v-if="!recents.length" class="mini-empty">暂无浏览记录</div>
    </div>

    <div class="foot-role">
      当前身份：<b>{{ auth.user?.name }}</b>（{{ roleLabel(auth.user?.role) }}）
      <span v-if="canEditContent(auth.user?.role)" class="edit-tip">可编辑</span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 250px; min-width: 250px; border-right: 1px solid var(--border);
  background: var(--panel); overflow: auto; padding: 14px 12px 20px;
}
.links { display: flex; flex-direction: column; gap: 2px; margin-bottom: 14px; }
.link {
  padding: 9px 12px; border-radius: var(--radius-sm); cursor: pointer; color: var(--text-2);
  font-weight: 500; transition: all 0.15s;
}
.link:hover { background: var(--panel-2); }
.link.on { background: var(--primary-weak); color: var(--primary); }
.link { position: relative; }
.link-badge { margin-left: 6px; background: var(--danger); color: #fff; font-size: 11px; border-radius: 999px; padding: 0 7px; min-width: 18px; height: 16px; display: inline-grid; place-items: center; }
.link-badge.fresh-badge { background: #0e7490; }

.section { margin: 4px 0 14px; }
.section-title { font-size: 12px; color: var(--text-3); padding: 0 12px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
.cat { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: var(--radius-sm); cursor: pointer; color: var(--text-2); }
.cat .ico { width: 16px; text-align: center; }
.cat em { margin-left: auto; font-style: normal; color: var(--text-3); font-size: 12px; }
.cat:hover { background: var(--panel-2); }
.cat.on { background: var(--primary-weak); color: var(--primary); font-weight: 600; }

.tags { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px; }
.tag { font-size: 12px; padding: 2px 9px; border-radius: 999px; cursor: pointer; border: 1px solid transparent; }

.mini { padding: 6px 12px; border-radius: var(--radius-sm); cursor: pointer; color: var(--text); font-size: 13px; line-height: 1.4; }
.mini:hover { background: var(--panel-2); }
.mini-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.mini-meta { display: flex; margin-top: 3px; }
.avatars { display: flex; }
.mini-ava { width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 10px; display: grid; place-items: center; margin-left: -5px; border: 2px solid var(--panel); }
.mini-ava:first-child { margin-left: 0; }
.mini-empty { padding: 6px 12px; color: var(--text-3); font-size: 12px; }

.foot-role { margin-top: 10px; padding: 10px 12px; background: var(--panel-2); border-radius: var(--radius-sm); font-size: 12px; color: var(--text-2); }
.edit-tip { color: var(--accent); margin-left: 4px; }
</style>