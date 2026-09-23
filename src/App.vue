<script setup>
import { onMounted } from 'vue'
import { useRoute } from 'vue-router'
import TopBar from '@/components/topbar/TopBar.vue'
import SideBar from '@/components/sidebar/SideBar.vue'
import { useAuthStore } from '@/stores/auth'
import { useKbStore } from '@/stores/kb'
import { useEngagementStore } from '@/stores/engagement'
import { useReviewStore } from '@/stores/review'
import { useGapStore } from '@/stores/gap'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useHandoverStore } from '@/stores/handover'
import { useRetirementStore } from '@/stores/retirement'

const route = useRoute()
const auth = useAuthStore()
const kb = useKbStore()
const engagement = useEngagementStore()
const reviewStore = useReviewStore()
const gapStore = useGapStore()
const accessStore = useAccessStore()
const freshnessStore = useFreshnessStore()
const handoverStore = useHandoverStore()
const retirementStore = useRetirementStore()

const isSharePage = () => route.name === 'share'

onMounted(async () => {
  await Promise.all([auth.loadUsers(), kb.loadAll(), reviewStore.loadAll(), gapStore.loadAll(), accessStore.loadAll(), freshnessStore.loadAll(), handoverStore.loadAll(), retirementStore.loadAll()])
  // 默认以管理员登录，便于完整演示；可通过「账号与权限」切换角色
  if (!auth.user) await auth.login('admin')
  await engagement.load(auth.user?.id)
})
</script>

<template>
  <div class="app-shell">
    <div class="body" :class="{ 'is-share': isSharePage() }">
      <TopBar v-if="!isSharePage()" />
      <div class="content">
        <SideBar v-if="!isSharePage()" />
        <main class="main">
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-shell { height: 100%; display: flex; flex-direction: column; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.body.is-share .content { max-width: 860px; margin: 0 auto; }
.content { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.main { flex: 1; overflow: auto; padding: 24px; }
</style>