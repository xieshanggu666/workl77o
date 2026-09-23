<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAccessStore } from '@/stores/access'
import { useAuthStore } from '@/stores/auth'
import { useKbStore } from '@/stores/kb'
import {
  ACCESS, ACCESS_PERM, accessStatusLabel, accessPermLabel, accessStatusCls, grantExpireText
} from '@/utils/access'
import { formatFull, avatarColor } from '@/utils/format'

const props = defineProps({
  doc: { type: Object, required: true }
})

const router = useRouter()
const accessStore = useAccessStore()
const auth = useAuthStore()
const kb = useKbStore()

const permission = ref(ACCESS_PERM.READ)
const reason = ref('')
const busy = ref(false)
const justApplied = ref(false)

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
// 未登录访客：team/private 文档一律不可见，引导先登录（公开文档不会进入本卡片）
const isGuest = computed(() => !auth.user)
// 受限原因文案：团队文档需登录成员身份；私有文档还需拥有者/协作成员或限时授权
const restrictedText = computed(() =>
  props.doc.visibility === 'team'
    ? '该文档为<b>团队文档</b>，仅登录的团队成员可查看。'
    : '该文档为<b>私有文档</b>，仅拥有者与协作成员可查看。'
)

// 当前用户在该文档上的最近一条申请（任何状态）
const latest = computed(() => accessStore.latestRequestFor(props.doc.id, auth.user?.id))
// 当前是否已有有效授权（拥有者在其他窗口/标签页审批通过后，本页即时切回详情视图）
const activeGrant = computed(() => accessStore.grantOf(props.doc.id, auth.user?.id))
const pending = computed(() => latest.value?.status === ACCESS.PENDING)
const owner = computed(() => userById.value[props.doc.ownerId])

async function submit() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await accessStore.createRequest(props.doc.id, permission.value, reason.value.trim(), auth.user)
    if (res.status === 'ok' || res.status === 'duplicate') {
      justApplied.value = true
      reason.value = ''
      setTimeout(() => { justApplied.value = false }, 2500)
    } else if (res.status === 'guest') {
      alert('请先登录后再申请访问。')
    }
  } finally {
    busy.value = false
  }
}

async function cancel() {
  if (!latest.value) return
  if (!confirm('确定取消本次访问申请？')) return
  await accessStore.cancelRequest(latest.value.id, auth.user)
}

// 授权在其他窗口通过（或本人申请后由拥有者审批）时，本窗口即时恢复详情访问
watch(activeGrant, async (g) => {
  if (g) await kb.reloadDocs()
})
</script>

<template>
  <div class="apply card">
    <div class="head">
      <span class="lock">🔒</span>
      <div>
        <h3>申请访问「{{ doc.title }}」</h3>
        <p class="sub">
          <template v-if="isGuest">
            {{ restrictedText }}<b>请先登录</b>后查看；如登录后仍无权限，可向拥有者<template v-if="owner">（{{ owner.name }}）</template>申请限时阅读或协作权限，审批通过后在有效期内可访问，到期或被撤销将自动收回。
          </template>
          <template v-else>
            {{ restrictedText }}
            可向拥有者<template v-if="owner">（{{ owner.name }}）</template>申请限时阅读或协作权限，审批通过后在有效期内可访问，到期或被撤销将自动收回。
          </template>
        </p>
      </div>
    </div>

    <!-- 未登录访客：不展示申请表（访客无法发起申请），统一引导登录 -->
    <div v-if="isGuest" class="guest-login">
      <span class="guest-tip">🔑 你当前以访客身份浏览，团队与私有文档均不可见。</span>
      <button class="btn primary" @click="router.push('/profile')">前往登录</button>
    </div>

    <div v-else-if="justApplied" class="ok-line">✅ 申请已提交，等待文档拥有者审批</div>

    <!-- 已有待审批申请：展示状态，不允许重复提交 -->
    <div v-if="!isGuest && pending" class="status-box pending-box">
      <div class="sb-row">
        <span class="st" :class="accessStatusCls(latest.status)">{{ accessStatusLabel(latest.status) }}</span>
        <span class="perm">申请权限：{{ accessPermLabel(latest.requestedPermission) }}</span>
        <span class="tm">提交于 {{ formatFull(latest.createdAt) }}</span>
      </div>
      <p v-if="latest.reason" class="reason">申请说明：“{{ latest.reason }}”</p>
      <button class="btn sm ghost" @click="cancel">取消申请</button>
    </div>

    <!-- 无流转中申请：展示申请表（历史被驳回/撤销/到期后可重新申请；访客走上方登录引导） -->
    <template v-else-if="!isGuest">
      <div v-if="latest" class="status-box">
        <div class="sb-row">
          <span class="st" :class="accessStatusCls(latest.status)">{{ accessStatusLabel(latest.status) }}</span>
          <span class="perm">上次申请：{{ accessPermLabel(latest.requestedPermission) }}</span>
          <span v-if="latest.status === ACCESS.APPROVED" class="tm">{{ grantExpireText(latest) }}</span>
        </div>
        <p v-if="latest.status === ACCESS.REJECTED && latest.decisionNote" class="reason">驳回说明：“{{ latest.decisionNote }}”</p>
      </div>

      <div class="form">
        <div class="f-row">
          <label>申请权限</label>
          <div class="perm-seg">
            <button type="button" :class="{ on: permission === ACCESS_PERM.READ }" @click="permission = ACCESS_PERM.READ">
              📖 限时阅读<small>可查看详情、被搜索与问答检索</small>
            </button>
            <button type="button" :class="{ on: permission === ACCESS_PERM.COLLAB }" @click="permission = ACCESS_PERM.COLLAB">
              ✍️ 限时协作<small>阅读权限 + 可编辑该文档</small>
            </button>
          </div>
        </div>
        <div class="f-row">
          <label>申请说明</label>
          <textarea v-model="reason" rows="3" maxlength="300" placeholder="向拥有者说明访问事由与用途（可选）"></textarea>
        </div>
        <div class="acts">
          <button class="btn primary" :disabled="busy || !auth.user" @click="submit">
            {{ busy ? '提交中…' : '提交访问申请' }}
          </button>
          <span class="tip">授权时长由拥有者审批时设定（1 / 7 / 30 天）</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.apply { max-width: 640px; margin: 0 auto; padding: 24px 28px; }
.head { display: flex; gap: 14px; margin-bottom: 18px; }
.lock { font-size: 34px; line-height: 1.2; }
.head h3 { margin: 0 0 6px; font-size: 18px; }
.sub { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.7; }
.ok-line { color: #15803d; background: #f0fdf4; border: 1px solid #16a34a; border-radius: 8px; padding: 8px 12px; font-size: 13px; margin-bottom: 14px; }
.guest-login { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; background: var(--primary-weak); border: 1px solid var(--primary); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.guest-tip { font-size: 13px; color: var(--primary); font-weight: 500; }
.status-box { background: var(--panel-2); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
.pending-box { background: #fffbeb; border: 1px solid #f59e0b; }
.sb-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-revoked { background: #ffe9ea; color: var(--danger); }
.st-off { background: var(--panel); color: var(--text-3); }
.tm { color: var(--text-3); font-size: 12px; }
.reason { margin: 8px 0 0; font-size: 13px; color: var(--text-2); }
.form { display: flex; flex-direction: column; gap: 14px; }
.f-row { display: flex; gap: 12px; }
.f-row > label { width: 64px; flex-shrink: 0; font-size: 13px; color: var(--text-2); padding-top: 8px; }
.perm-seg { display: flex; gap: 10px; flex: 1; }
.perm-seg button { flex: 1; border: 1px solid var(--border); background: var(--panel); border-radius: 10px; padding: 10px 12px; cursor: pointer; text-align: left; font-size: 13px; font-weight: 600; color: var(--text); }
.perm-seg button small { display: block; font-weight: 400; color: var(--text-3); margin-top: 3px; }
.perm-seg button.on { border-color: var(--primary); background: var(--primary-weak); color: var(--primary); }
.f-row textarea { flex: 1; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
.f-row textarea:focus { border-color: var(--primary); }
.acts { display: flex; align-items: center; gap: 12px; padding-left: 76px; }
.tip { font-size: 12px; color: var(--text-3); }
</style>
