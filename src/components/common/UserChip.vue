<script setup>
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { avatarColor } from '@/utils/format'
import { roleLabel } from '@/utils/permission'

const auth = useAuthStore()
const u = computed(() => auth.user)
</script>

<template>
  <div class="userchip" :title="(u?.email || '') + ' · ' + roleLabel(u?.role)">
    <span class="avatar" :style="{ background: avatarColor(u?.name || '') }">{{ u?.avatar || '?' }}</span>
    <span class="meta">
      <span class="name">{{ u?.name || '访客' }}</span>
      <span class="role">{{ roleLabel(u?.role) }}</span>
    </span>
  </div>
</template>

<style scoped>
.userchip { display: flex; align-items: center; gap: 9px; cursor: default; }
.avatar { width: 36px; height: 36px; border-radius: 50%; color: #fff; display: grid; place-items: center; font-size: 14px; font-weight: 600; }
.meta { display: flex; flex-direction: column; line-height: 1.2; }
.name { font-weight: 600; font-size: 13px; }
.role { color: var(--text-3); font-size: 12px; }
</style>