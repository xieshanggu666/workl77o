<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import UserChip from '@/components/common/UserChip.vue'

const router = useRouter()
const q = ref('')
const ask = ref('')

function submitSearch() {
  const kw = q.value.trim()
  if (!kw) return
  router.push({ name: 'search', query: { q: kw } })
}

function submitAsk() {
  const kw = ask.value.trim()
  if (!kw) return
  router.push({ name: 'qa', query: { q: kw } })
}
</script>

<template>
  <header class="topbar">
    <div class="brand" @click="router.push('/')">
      <span class="logo">◆</span>
      <span class="brand-name">智汇 · 知识库</span>
    </div>

    <div class="search">
      <input v-model="q" placeholder="全局搜索：标题 / 正文 / 标签…" @keyup.enter="submitSearch" />
      <button class="btn sm" @click="submitSearch">搜索</button>
    </div>

    <div class="ask">
      <input v-model="ask" placeholder="向知识库提问…" @keyup.enter="submitAsk" />
      <button class="btn sm primary" @click="submitAsk">问答</button>
    </div>

    <UserChip />
  </header>
</template>

<style scoped>
.topbar {
  height: 58px; display: flex; align-items: center; gap: 16px;
  padding: 0 24px; background: var(--panel); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 30;
}
.brand { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.logo { width: 30px; height: 30px; border-radius: 8px; background: var(--primary); color: #fff; display: grid; place-items: center; font-size: 15px; }
.brand-name { font-weight: 700; font-size: 16px; }
.search, .ask { display: flex; gap: 6px; flex: 1; max-width: 300px; }
.ask { max-width: 240px; }
.search input, .ask input {
  width: 100%; padding: 7px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-size: 13px; background: var(--panel-2); outline: none;
}
.search input:focus, .ask input:focus { border-color: var(--primary); background: #fff; }
</style>