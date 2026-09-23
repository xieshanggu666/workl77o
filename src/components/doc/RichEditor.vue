<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'stats'])

const editor = ref(null)
const mode = ref('edit') // edit | preview
const active = ref({ b: false, i: false, ul: false, ol: false, block: 'p' })
const fileInput = ref(null)

function ensureEmpty() {
  if (!editor.value.innerHTML.trim()) editor.value.innerHTML = '<p><br></p>'
}

function useCmd(cmd, val) {
  editor.value.focus()
  document.execCommand(cmd, false, val)
  emitChange()
  refreshState()
}

function formatBlock(block) {
  document.execCommand('formatBlock', false, block)
  emitChange()
  refreshState()
}

function insertCode() {
  const sel = window.getSelection()
  const text = sel && sel.rangeCount ? sel.getRangeAt(0).toString() : ''
  const html = '<pre><code>' + (text || 'your code') + '</code></pre><p><br></p>'
  document.execCommand('insertHTML', false, html)
  emitChange()
}

function insertQuote() {
  document.execCommand('formatBlock', false, 'blockquote')
  emitChange()
  refreshState()
}

function addLink() {
  const url = prompt('请输入链接地址：', 'https://')
  if (url) document.execCommand('createLink', false, url)
  emitChange()
}

function onFile(e) {
  const file = e.target.files[0]
  if (!file) return
  if (file.size > 800 * 1024) { alert('图片过大，请压缩到 800KB 以内'); return }
  const reader = new FileReader()
  reader.onload = () => {
    document.execCommand('insertHTML', false, '<p><img src="' + reader.result + '" style="max-width:100%"/></p>')
    emitChange()
  }
  reader.readAsDataURL(file)
}

function refreshState() {
  try {
    active.value = {
      b: document.queryCommandState('bold'),
      i: document.queryCommandState('italic'),
      ul: document.queryCommandState('insertUnorderedList'),
      ol: document.queryCommandState('insertOrderedList'),
      block: document.queryCommandValue('formatBlock') || 'p'
    }
  } catch (e) { /* noop */ }
}

function emitChange() {
  emit('update:modelValue', editor.value.innerHTML)
}

function emitStats() {
  const text = editor.value.innerText || ''
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const chars = text.length
  const imgs = editor.value.querySelectorAll('img').length
  emit('stats', { chars, words, imgs })
}

watch(() => props.modelValue, (v) => {
  if (editor.value && v !== editor.value.innerHTML) {
    editor.value.innerHTML = v || '<p><br></p>'
  }
})

onMounted(() => {
  editor.value.innerHTML = props.modelValue || '<p><br></p>'
  document.addEventListener('selectionchange', onSelection)
})
function onSelection() {
  const contentEditable = document.activeElement === editor.value
  if (contentEditable) refreshState()
}
onBeforeUnmount(() => { document.removeEventListener('selectionchange', onSelection) })

defineExpose({ emitStats })
</script>

<template>
  <div class="rich">
    <div class="toolbar" :class="{ disabled }">
      <select :value="active.block" class="block-select" :disabled="disabled" @change="formatBlock($event.target.value)">
        <option value="p">正文</option>
        <option value="H1">标题 1</option>
        <option value="H2">标题 2</option>
        <option value="H3">标题 3</option>
      </select>
      <span class="sep"></span>
      <button type="button" class="tb" :class="{ on: active.b }" :disabled="disabled" title="加粗" @click="useCmd('bold')"><b>B</b></button>
      <button type="button" class="tb" :class="{ on: active.i }" :disabled="disabled" title="斜体" @click="useCmd('italic')"><i>I</i></button>
      <button type="button" class="tb" :class="{ on: active.ul }" :disabled="disabled" title="无序列表" @click="useCmd('insertUnorderedList')">• 列表</button>
      <button type="button" class="tb" :class="{ on: active.ol }" :disabled="disabled" title="有序列表" @click="useCmd('insertOrderedList')">1. 列表</button>
      <button type="button" class="tb" :disabled="disabled" title="代码块" @click="insertCode">&lt;/&gt;</button>
      <button type="button" class="tb" :disabled="disabled" title="引用" @click="insertQuote">❝</button>
      <button type="button" class="tb" :disabled="disabled" title="链接" @click="addLink">🔗</button>
      <button type="button" class="tb" :disabled="disabled" title="插入图片" @click="fileInput.click()">🖼</button>
      <span class="sep"></span>
      <div class="mode-toggle">
        <span class="mode" :class="{ on: mode === 'edit' }" @click="!disabled && (mode = 'edit')">编辑</span>
        <span class="mode" :class="{ on: mode === 'preview' }" @click="mode = 'preview'">预览</span>
      </div>
    </div>

    <div v-show="mode === 'edit'" ref="editor" class="editable" :contenteditable="!disabled" :class="{ locked: disabled }" @input="emitChange"></div>
    <div v-show="mode === 'preview'" class="preview-body" v-html="modelValue"></div>

    <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onFile" />
  </div>
</template>

<style scoped>
.rich { border: 1px solid var(--border); border-radius: var(--radius); background: #fff; overflow: hidden; }
.toolbar { display: flex; align-items: center; gap: 4px; padding: 8px 10px; background: var(--panel-2); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.block-select { border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; font-size: 12px; background: #fff; }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
.tb { border: none; background: transparent; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tb:hover { background: #fff; }
.tb.on { background: var(--primary-weak); color: var(--primary); }
.mode-toggle { margin-left: auto; display: flex; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.mode { padding: 3px 12px; cursor: pointer; font-size: 12px; color: var(--text-3); }
.mode.on { background: var(--primary); color: #fff; }

.editable { min-height: 320px; padding: 16px 18px; outline: none; }
.editable :deep(h1), .preview-body :deep(h1) { font-size: 26px; margin: 12px 0 8px; }
.editable :deep(h2), .preview-body :deep(h2) { font-size: 21px; margin: 12px 0 8px; }
.editable :deep(h3), .preview-body :deep(h3) { font-size: 17px; margin: 10px 0 6px; }
.editable :deep(p), .preview-body :deep(p) { margin: 6px 0; }
.editable :deep(pre), .preview-body :deep(pre) { background: #1f2733; color: #dff2ff; padding: 12px 14px; border-radius: 8px; overflow: auto; }
.editable :deep(code), .preview-body :deep(code) { font-family: Menlo, Consolas, monospace; font-size: 13px; }
.editable :deep(blockquote), .preview-body :deep(blockquote) { border-left: 3px solid var(--primary); margin: 8px 0; padding: 4px 12px; color: var(--text-2); background: var(--primary-weak); }
.editable :deep(ul), .editable :deep(ol), .preview-body :deep(ul), .preview-body :deep(ol) { padding-left: 24px; }
.editable :deep(img) { max-width: 100%; border-radius: 6px; }
.preview-body { min-height: 320px; padding: 16px 18px; }
.toolbar.disabled { opacity: 0.6; }
.tb:disabled, .block-select:disabled { cursor: not-allowed; }
.editable.locked { background: var(--panel-2); color: var(--text-2); cursor: not-allowed; }
</style>