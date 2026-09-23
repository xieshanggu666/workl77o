import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'

export const useEngagementStore = defineStore('engagement', () => {
  const favorites = ref([]) // {docId, id, userId}
  const recentViews = ref([]) // {docId, viewedAt, id, userId}
  const loaded = ref(false)

  async function load(userId) {
    if (loaded.value && favorites.value.length >= 0) {
      await refresh(userId)
      return
    }
    await refresh(userId)
    loaded.value = true
  }

  async function refresh(userId) {
    favorites.value = await db.favorites.where('userId').equals(userId).toArray()
    const rows = await db.recentViews.where('userId').equals(userId).toArray()
    recentViews.value = rows.sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt))
  }

  function isFavorite(docId) {
    return favorites.value.some((f) => f.docId === docId)
  }

  async function toggleFavorite(userId, docId) {
    const existing = favorites.value.find((f) => f.docId === docId && f.userId === userId)
    if (existing) {
      await db.favorites.delete(existing.id)
      favorites.value = favorites.value.filter((f) => f.id !== existing.id)
      return false
    }
    const fav = { id: uid('fav'), userId, docId }
    await db.favorites.add(fav)
    favorites.value.push(fav)
    return true
  }

  async function recordView(userId, docId) {
    const existing = await db.recentViews.where('[userId+docId]').equals([userId, docId]).first()
    const entry = {
      id: existing ? existing.id : uid('rv'),
      userId,
      docId,
      viewedAt: new Date().toISOString()
    }
    await db.recentViews.put(entry)
  }

  const favoriteIds = computed(() => new Set(favorites.value.map((f) => f.docId)))

  return { favorites, recentViews, load, refresh, isFavorite, toggleFavorite, recordView, favoriteIds }
})