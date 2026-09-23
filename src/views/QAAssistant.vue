<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useGapStore } from '@/stores/gap'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useRetirementStore } from '@/stores/retirement'
import { canViewDoc } from '@/utils/permission'
import { isDocCitable } from '@/utils/freshness'
import { isDocRetireCitable } from '@/utils/retirement'
import { extractKeywords, scoreDoc } from '@/utils/qa'
import { latestRestoreInfo } from '@/utils/version'
import { gapStatusLabel } from '@/utils/gap'
import { stripHtml, highlightText, highlightTitle, extractSnippet } from '@/utils/search'
import { formatDate } from '@/utils/format'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const gapStore = useGapStore()
const accessStore = useAccessStore()
const freshnessStore = useFreshnessStore()
const retirementStore = useRetirementStore()

const question = ref('')
const asked = ref('')
const thinking = ref(false)
const answered = ref(false)
const answer = ref('')
const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
// 提问时刻的原始检索命中（含受限文档正文片段）；展示层按当前授权实时过滤——
// 授权撤销/到期后，受限引用与正文片段即时从已渲染答案中收回，不依赖重新提问
const rawCites = ref([])
const rawRelated = ref([])
// 提问时刻命中的已退役文档：不作为引用，单独引导用户转看其替代文档
const retiredHits = ref([])
const suggestions = ['Vue 如何初始化项目?', 'Dexie 怎么进行查询?', '权限模型里有哪些角色?', '新成员入职流程是什么?']

// 展示用引用/相关条目：随授权记录、到期时钟、退役状态响应式重算，被收回/退役的内容即时消失
function grantOf(d) { return accessStore.grantOf(d.id, auth.user?.id) }
function freshTicketOf(d) { return freshnessStore.activeTicketOf(d.id) }
function retirementOf(d) { return retirementStore.activeRetirementOfDoc(d.id) }
const citableNow = (d) =>
  isDocCitable(d, freshTicketOf(d), freshnessStore.now) &&
  isDocRetireCitable(d, retirementOf(d))
const cites = computed(() => rawCites.value.filter((c) => canViewDoc(c, auth.user?.id, null, grantOf(c)) && citableNow(c)))
const related = computed(() => rawRelated.value.filter((d) => canViewDoc(d, auth.user?.id, null, grantOf(d)) && citableNow(d)))
// 已渲染答案中被收回的引用数（限时授权撤销/到期、知识保鲜暂停、知识退役导致）
const revokedCount = computed(() => rawCites.value.length - cites.value.length)
// 其中因知识保鲜到期暂停引用的篇数（用于给出针对性提示）
const freshnessPausedCount = computed(() => rawCites.value.filter((c) => canViewDoc(c, auth.user?.id, null, grantOf(c)) && !isDocCitable(c, freshTicketOf(c), freshnessStore.now)).length)
// 其中因知识退役停止引用的篇数
const retiredCount = computed(() => rawCites.value.filter((c) =>
  canViewDoc(c, auth.user?.id, null, grantOf(c)) &&
  isDocCitable(c, freshTicketOf(c), freshnessStore.now) &&
  !isDocRetireCitable(c, retirementOf(c))
).length)
// 被退役引用所指向的替代文档（提示用户转看新文档）
// 替代文档本身也要过可见性校验：无权查看（含未登录访客）时不泄露标题
const retiredReplacements = computed(() => {
  const ids = new Set()
  const out = []
  for (const c of rawCites.value) {
    const rt = retirementOf(c)
    if (!rt || ids.has(rt.replacementDocId)) continue
    ids.add(rt.replacementDocId)
    const rep = docById.value[rt.replacementDocId]
    if (rep && canViewDoc(rep, auth.user?.id, null, grantOf(rep))) out.push(rep)
  }
  return out
})
// 提问命中的退役文档所指向的替代文档（即便退役文档未进入引用列表也能引导）
const retiredHitReplacements = computed(() => {
  const ids = new Set()
  const out = []
  for (const c of retiredHits.value) {
    const rt = retirementOf(c)
    if (!rt || ids.has(rt.replacementDocId)) continue
    ids.add(rt.replacementDocId)
    const rep = docById.value[rt.replacementDocId]
    if (rep && canViewDoc(rep, auth.user?.id, null, grantOf(rep))) out.push(rep)
  }
  return out
})
// 答案文案：引用全部被收回时，不再保留「找到相关内容」的原始表述
const answerText = computed(() => {
  if (revokedCount.value && !cites.value.length) {
    if (freshnessPausedCount.value) {
      return '该问题此前命中的内容已超过复核周期、正在保鲜复核中，问答引用已暂停。待编辑者修订并经管理员复核通过、重算复核周期后会恢复引用。'
    }
    if (retiredCount.value) {
      return '该问题此前命中的内容已被知识退役（停止问答引用），请改看其指定的替代文档；如替代文档无访问权限，可在替代文档页申请权限。'
    }
    return '该问题此前命中的内容来自限时授权文档，授权已撤销或到期，相关正文已同步收回。如需继续查看，请重新申请访问后再提问。'
  }
  return answer.value
})

// ---- 缺口工单联动 ----
const gapFormOpen = ref(false)
const gapDetail = ref('')

const activeTicket = computed(() => (asked.value ? gapStore.activeTicketForQuestion(asked.value) : null))
// 已解决工单中匹配本问题的答案来源（审批发布后自动回填，此处对提问者可见）
// 回填来源同样过文档可见性：无权查看（含未登录访客）时不泄露文档标题
const resolvedSources = computed(() => {
  if (!asked.value) return []
  return gapStore.resolvedTicketsMatching(extractKeywords(asked.value)).filter((t) => {
    const d = docById.value[t.docId]
    return d && canViewDoc(d, auth.user?.id, null, grantOf(d))
  }).slice(0, 3)
})

async function submitGap() {
  const res = await gapStore.createTicket({ question: asked.value, detail: gapDetail.value }, auth.user)
  if (res.status === 'ok' || res.status === 'duplicate') {
    // 成功后由 activeTicket 计算属性接管展示（该问题已提交补写需求）
    gapFormOpen.value = false
    gapDetail.value = ''
  } else if (res.status === 'guest') {
    alert('访客不能提交补写需求，请先登录。')
  }
}

async function ask(raw) {
  const qtext = (raw ?? question.value).trim()
  if (!qtext) return
  asked.value = qtext
  answering()
}

function answering() {
  thinking.value = true
  answered.value = false
  answer.value = ''
  rawCites.value = []
  rawRelated.value = []
  retiredHits.value = []
  gapFormOpen.value = false
  gapDetail.value = ''

  setTimeout(() => {
    const keywords = extractKeywords(asked.value)
    const tagNames = kb.tags
    // 可见但处于知识保鲜暂停期（周期到点/复核中）的命中：不作为引用来源，仅记录篇数给出提示
    let pausedHits = 0
    // 可见但已知识退役的命中：不作为引用来源，单独统计并引导转看替代文档
    let retiredHitCount = 0
    // 权限：撤销/到期的授权文档不再作为问答引用来源；知识保鲜到期/复核中、知识退役的文档均不参与问答引用
    const hits = kb.docs
      .filter((d) => canViewDoc(d, auth.user?.id, null, grantOf(d)))
      .map((d) => {
        const bodyText = stripHtml(d.body)
        const freshOk = isDocCitable(d, freshTicketOf(d), freshnessStore.now)
        const retireOk = isDocRetireCitable(d, retirementOf(d))
        return {
          doc: d,
          bodyText,
          retired: !retireOk,
          citable: freshOk && retireOk,
          freshPaused: !freshOk,
          score: scoreDoc(d, keywords, tagNames, bodyText)
        }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)

    pausedHits = hits.filter((x) => x.freshPaused && !x.retired).length
    retiredHitCount = hits.filter((x) => x.retired).length
    retiredHits.value = hits.filter((x) => x.retired).map((x) => x.doc)
    const citableHits = hits.filter((x) => x.citable)

    const top = citableHits[0]
    if (!top) {
      answered.value = true
      answer.value = retiredHitCount
        ? '与「' + asked.value + '」相关的内容已被知识退役、停止问答引用，请改看其指定的替代文档' + (pausedHits ? '；另有部分文档正在保鲜复核中' : '') + '。你也可以直接在文档库中查看原文。'
        : pausedHits
          ? '与「' + asked.value + '」相关的内容已超过复核周期、正在保鲜复核中，已暂停问答引用。待编辑者修订并经管理员复核通过后会恢复引用，你也可以直接在文档库中查看原文。'
          : '很抱歉，知识库中暂时没有与「' + asked.value + '」直接匹配的内容。建议你换一种表述，或浏览文档库 / 使用全局搜索。'
      return
    }

    const extraNotes = []
    if (pausedHits) extraNotes.push('另有 ' + pausedHits + ' 篇相关文档因超过复核周期正在保鲜复核，暂未引用')
    if (retiredHitCount) extraNotes.push(retiredHitCount + ' 篇相关文档已知识退役，已转由替代文档承接')
    answer.value = '基于知识库检索，我找到与「' + asked.value + '」相关的内容，引用来源如下。' + (citableHits.length > 1 ? ' 我对其归纳后优先展示最相关的 ' + Math.min(citableHits.length, 3) + ' 篇文档。' : '') + (extraNotes.length ? '（' + extraNotes.join('；') + '）' : '')
    rawCites.value = citableHits.slice(0, 3).map((h) => ({
      ...h.doc,
      bodyText: h.bodyText,
      snippet: extractSnippet(h.doc.body, keywords),
      score: h.score
    }))
    rawRelated.value = citableHits.slice(3, 7).map((h) => h.doc)
    thinking.value = false
    answered.value = true
  }, 600)
}

function useSuggestion(s) { question.value = s; ask(s) }

watch(() => route.query.q, (v) => { if (v) { question.value = v; ask(v) } }, { immediate: true })
onMounted(() => { retirementStore.loadAll() })
</script>

<template>
  <div class="qa-page">
    <header class="head">
      <div class="title-line"><h2>🤖 智能知识问答</h2><span class="pill">基于规则检索 · mock 演示</span></div>
      <p class="sub">向整个知识库提问，AI 助手会检索相关内容并给出引用出处与相关条目。</p>
      <div class="ask-box">
        <input v-model="question" placeholder="例如：Vue 如何初始化项目？" @keyup.enter="ask()" />
        <button class="btn primary" :disabled="!question.trim()" @click="ask()">提问</button>
      </div>
      <div class="sug">
        <span v-for="s in suggestions" :key="s" class="sug-item" @click="useSuggestion(s)">{{ s }}</span>
      </div>
    </header>

    <div v-if="thinking" class="card thinking">🤔 正在检索知识库，关联相关条目…</div>

    <div v-if="answered" class="answer card">
      <div class="a-label">助手回答<span class="sub-ask">问题：{{ asked }}</span></div>
      <p class="a-text">{{ answerText }}</p>
      <div v-if="revokedCount" class="revoked-note">
        <template v-if="freshnessPausedCount">🧊 {{ freshnessPausedCount }} 条引用因超过复核周期正在保鲜复核，问答引用已暂停，复核通过后自动恢复</template>
        <template v-else-if="retiredCount">🗄 {{ retiredCount }} 条引用的文档已知识退役，问答引用已停止<template v-if="retiredReplacements.length">，请改看替代文档：
          <span v-for="rep in retiredReplacements" :key="rep.id" class="rep-link" @click="router.push('/docs/' + rep.id)">《{{ rep.title }}》</span>
        </template></template>
        <template v-else>🔒 {{ revokedCount }} 条引用来自限时授权文档，授权已撤销或到期，相关正文已同步收回</template>
      </div>

      <!-- 命中的旧文档全部已退役（未进入引用列表）：引导转看替代文档；无权限时替代文档页会引导申请权限 -->
      <div v-if="answered && !cites.length && retiredHitReplacements.length" class="retired-suggest">
        <div class="block-title">🗄 命中的旧文档已退役，请改看替代文档</div>
        <div v-for="rep in retiredHitReplacements" :key="rep.id" class="rel" @click="router.push('/docs/' + rep.id)">
          <span class="rel-title">《{{ rep.title }}》</span>
          <span class="rel-tag">{{ kb.catMap[rep.categoryId]?.name }} · 替代文档</span>
        </div>
        <div class="rs-hint">如替代文档无访问权限，打开后可直接向其拥有者申请限时阅读/协作权限。</div>
      </div>

      <div v-if="cites.length" class="cites">
        <div class="block-title">📎 引用出处</div>
        <div v-for="c in cites" :key="c.id" class="cite" @click="router.push('/docs/' + c.id)">
          <div class="cite-head">
            <span class="cite-score" v-if="c.score >= 5">★ 高相关</span>
            <span class="cite-title" v-html="highlightTitle(c.title, extractKeywords(asked))"></span>
          </div>
          <div class="cite-snippet" v-html="highlightText(c.snippet, extractKeywords(asked))"></div>
          <div class="cite-meta">
            分类 · {{ kb.catMap[c.categoryId]?.name }} · 更新于 {{ formatDate(c.updatedAt) }}
            <span v-if="latestRestoreInfo(c)" class="cite-restore" title="该文档当前内容来自版本恢复">↩ 已恢复至 v{{ latestRestoreInfo(c).fromVersion }}</span>
          </div>
        </div>
      </div>

      <div v-if="related.length" class="related">
        <div class="block-title">🧩 相关条目</div>
        <div v-for="r in related" :key="r.id" class="rel" @click="router.push('/docs/' + r.id)">
          <span class="rel-title">{{ r.title }}</span>
          <span class="rel-tag">{{ kb.catMap[r.categoryId]?.name }}</span>
        </div>
      </div>

      <!-- 缺口工单联动：未命中时展示已回填的答案来源；未解决的问题可一键转为补写需求 -->
      <div class="gap-block">
        <template v-if="!cites.length && resolvedSources.length">
          <div class="block-title">💡 以下补写文档可能回答了该问题</div>
          <div v-for="t in resolvedSources" :key="t.id" class="gap-src" @click="docById[t.docId] && router.push('/docs/' + t.docId)">
            <span class="gap-src-title">《{{ docById[t.docId]?.title || '文档已删除' }}》</span>
            <span class="gap-src-q">来自缺口工单：{{ t.question }}</span>
          </div>
        </template>

        <div v-if="activeTicket" class="gap-exists">
          📋 该问题已提交补写需求（{{ gapStatusLabel(activeTicket.status) }}），编辑者处理后会在此回填答案来源。
          <a @click="router.push('/gaps')">前往缺口工单 →</a>
        </div>

        <template v-else-if="auth.user">
          <div v-if="!gapFormOpen" class="gap-cta">
            <button class="btn sm" @click="gapFormOpen = true">
              📝 {{ cites.length ? '答案没解决你的问题？提交补写需求' : '没解决？提交补写需求' }}
            </button>
          </div>
          <div v-else class="gap-form">
            <textarea v-model="gapDetail" rows="2" placeholder="补充说明（可选）：描述你期望的答案或使用场景…"></textarea>
            <div class="gap-form-acts">
              <button class="btn sm primary" @click="submitGap">提交补写需求</button>
              <button class="btn sm ghost" @click="gapFormOpen = false">取消</button>
            </div>
            <div class="gap-form-hint">提交后生成缺口工单，编辑者认领补写并送审，审批通过后答案来源会自动回填。</div>
            </div>
        </template>
      </div>
    </div>

    <div v-else-if="!thinking" class="empty card"><div class="ico">💬</div>输入问题开始提问</div>
  </div>
</template>

<style scoped>
.qa-page { max-width: 780px; margin: 0 auto; }
.head .title-line { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.head h2 { margin: 0; }
.sub { color: var(--text-2); }
.ask-box { display: flex; gap: 10px; margin: 14px 0; }
.ask-box input { flex: 1; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; outline: none; }
.ask-box input:focus { border-color: var(--primary); }
.sug { display: flex; flex-wrap: wrap; gap: 8px; }
.sug-item { padding: 4px 12px; border: 1px dashed var(--border); border-radius: 999px; font-size: 12px; color: var(--text-2); cursor: pointer; }
.sug-item:hover { border-color: var(--primary); color: var(--primary); }
.thinking { padding: 24px; color: var(--text-2); display: flex; align-items: center; gap: 10px; }
.answer { margin-top: 16px; padding: 24px 28px; }
.a-label { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 10px; }
.sub-ask { font-weight: 400; font-size: 12px; color: var(--text-3); }
.a-text { margin: 8px 0 18px; color: var(--text); }
.revoked-note { margin: -8px 0 14px; padding: 8px 14px; border-radius: 8px; font-size: 13px; color: #b45309; background: #fffbeb; border: 1px solid #f59e0b; }
.rep-link { color: var(--primary); font-weight: 600; cursor: pointer; margin: 0 4px; }
.rep-link:hover { text-decoration: underline; }
.retired-suggest { margin: 0 0 14px; padding: 12px 14px; border-radius: 10px; background: #f8fafc; border: 1px solid #cbd5e1; }
.retired-suggest .rel { display: flex; justify-content: space-between; padding: 9px 12px; border-radius: 8px; cursor: pointer; background: var(--panel); border: 1px solid var(--border); margin-bottom: 6px; }
.retired-suggest .rel:hover { border-color: var(--primary); }
.retired-suggest .rel-title { font-weight: 600; color: var(--primary); }
.retired-suggest .rel-tag { color: var(--text-3); font-size: 12px; }
.rs-hint { font-size: 12px; color: var(--text-3); margin-top: 4px; }
.block-title { font-weight: 600; font-size: 13px; color: var(--text-2); margin: 16px 0 10px; }
.cites { display: flex; flex-direction: column; gap: 10px; }
.cite { border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; cursor: pointer; }
.cite:hover { border-color: var(--primary); }
.cite-head { display: flex; align-items: center; gap: 8px; }
.cite-score { background: var(--primary-weak); color: var(--primary); font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.cite-title { font-weight: 700; }
.cite-snippet { color: var(--text-2); font-size: 13px; margin: 6px 0; }
.cite-meta { color: var(--text-3); font-size: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cite-restore { font-size: 11px; padding: 0 8px; border-radius: 999px; background: #e0e7ff; color: #4338ca; font-weight: 600; }
.related { display: flex; flex-direction: column; gap: 6px; }
.rel { display: flex; justify-content: space-between; padding: 9px 12px; border-radius: 8px; cursor: pointer; background: var(--panel-2); }
.rel:hover { background: var(--primary-weak); }
.rel-title { font-weight: 500; }
.rel-tag { color: var(--text-3); font-size: 12px; }
.gap-block { margin-top: 18px; border-top: 1px dashed var(--border); padding-top: 14px; }
.gap-src { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 12px; border-radius: 8px; cursor: pointer; background: #f0fdf4; border: 1px solid #bbf7d0; margin-bottom: 6px; }
.gap-src:hover { border-color: #16a34a; }
.gap-src-title { color: #15803d; font-weight: 600; }
.gap-src-q { color: var(--text-3); font-size: 12px; }
.gap-exists { font-size: 13px; color: var(--text-2); background: var(--primary-weak); border-radius: 8px; padding: 10px 14px; }
.gap-exists a { cursor: pointer; }
.gap-cta { display: flex; }
.gap-form textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
.gap-form textarea:focus { border-color: var(--primary); }
.gap-form-acts { display: flex; gap: 8px; margin-top: 8px; }
.gap-form-hint { margin-top: 8px; font-size: 12px; color: var(--text-3); }
</style>