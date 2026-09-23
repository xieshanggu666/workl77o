<script setup>
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useEngagementStore } from '@/stores/engagement'
import { roleLabel, canEditContent } from '@/utils/permission'
import { avatarColor, formatDate } from '@/utils/format'

const auth = useAuthStore()
const engagement = useEngagementStore()
const switched = ref(false)

const current = computed(() => auth.user)

async function switchRole(role) {
  await auth.loginAsRole(role)
  await engagement.load(auth.user?.id)
  switched.value = true
  setTimeout(() => { switched.value = false }, 1800)
}

const roleDesc = {
  admin: '管理全部内容、成员与权限，可删除任意文档。',
  editor: '可创建、编辑文档，管理个人浏览与收藏。',
  viewer: '只读访问，仅能浏览与搜索，不能新建或修改。'
}
</script>

<template>
  <div class="profile">
    <div class="card me">
      <span class="avatar" :style="{ background: avatarColor(current?.name) }">{{ current?.avatar }}</span>
      <div class="info">
        <div class="name">{{ current?.name }}</div>
        <div class="email">{{ current?.email }}</div>
        <div class="title-x">{{ current?.title }}</div>
      </div>
      <div class="role-now">当前角色：<b>{{ roleLabel(current?.role) }}</b></div>
    </div>

    <div class="card section">
      <h3>切换演示角色</h3>
      <p class="hint">为演示权限差异，可实时切换到不同角色；切换后权限立即生效，页面导航与按钮将随之受控。</p>
      <div class="roles">
        <div v-for="r in ['admin', 'editor', 'viewer']" :key="r" class="role" :class="{ on: current?.role === r }" @click="switchRole(r)">
          <div class="r-name">{{ roleLabel(r) }}</div>
          <div class="r-desc">{{ roleDesc[r] }}</div>
          <span v-if="current?.role === r" class="check">✓ 当前</span>
        </div>
      </div>
      <div v-if="switched" class="switched">已切换到 {{ roleLabel(current?.role) }} 身份</div>
    </div>

    <div class="card section">
      <h3>团队知识库成员</h3>
      <div v-for="u in auth.users" :key="u.id" class="member">
        <span class="ava" :style="{ background: avatarColor(u.name) }">{{ u.avatar }}</span>
        <span class="m-name">{{ u.name }}</span>
        <span class="m-title">{{ u.title }}</span>
        <span class="pill">{{ roleLabel(u.role) }}</span>
      </div>
    </div>

    <div class="card section">
      <h3>我能做什么</h3>
      <ul class="can">
        <li>新增 / 编辑 / 删除文档：{{ canEditContent(current?.role) ? '✔ 允许' : '✘ 不允许' }}</li>
        <li>浏览公开与团队文档：✔ 允许</li>
        <li>评论与 @ 提及：✔ 允许</li>
        <li>管理分享链接：{{ canEditContent(current?.role) ? '✔ 允许' : '✘ 不允许' }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.profile { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.me { display: flex; align-items: center; gap: 16px; padding: 24px; }
.avatar { width: 60px; height: 60px; border-radius: 50%; color: #fff; font-size: 26px; display: grid; place-items: center; font-weight: 700; }
.info { flex: 1; }
.name { font-size: 20px; font-weight: 700; }
.email { color: var(--text-3); font-size: 13px; }
.title-x { color: var(--text-2); font-size: 13px; margin-top: 2px; }
.role-now { color: var(--text-2); font-size: 14px; }
.section { padding: 22px 24px; }
.section h3 { margin: 0 0 8px; }
.hint { color: var(--text-2); font-size: 13px; margin: 0 0 16px; }
.roles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.role { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; cursor: pointer; position: relative; transition: all 0.15s; }
.role:hover { border-color: var(--primary); }
.role.on { border-color: var(--primary); background: var(--primary-weak); }
.r-name { font-weight: 700; margin-bottom: 6px; }
.r-desc { color: var(--text-2); font-size: 12px; }
.check { position: absolute; top: 12px; right: 12px; color: var(--primary); font-weight: 700; font-size: 13px; }
.switched { margin-top: 12px; color: var(--accent); font-weight: 600; }
.member { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--panel-2); }
.member:last-child { border-bottom: none; }
.ava { width: 36px; height: 36px; border-radius: 50%; color: #fff; display: grid; place-items: center; font-weight: 600; }
.m-name { font-weight: 600; width: 90px; }
.m-title { flex: 1; color: var(--text-2); font-size: 13px; }
.can { padding-left: 20px; line-height: 2; color: var(--text); }
</style>