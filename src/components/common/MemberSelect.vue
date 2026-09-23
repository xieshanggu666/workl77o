<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { avatarColor } from '@/utils/format'

// @提及输入框：v-model 双向绑定文本，输入 @ 弹出成员下拉，选择后插入 @name
const props = defineProps({ modelValue: { type: String, default: '' } })
const emit = defineEmits(['update:modelValue', 'mention'])

const auth = useAuthStore()

const text = ref(props.modelValue)
const open = ref(false)
const filter = ref('')
const pos = ref({ top: 0, left: 0 })
const atPtr = ref(-1)

const candidates = computed(() => {
  let list = auth.users.filter((u) => u.id !== auth.user?.id)
  if (filter.value) list = list.filter((u) => u.name.includes(filter.value))
  return list
})

function sync() { emit('update:modelValue', text.value) }

function onInput(e) {
  const val = e.target.value
  text.value = val
  sync()
  const at = val.lastIndexOf('@')
  if (at >= 0 && at === val.length - 1) { open.value = true; filter.value = ''; overlay(e) }
  else if (open.value && at >= 0) filter.value = val.slice(at + 1)
  if (at < 0) open.value = false
}

function onKeydown(e) {
  if (!open.value) return
  if (e.key === 'ArrowDown') { e.preventDefault(); atPtr.value = (atPtr.value + 1 + candidates.value.length) % candidates.value.length }
  else if (e.key === 'ArrowUp') { e.preventDefault(); atPtr.value = (atPtr.value - 1 + candidates.value.length) % candidates.value.length }
  else if (e.key === 'Escape') { open.value = false }
  else if (e.key === 'Enter' || e.key === 'Tab') {
    if (atPtr.value >= 0 && candidates.value[atPtr.value]) { e.preventDefault(); pick(candidates.value[atPtr.value]) }
  }
}

function pick(u) {
  const at = text.value.lastIndexOf('@')
  text.value = text.value.slice(0, Math.max(0, at)) + '@' + u.name + ' '
  sync()
  open.value = false; filter.value = ''; atPtr.value = -1
  emit('mention', u.id)
}

function overlay(e) {
  const r = e.target.getBoundingClientRect()
  pos.value = { top: r.top - 200 + 14, left: r.left }
}

function onBlur() { setTimeout(() => { open.value = false }, 150) }
onBeforeUnmount(() => {})
</script>

<template>
  <div class="member-select">
    <textarea
      :value="text"
      rows="2"
      placeholder="写下评论，输入 @ 提及成员…"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
    ></textarea>
    <transition name="fade">
      <div v-if="open" class="mention-pop" :style="{ top: pos.top + 'px', left: pos.left + 'px' }">
        <div v-for="(u, i) in candidates" :key="u.id" class="item" :class="{ sel: i === atPtr }" @mousedown.prevent="pick(u)">
          <span class="ava" :style="{ background: avatarColor(u.name) }">{{ u.avatar }}</span>
          <span class="nm">{{ u.name }}</span>
          <span class="em">{{ u.title }}</span>
        </div>
        <div v-if="!candidates.length" class="none">无匹配成员</div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
textarea {
  width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  resize: vertical; font-size: 13px; outline: none; background: var(--panel-2);
}
textarea:focus { border-color: var(--primary); background: #fff; }
.mention-pop {
  position: fixed; width: 260px; background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius-sm); box-shadow: var(--shadow); padding: 6px; z-index: 90;
}
.item { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; cursor: pointer; }
.item.sel, .item:hover { background: var(--primary-weak); }
.ava { width: 26px; height: 26px; border-radius: 50%; color: #fff; font-size: 11px; display: grid; place-items: center; }
.nm { font-weight: 600; font-size: 13px; }
.em { color: var(--text-3); font-size: 12px; margin-left: auto; }
.none { padding: 8px; color: var(--text-3); text-align: center; font-size: 12px; }
</style>