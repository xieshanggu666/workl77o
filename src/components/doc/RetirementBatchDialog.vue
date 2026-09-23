<script setup>
// 知识退役 · 批量送审对话框：负责人一次添加多篇文档，为每篇分别选择替代文档，
// 统一提交生成一个退役批次（N 张待审批退役单）。提交前本地逐行预检，提交后以
// store 事务内权威校验结果逐行标红；任一篇不合法整体送审失败。
import { ref, computed, watch, nextTick } from 'vue'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useRetirementStore } from '@/stores/retirement'
import { RETIRE, retireRowErrorLabel } from '@/utils/retirement'

const props = defineProps({
  open: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'submitted'])

const kb = useKbStore()
const auth = useAuthStore()
const retirementStore = useRetirementStore()

// rows: [{ key, docId, replacementDocId, reason, error, title }]
const rows = ref([])
const batchNote = ref('')
const submitting = ref(false)
let seq = 0

// 可作为「旧文档」候选：当前用户可发起退役（负责人/管理员）、未退役、无在途退役、未被他单占用
const oldDocCandidates = computed(() =>
  kb.docs
    .filter((d) => d.ownerId === auth.user?.id || auth.user?.role === 'admin')
    .filter((d) => !retirementStore.activeRetirementOfDoc(d.id) && !retirementStore.openRetirementOfDoc(d.id))
    .filter((d) => !retirementStore.retirementUsingAsReplacement(d.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

// 某篇旧文档对应的替代文档候选：非自身、未退役、无在途退役、未被他单占用、不在本批其他旧文档中
function replacementCandidatesFor(row) {
  const pickedOld = new Set(rows.value.filter((x) => x.docId && x.docId !== row.docId).map((x) => x.docId))
  return kb.docs
    .filter((d) => d.id !== row.docId)
    .filter((d) => !pickedOld.has(d.id))
    .filter((d) => !retirementStore.activeRetirementOfDoc(d.id) && !retirementStore.openRetirementOfDoc(d.id))
    .filter((d) => !retirementStore.retirementUsingAsReplacement(d.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
}

// 已选为旧文档的不可再被其他行选择（同一篇在一批中只出现一次）
function oldOptionsFor(row) {
  const picked = new Set(rows.value.filter((x) => x !== row && x.docId).map((x) => x.docId))
  return oldDocCandidates.value.filter((d) => !picked.has(d.id))
}

const docTitle = (id) => kb.docs.find((d) => d.id === id)?.title || ''

function addRow(docId = '') {
  rows.value.push({ key: ++seq, docId, replacementDocId: '', reason: '', error: null })
}

function removeRow(key) {
  rows.value = rows.value.filter((x) => x.key !== key)
  revalidate()
}

// 本地预检：无需后端即可提示明显错误（与 store checkRetirementBatch 规则保持一致）
function localError(row) {
  if (!row.docId) return null
  if (!row.replacementDocId) return 'bad-replacement'
  if (row.replacementDocId === row.docId) return 'bad-replacement'
  // 批次内替代链：替代文档也在本批旧文档中
  const rep = rows.value.find((x) => x.docId === row.replacementDocId)
  if (rep && rep !== row) return 'replacement-in-batch'
  if (retirementStore.retirementUsingAsReplacement(row.docId)) return 'used-as-replacement'
  if (retirementStore.activeRetirementOfDoc(row.replacementDocId)
    || retirementStore.openRetirementOfDoc(row.replacementDocId)) return 'replacement-retired'
  if (retirementStore.retirementUsingAsReplacement(row.replacementDocId)) {
    // 替代文档被他单占用时也不能承接
    return 'replacement-retired'
  }
  return null
}

function revalidate() {
  for (const row of rows.value) {
    if (row.error) row.error = localError(row)
  }
}

watch(() => props.open, async (v) => {
  if (!v) return
  await Promise.all([kb.loadAll(), retirementStore.loadAll()])
  rows.value = []
  batchNote.value = ''
  addRow()
})

const filledRows = computed(() => rows.value.filter((x) => x.docId))
const hasLocalError = computed(() => filledRows.value.some((x) => localError(x)))
const canSubmit = computed(() => filledRows.value.length > 0 && !hasLocalError.value && !submitting.value)

async function submit() {
  if (submitting.value) return
  // 提交前再次本地预检并标红
  for (const row of rows.value) row.error = row.docId ? localError(row) : null
  if (!filledRows.value.length) { alert('请至少添加一篇要退役的文档。'); return }
  if (hasLocalError.value) { alert('存在配置有误的行（已标红），请修正后再统一送审。'); return }
  submitting.value = true
  try {
    const res = await retirementStore.initiateRetirementBatch({
      rows: filledRows.value.map((x) => ({ docId: x.docId, replacementDocId: x.replacementDocId, reason: x.reason.trim() })),
      note: batchNote.value.trim()
    }, auth.user)
    if (res.status === 'guest') { alert('请先登录后再发起批量退役。'); return }
    if (res.status === 'no-docs') { alert('请至少添加一篇要退役的文档。'); return }
    if (res.status === 'invalid') {
      // 事务内权威校验：逐行回填错误，整体未产生任何退役单
      const byDoc = Object.fromEntries(res.rows.map((x) => [x.docId, x]))
      for (const row of filledRows.value) {
        const sv = byDoc[row.docId]
        row.error = sv?.error || null
      }
      alert('统一送审未通过：已按行标出原因，修正后可重新提交（本次未产生任何退役单）。')
      await nextTick()
      return
    }
    if (res.status === 'ok') {
      alert('已统一送审 ' + res.retirements.length + ' 篇退役申请，等待管理员逐篇审批。')
      emit('submitted', res)
      emit('close')
    } else {
      alert('提交失败，请稍后重试。')
    }
  } finally {
    submitting.value = false
  }
}

function close() { emit('close') }
function errText(row) { return row.error ? retireRowErrorLabel(row.error, { replacementTitle: docTitle(row.replacementDocId) }) : '' }
</script>

<template>
  <div v-if="open" class="batch-mask" @click.self="close">
    <div class="batch-dialog card">
      <header class="bd-head">
        <h3>🗄 批量退役替代 · 统一送审</h3>
        <button class="bd-x" @click="close">✕</button>
      </header>
      <p class="bd-hint">
        添加多篇要退役的文档并为<b>每篇分别指定替代文档</b>，一次统一提交送审；管理员将<b>逐篇批准</b>。
        审批通过后逐篇停止搜索与问答引用、撤销其有效共享链接、把已解决缺口工单的答案来源改挂对应替代文档。
        提交时逐篇校验，任一篇不通过则整批不提交。
      </p>

      <div class="bd-rows">
        <div v-for="(row, i) in rows" :key="row.key" class="bd-row" :class="{ bad: !!row.error }">
          <div class="bd-line">
            <span class="bd-idx">{{ i + 1 }}</span>
            <div class="bd-fields">
              <select v-model="row.docId" class="bd-sel old" @change="row.replacementDocId = ''; row.error = localError(row)">
                <option value="" disabled>选择要退役的文档…</option>
                <option v-for="d in oldOptionsFor(row)" :key="d.id" :value="d.id">《{{ d.title }}》</option>
              </select>
              <span class="bd-arrow">⇒</span>
              <select v-model="row.replacementDocId" class="bd-sel rep" :disabled="!row.docId" @change="revalidate()">
                <option value="" disabled>替代文档…</option>
                <option v-for="d in replacementCandidatesFor(row)" :key="d.id" :value="d.id">《{{ d.title }}》</option>
              </select>
              <button class="bd-del" title="移除该行" @click="removeRow(row.key)">✕</button>
            </div>
          </div>
          <input v-model="row.reason" class="bd-rin" maxlength="200" placeholder="本篇退役原因（可选；留空则使用批次统一原因）" />
          <p v-if="row.error" class="bd-err">⚠ {{ errText(row) }}</p>
        </div>
      </div>

      <button class="btn sm ghost bd-add" @click="addRow()">＋ 添加一篇</button>

      <div class="bd-note">
        <span class="bd-note-k">批次统一原因</span>
        <textarea v-model="batchNote" rows="2" maxlength="300" placeholder="本批退役的统一说明（可选，将写入每篇退役记录）"></textarea>
      </div>

      <footer class="bd-foot">
        <span class="bd-count">已添加 {{ filledRows.length }} 篇<span v-if="hasLocalError" class="bd-warn"> · 存在待修正行</span></span>
        <div class="bd-acts">
          <button class="btn sm ghost" @click="close">取消</button>
          <button class="btn sm primary" :disabled="!canSubmit" @click="submit">{{ submitting ? '提交中…' : '统一送审' }}</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.batch-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 60; display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; overflow-y: auto; }
.batch-dialog { width: 720px; max-width: 100%; padding: 20px 22px; }
.bd-head { display: flex; align-items: center; justify-content: space-between; }
.bd-head h3 { margin: 0; font-size: 16px; }
.bd-x { border: none; background: none; font-size: 15px; color: var(--text-3); cursor: pointer; }
.bd-x:hover { color: var(--danger); }
.bd-hint { font-size: 12px; color: var(--text-3); line-height: 1.7; margin: 10px 0 14px; }
.bd-rows { display: flex; flex-direction: column; gap: 10px; max-height: 46vh; overflow-y: auto; padding-right: 4px; }
.bd-row { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--panel-2); }
.bd-row.bad { border-color: #f2555c; background: #fef2f2; }
.bd-line { display: flex; align-items: center; gap: 10px; }
.bd-idx { width: 22px; height: 22px; border-radius: 50%; background: var(--primary); color: #fff; font-size: 12px; display: grid; place-items: center; flex-shrink: 0; }
.bd-fields { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
.bd-sel { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.bd-sel.rep { border-color: #bfdbfe; }
.bd-arrow { color: var(--text-3); flex-shrink: 0; }
.bd-del { border: none; background: none; color: var(--text-3); cursor: pointer; flex-shrink: 0; font-size: 12px; }
.bd-del:hover { color: var(--danger); }
.bd-rin { width: 100%; margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12px; box-sizing: border-box; outline: none; }
.bd-rin:focus { border-color: var(--primary); }
.bd-err { margin: 6px 0 0; font-size: 12px; color: #b91c1c; }
.bd-add { margin: 10px 0 4px; border-style: dashed; width: 100%; }
.bd-note { display: flex; gap: 10px; align-items: flex-start; margin-top: 12px; }
.bd-note-k { font-size: 13px; color: var(--text-2); padding-top: 6px; flex-shrink: 0; }
.bd-note textarea { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; box-sizing: border-box; }
.bd-note textarea:focus { border-color: var(--primary); }
.bd-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; }
.bd-count { font-size: 12px; color: var(--text-3); }
.bd-warn { color: #b91c1c; }
.bd-acts { display: flex; gap: 8px; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.primary:hover { filter: brightness(1.05); color: #fff; }
</style>
