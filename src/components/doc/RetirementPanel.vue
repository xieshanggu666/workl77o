<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useRetirementStore } from '@/stores/retirement'
import { formatFull } from '@/utils/format'
import { RETIRE, retireStatusLabel, retireStatusCls, retireTimelineLabel } from '@/utils/retirement'

const props = defineProps({
  doc: { type: Object, required: true }
})

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const retirementStore = useRetirementStore()

const showForm = ref(false)
const replacementDocId = ref('')
const reason = ref('')
const busy = ref(false)
const revokeNote = ref('')
const noteMap = ref({})

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

// 本文档退役单（生效 + 流转 + 历史），时间倒序
const records = computed(() =>
  retirementStore.sorted.filter((r) => r.docId === props.doc.id)
)
const active = computed(() => retirementStore.activeRetirementOfDoc(props.doc.id))
const open = computed(() => retirementStore.openRetirementOfDoc(props.doc.id))

// 可作为替代文档：非本文档、未退役、无流转中退役单、未被他单占用为替代文档
const replacementCandidates = computed(() =>
  kb.docs
    .filter((d) => d.id !== props.doc.id)
    .filter((d) => !retirementStore.activeRetirementOfDoc(d.id) && !retirementStore.openRetirementOfDoc(d.id))
    .filter((d) => !retirementStore.retirementUsingAsReplacement(d.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

const isOwner = computed(() => props.doc.ownerId === auth.user?.id || auth.user?.role === 'admin')
// 本文档被他人在途/生效退役单用作替代文档时不可发起（替代冲突，须先处理对方退役）
const usedAsReplacement = computed(() => !!retirementStore.retirementUsingAsReplacement(props.doc.id))
const canInitiate = computed(() =>
  isOwner.value && !active.value && !open.value && !usedAsReplacement.value
)

const replacementDoc = computed(() =>
  active.value ? kb.docs.find((d) => d.id === active.value.replacementDocId) || null : null
)

// 本篇退役单所属批次（统一送审时挂载）
const activeBatch = computed(() => (active.value?.batchId ? retirementStore.batchById(active.value.batchId) : null))
const openBatch = computed(() => (open.value?.batchId ? retirementStore.batchById(open.value.batchId) : null))

function openInitiate() {
  showForm.value = true
  replacementDocId.value = replacementCandidates.value[0]?.id || ''
  reason.value = ''
}

async function submit() {
  if (busy.value) return
  if (!replacementDocId.value) { alert('请选择替代文档'); return }
  busy.value = true
  try {
    const res = await retirementStore.initiateRetirement(
      { docId: props.doc.id, replacementDocId: replacementDocId.value, reason: reason.value.trim() },
      auth.user
    )
    if (res.status === 'ok') {
      showForm.value = false
      alert('已提交退役申请，等待管理员审批。')
    } else if (res.status === 'denied') {
      alert('只有文档负责人或管理员可以发起退役。')
    } else if (res.status === 'in-retirement') {
      alert('该文档已有流转中或已生效的退役记录。')
    } else if (res.status === 'in-review') {
      alert('文档正在评审中，请待评审完结后再发起退役。')
    } else if (res.status === 'in-handover') {
      alert('文档正在责任交接中，请先完成或取消交接。')
    } else if (res.status === 'replacement-retired') {
      alert('替代文档已退役或正在退役流程中，请选择其他文档。')
    } else if (res.status === 'used-as-replacement') {
      alert('本文档正作为另一篇文档的替代文档，需先处理或撤销该退役后再退役本文档。')
    } else if (res.status === 'bad-replacement') {
      alert('替代文档无效，请重新选择。')
    } else if (res.status === 'guest') {
      alert('请先登录后再发起退役。')
    } else {
      alert('发起失败，请稍后重试。')
    }
  } finally {
    busy.value = false
  }
}

async function cancelOpen(r) {
  if (!confirm('确定撤销本次退役申请？文档保持原状。')) return
  const res = await retirementStore.cancelRetirement(r.id, auth.user)
  if (res.status !== 'ok') alert('操作失败：退役单状态已变化')
}

async function doRevoke() {
  if (!active.value) return
  if (!confirm('确定撤销退役？将恢复旧文档的搜索与问答引用、恢复共享链接，并把答案来源回挂旧文档。')) return
  busy.value = true
  try {
    const res = await retirementStore.revokeRetirement(active.value.id, revokeNote.value.trim(), auth.user)
    if (res.status === 'ok') {
      revokeNote.value = ''
      alert('已撤销退役，旧文档已恢复。')
    } else if (res.status === 'denied') {
      alert('只有退役发起人或管理员可以撤销退役。')
    } else {
      alert('操作失败：退役单状态已变化')
    }
  } finally {
    busy.value = false
  }
}

onMounted(() => { retirementStore.loadAll() })
</script>

<template>
  <section class="retire card">
    <!-- 已退役横幅 -->
    <div v-if="active" class="rt-banner retired">
      <div class="rt-banner-head">
        <span class="rt-ico">🗄</span>
        <b>本文档已退役 · 已停止搜索与问答引用</b>
        <span class="st" :class="retireStatusCls(active.status)">{{ retireStatusLabel(active.status) }}</span>
      </div>
      <p class="rt-banner-sub">
        退役后本文档作为只读归档保留，可通过直接链接查看；搜索与智能问答不再引用。
        <template v-if="replacementDoc">
          替代文档：
          <a class="rt-rep" @click="router.push('/docs/' + replacementDoc.id)">《{{ replacementDoc.title }}》→</a>
        </template>
        <template v-else>
          <span class="rt-rep-gone">替代文档《{{ active.replacementTitle }}》已不存在</span>
        </template>
      </p>
      <div class="rt-meta">
        {{ userName(active.decidedBy) }} 于 {{ formatFull(active.approvedAt) }} 批准退役
        <span v-if="active.effects">· 撤销共享链接 {{ active.effects.revokedShareIds?.length || 0 }} 条 · 改挂缺口工单答案来源 {{ active.effects.repointedTicketIds?.length || 0 }} 张</span>
        <a v-if="activeBatch" class="rt-batch-link" @click="router.push('/retirement')">📦 退役批次（{{ retirementStore.itemsOfBatch(active.batchId).length }} 篇）→</a>
      </div>
      <div v-if="active.initiatedBy === auth.user?.id || auth.user?.role === 'admin'" class="rt-revoke">
        <input v-model="revokeNote" class="rt-note-in" placeholder="撤销退役说明（可选，将写入记录）" />
        <button class="btn sm" :disabled="busy" @click="doRevoke">↩ 撤销退役并恢复</button>
      </div>
    </div>

    <!-- 待审批提示 -->
    <div v-else-if="open" class="rt-banner pending">
      <div class="rt-banner-head">
        <span class="rt-ico">⏳</span>
        <b>退役申请待管理员审批</b>
        <span class="st" :class="retireStatusCls(open.status)">{{ retireStatusLabel(open.status) }}</span>
      </div>
      <p class="rt-banner-sub">
        拟由替代文档 <a class="rt-rep" @click="router.push('/docs/' + open.replacementDocId)">《{{ open.replacementTitle }}》</a> 承接；
        审批通过后将停止本文档的搜索与问答引用、撤销共享链接并改挂缺口工单答案来源。
      </p>
      <div class="rt-meta">
        {{ userName(open.initiatedBy) }} 于 {{ formatFull(open.createdAt) }} 发起
        <a v-if="openBatch" class="rt-batch-link" @click="router.push('/retirement')">📦 属于统一送审批次（{{ retirementStore.itemsOfBatch(open.batchId).length }} 篇，管理员逐篇审批）→</a>
      </div>
      <div v-if="open.initiatedBy === auth.user?.id || auth.user?.role === 'admin'" class="rt-revoke">
        <button class="btn sm ghost" @click="cancelOpen(open)">撤销退役申请</button>
      </div>
    </div>

    <!-- 发起入口 -->
    <template v-else>
      <div class="rt-head" @click="showForm = !showForm">
        <span class="rt-title">🗄 知识退役替代</span>
        <button v-if="canInitiate && !showForm" class="btn sm ghost" @click.stop="openInitiate">发起退役</button>
      </div>

      <p v-if="isOwner && usedAsReplacement" class="rt-conflict">
        ⚠ 本文档正作为《{{ retirementStore.retirementUsingAsReplacement(doc.id)?.docTitle }}》的替代文档，
        需先处理或撤销该退役后，才能退役本文档（避免替代链断裂）。
      </p>

      <div v-if="showForm && canInitiate" class="rt-form">
        <p class="rt-hint">退役需管理员审批。生效后本文档停止搜索命中与问答引用，有效共享链接将被撤销，已解决缺口工单的答案来源改挂替代文档；退役可撤销并全程留痕。</p>
        <label class="rf-item">
          <span class="rf-k">替代文档</span>
          <select v-model="replacementDocId" class="rf-sel">
            <option value="" disabled>请选择承接内容的替代文档…</option>
            <option v-for="d in replacementCandidates" :key="d.id" :value="d.id">{{ d.title }}</option>
          </select>
        </label>
        <textarea v-model="reason" rows="2" maxlength="300" class="rf-reason" placeholder="退役原因（可选，将写入退役记录）"></textarea>
        <div class="rf-acts">
          <button class="btn sm ghost" @click="showForm = false">取消</button>
          <button class="btn sm primary" :disabled="busy || !replacementDocId" @click="submit">{{ busy ? '提交中…' : '提交退役申请' }}</button>
        </div>
        <div v-if="!replacementCandidates.length" class="rf-empty">库中暂无可作为替代的文档</div>
      </div>
    </template>

    <!-- 历史退役记录 -->
    <details v-if="records.length" class="rt-history">
      <summary>退役记录（{{ records.length }}）</summary>
      <div v-for="r in records" :key="r.id" class="rt-rec">
        <div class="rt-rec-head">
          <span class="st" :class="retireStatusCls(r.status)">{{ retireStatusLabel(r.status) }}</span>
          <span class="rt-rec-rep">替代：《{{ r.replacementTitle }}》</span>
          <span class="rt-rec-time">{{ formatFull(r.createdAt) }}</span>
        </div>
        <div v-for="(t, i) in r.timeline || []" :key="i" class="rt-tl">
          <span class="rt-tl-act">{{ retireTimelineLabel(t.action) }}</span>
          <span class="rt-tl-who">{{ userName(t.by) }}</span>
          <span v-if="t.note" class="rt-tl-note">“{{ t.note }}”</span>
          <span class="rt-tl-tm">{{ formatFull(t.at) }}</span>
        </div>
      </div>
    </details>
  </section>
</template>

<style scoped>
.retire { padding: 16px 20px; margin-top: 14px; }
.rt-head { display: flex; align-items: center; justify-content: space-between; cursor: pointer; }
.rt-title { font-weight: 700; font-size: 14px; }
.rt-hint { color: var(--text-3); font-size: 12px; line-height: 1.7; margin: 8px 0 12px; }
.rt-conflict { margin: 8px 0 0; font-size: 12px; color: #b45309; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px; padding: 8px 12px; line-height: 1.6; }
.rt-form { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 12px; }
.rf-item { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.rf-k { font-size: 13px; color: var(--text-2); width: 64px; flex-shrink: 0; }
.rf-sel { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.rf-reason { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; box-sizing: border-box; }
.rf-reason:focus { border-color: var(--primary); }
.rf-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.rf-empty { color: var(--text-3); font-size: 12px; margin-top: 8px; }

.rt-banner { border-radius: 10px; padding: 12px 16px; }
.rt-banner.retired { background: #f8fafc; border: 1px solid #cbd5e1; }
.rt-banner.pending { background: #fffbeb; border: 1px solid #f59e0b; }
.rt-banner-head { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.rt-ico { font-size: 18px; }
.rt-banner-sub { margin: 8px 0 4px; font-size: 13px; color: var(--text-2); line-height: 1.7; }
.rt-rep { color: var(--primary); font-weight: 600; cursor: pointer; }
.rt-rep:hover { text-decoration: underline; }
.rt-rep-gone { color: var(--text-3); }
.rt-meta { font-size: 12px; color: var(--text-3); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.rt-batch-link { color: var(--primary); cursor: pointer; }
.rt-batch-link:hover { text-decoration: underline; }
.rt-revoke { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.rt-note-in { flex: 1; min-width: 200px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; outline: none; }
.rt-note-in:focus { border-color: var(--primary); }

.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-retired { background: #e2e8f0; color: #475569; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-restore { background: #dcfce7; color: #15803d; }

.rt-history { margin-top: 12px; }
.rt-history summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.rt-rec { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin-top: 8px; background: var(--panel-2); }
.rt-rec-head { display: flex; align-items: center; gap: 10px; font-size: 12px; flex-wrap: wrap; }
.rt-rec-rep { color: var(--text-2); }
.rt-rec-time { color: var(--text-3); margin-left: auto; }
.rt-tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 3px 0; font-size: 12px; }
.rt-tl-act { font-weight: 600; color: var(--primary); min-width: 180px; }
.rt-tl-who { color: var(--text-2); min-width: 50px; }
.rt-tl-note { color: var(--text-2); flex: 1; }
.rt-tl-tm { color: var(--text-3); }
</style>
