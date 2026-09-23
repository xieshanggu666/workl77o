import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { canEditContent } from '@/utils/permission'

const routes = [
  { path: '/', name: 'dashboard', component: () => import('@/views/Dashboard.vue'), meta: { title: '首页' } },
  { path: '/docs', name: 'docList', component: () => import('@/views/DocList.vue'), meta: { title: '文档库' } },
  { path: '/docs/new', name: 'docNew', component: () => import('@/views/DocEditor.vue'), meta: { title: '新建文档', requiresEdit: true } },
  { path: '/docs/:id', name: 'docDetail', component: () => import('@/views/DocDetail.vue'), meta: { title: '文档详情' } },
  // 编辑页不做角色级拦截：持「限时协作」授权的只读成员也可进入，具体编辑权限由编辑器按文档+授权校验
  { path: '/docs/:id/edit', name: 'docEdit', component: () => import('@/views/DocEditor.vue'), meta: { title: '编辑文档' } },
  { path: '/search', name: 'search', component: () => import('@/views/SearchResults.vue'), meta: { title: '搜索' } },
  { path: '/reviews', name: 'reviewCenter', component: () => import('@/views/ReviewCenter.vue'), meta: { title: '评审中心' } },
  { path: '/gaps', name: 'gapTickets', component: () => import('@/views/GapTickets.vue'), meta: { title: '缺口工单' } },
  { path: '/access', name: 'accessCenter', component: () => import('@/views/AccessCenter.vue'), meta: { title: '访问授权' } },
  { path: '/freshness', name: 'freshnessCenter', component: () => import('@/views/FreshnessCenter.vue'), meta: { title: '知识保鲜' } },
  { path: '/handover', name: 'handoverCenter', component: () => import('@/views/HandoverCenter.vue'), meta: { title: '责任交接' } },
  { path: '/retirements', name: 'retirementCenter', component: () => import('@/views/RetirementCenter.vue'), meta: { title: '知识退役' } },
  { path: '/qa', name: 'qa', component: () => import('@/views/QAAssistant.vue'), meta: { title: '智能问答' } },
  { path: '/share/:token', name: 'share', component: () => import('@/views/ShareView.vue'), meta: { title: '共享文档' } },
  { path: '/profile', name: 'profile', component: () => import('@/views/ProfileSettings.vue'), meta: { title: '账号与权限' } },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  }
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  document.title = (to.meta.title ? to.meta.title + ' · ' : '') + '智汇 · 团队知识库'
  if (to.meta.requiresEdit) {
    const role = auth.user?.role || 'viewer'
    if (!canEditContent(role)) {
      // 无编辑权限：跳回文档库并提示
      return { name: 'docList', query: { denied: '1' } }
    }
  }
  return true
})

export default router