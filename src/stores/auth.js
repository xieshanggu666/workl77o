import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { ROLE } from '@/utils/permission'

const GUEST = { id: 'u-guest', name: '访客', role: 'viewer', avatar: '?', email: '' }

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const isGuest = ref(true)
  const users = ref([])

  function hasRole(userObj) {
    if (!userObj) return [false, false, true] // [canEdit, canDelete, isViewerOnly]
    const r = userObj.role
    return {
      canEdit: r === ROLE.ADMIN || r === ROLE.EDITOR,
      canDelete: r === ROLE.ADMIN || r === ROLE.EDITOR,
      isAdmin: r === ROLE.ADMIN
    }
  }

  async function loadUsers() {
    if (users.value.length) return users.value
    try {
      users.value = await db.users.toArray()
    } catch {
      users.value = []
    }
    return users.value
  }

  async function login(uidOrRole) {
    await loadUsers()
    const target = users.value.find((u) => u.id === uidOrRole) || users.value.find((u) => u.role === uidOrRole)
    if (target) {
      user.value = { ...target }
      isGuest.value = false
    }
    return user.value
  }

  async function loginAsRole(role) {
    await loadUsers()
    const target = users.value.find((u) => u.role === role)
    user.value = target ? { ...target } : { ...GUEST }
    isGuest.value = false
    return user.value
  }

  function logout() {
    user.value = null
    isGuest.value = true
  }

  const perms = computed(() => hasRole(user.value))

  return { user, isGuest, users, hasRole, loadUsers, login, loginAsRole, logout, perms }
})