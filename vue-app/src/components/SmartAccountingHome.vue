<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { analyzeTransactionImage } from '../services/aiProviders'
import { matchCategoryPreset, normalizeCategoryText } from '../services/categoryMatcher'
import {
  appendLedgerEntry,
  loadCategoryPresets,
  loadLedgerEntries,
  saveCategoryPresets,
} from '../services/storage'

const props = defineProps({
  aiConfig: {
    type: Object,
    required: true,
  },
  isConfigReady: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['request-config'])
const $q = useQuasar()

const MAX_IMAGE_SIZE_MB = 8
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024
const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const PAYMENT_METHOD_OPTIONS = ['现金', '微信', '支付宝', '银行卡', '信用卡', 'Apple Pay', '其他']
const TRANSACTION_TYPE_OPTIONS = [
  { label: '支出', value: 'expense' },
  { label: '收入', value: 'income' },
]

const selectedFile = ref(null)
const previewURL = ref('')
const isAnalyzing = ref(false)
const hasDraft = ref(false)
const draftHint = ref('')
const analyzeMessage = ref({ type: '', text: '' })
const presetMessage = ref({ type: '', text: '' })
const newPresetName = ref('')
const newPresetAliases = ref('')
const aliasDraftMap = reactive({})

const categoryPresets = ref(loadCategoryPresets())
const ledgerEntries = ref(loadLedgerEntries())

const draft = reactive(createEmptyDraft())

const sortedLedgerEntries = computed(() => {
  return [...ledgerEntries.value].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
})

const canConfirmDraft = computed(() => {
  const amount = Number(draft.amount)
  return Number.isFinite(amount) && amount > 0
})

watch(
  () => selectedFile.value,
  (file) => {
    revokePreviewURL()
    if (!file) {
      return
    }
    previewURL.value = URL.createObjectURL(file)
  },
)

onBeforeUnmount(() => {
  revokePreviewURL()
})

function createEmptyDraft() {
  return {
    amount: '',
    currency: 'CNY',
    occurredAtInput: '',
    location: '',
    paymentMethod: '其他',
    merchant: '',
    category: '其他',
    note: '',
    transactionType: 'expense',
    sourceImageName: '',
    aiProvider: 'openai',
    aiModel: '',
    aiConfidence: null,
  }
}

function resetDraft() {
  Object.assign(draft, createEmptyDraft())
  hasDraft.value = false
  draftHint.value = ''
}

function resetFileSelection() {
  selectedFile.value = null
  revokePreviewURL()
}

function revokePreviewURL() {
  if (!previewURL.value) {
    return
  }
  URL.revokeObjectURL(previewURL.value)
  previewURL.value = ''
}

function setAnalyzeMessage(type, text) {
  analyzeMessage.value = { type, text }
}

function setPresetMessage(type, text) {
  presetMessage.value = { type, text }
}

function parseDateToInputValue(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function parseOccurredAtTextToInputValue(occurredAtText) {
  if (typeof occurredAtText !== 'string') {
    return ''
  }
  const matched = occurredAtText.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  )
  if (!matched) {
    return ''
  }
  const [, year, month, day, hour, minute, second] = matched
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return parseDateToInputValue(date)
}

function parseInputValueToISO(inputValue) {
  const parsedDate = new Date(inputValue)
  if (Number.isNaN(parsedDate.getTime())) {
    return ''
  }
  return parsedDate.toISOString()
}

function normalizeInputFile(fileLike) {
  if (!fileLike) {
    return null
  }
  if (Array.isArray(fileLike)) {
    return fileLike[0] || null
  }
  return fileLike
}

function isSupportedMimeType(mimeType) {
  return SUPPORTED_MIME_TYPES.includes(mimeType)
}

function detectMimeType(file) {
  if (file?.type && isSupportedMimeType(file.type)) {
    return file.type
  }

  const fileName = typeof file?.name === 'string' ? file.name.toLowerCase() : ''
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  if (fileName.endsWith('.png')) {
    return 'image/png'
  }
  if (fileName.endsWith('.webp')) {
    return 'image/webp'
  }
  return ''
}

function validateSelectedFile(file) {
  const normalizedFile = normalizeInputFile(file)
  if (!normalizedFile) {
    return { ok: false, error: '请先选择待识别图片' }
  }

  const mimeType = detectMimeType(normalizedFile)
  if (!mimeType) {
    return { ok: false, error: '仅支持 jpg/jpeg/png/webp 图片' }
  }

  if (normalizedFile.size > MAX_IMAGE_SIZE_BYTES) {
    return { ok: false, error: `图片大小不能超过 ${MAX_IMAGE_SIZE_MB}MB` }
  }

  return { ok: true, file: normalizedFile, mimeType }
}

function handleFileChanged(nextFile) {
  const validation = validateSelectedFile(nextFile)
  if (!validation.ok) {
    selectedFile.value = null
    if (nextFile) {
      setAnalyzeMessage('error', validation.error)
    }
    return
  }

  selectedFile.value = validation.file
  setAnalyzeMessage('', '')
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('图片读取失败'))
    }
    reader.onerror = () => reject(new Error('图片读取失败，请重新上传'))
    reader.readAsDataURL(file)
  })
}

async function buildImagePayload(file) {
  const dataURL = await fileToDataURL(file)
  const matched = dataURL.match(/^data:(.+);base64,(.+)$/)
  if (!matched) {
    throw new Error('图片格式解析失败，请更换图片后重试')
  }

  return {
    mimeType: matched[1],
    base64Data: matched[2],
    fileName: file.name || '',
  }
}

function buildAnalyzeConfig() {
  const provider = props.aiConfig?.provider === 'anthropic' ? 'anthropic' : 'openai'
  return {
    provider,
    baseURL: props.aiConfig?.baseURL || '',
    token: props.aiConfig?.token || '',
    model: props.aiConfig?.providerModels?.[provider]?.currentModel || '',
  }
}

function applyDraftFromAI(parsedData, analysisConfig, sourceImageName) {
  const matchedCategory = matchCategoryPreset(parsedData.category, categoryPresets.value)
  const fallbackDate = parseDateToInputValue(new Date())
  const parsedOccurredAt = parseOccurredAtTextToInputValue(parsedData.occurredAt)
  const occurredAtInput = parsedOccurredAt || fallbackDate

  // AI 未提取到交易时间时先填当前时间，并显式提示用户复核，避免静默写入错误日期。
  draftHint.value = parsedOccurredAt ? '' : 'AI 未识别到交易时间，已使用当前时间，请手动确认。'

  draft.amount = parsedData.amount ?? ''
  draft.currency = parsedData.currency || 'CNY'
  draft.occurredAtInput = occurredAtInput
  draft.location = parsedData.location || ''
  draft.paymentMethod = parsedData.paymentMethod || '其他'
  draft.merchant = parsedData.merchant || ''
  draft.category = matchedCategory.category
  draft.note = parsedData.note || ''
  draft.transactionType = parsedData.transactionType || 'expense'
  draft.sourceImageName = sourceImageName
  draft.aiProvider = analysisConfig.provider
  draft.aiModel = analysisConfig.model
  draft.aiConfidence = parsedData.confidence
  hasDraft.value = true
}

async function handleAnalyze() {
  if (!props.isConfigReady) {
    setAnalyzeMessage('error', '请先完成 AI 配置并保存，再进行图片识别')
    emit('request-config')
    return
  }

  const validation = validateSelectedFile(selectedFile.value)
  if (!validation.ok) {
    setAnalyzeMessage('error', validation.error)
    return
  }

  const analysisConfig = buildAnalyzeConfig()
  const categoryNames = categoryPresets.value.map((preset) => preset.name)
  setAnalyzeMessage('', '')
  isAnalyzing.value = true

  try {
    const payload = await buildImagePayload(validation.file)
    const result = await analyzeTransactionImage(analysisConfig, payload, {
      categoryNames,
    })

    if (!result.ok) {
      setAnalyzeMessage('error', result.error || '识别失败，请稍后重试')
      return
    }

    applyDraftFromAI(result.data, analysisConfig, payload.fileName)
    setAnalyzeMessage('success', `识别成功，耗时 ${result.latencyMs}ms，已生成草稿`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '识别失败，请重试'
    setAnalyzeMessage('error', message)
  } finally {
    isAnalyzing.value = false
  }
}

function validateDraft() {
  const amount = Number(draft.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return '金额必须大于 0'
  }

  if (!draft.occurredAtInput) {
    return '请填写交易时间'
  }

  return ''
}

function buildLedgerEntryFromDraft() {
  const nowISO = new Date().toISOString()
  const occurredAtISO = parseInputValueToISO(draft.occurredAtInput) || nowISO
  return {
    amount: Number(draft.amount),
    currency: draft.currency?.trim() || 'CNY',
    occurredAt: occurredAtISO,
    location: draft.location?.trim() || '',
    paymentMethod: draft.paymentMethod?.trim() || '其他',
    merchant: draft.merchant?.trim() || '',
    category: draft.category?.trim() || '其他',
    note: draft.note?.trim() || '',
    transactionType: draft.transactionType === 'income' ? 'income' : 'expense',
    sourceImageName: draft.sourceImageName,
    aiProvider: draft.aiProvider === 'anthropic' ? 'anthropic' : 'openai',
    aiModel: draft.aiModel,
    aiConfidence: typeof draft.aiConfidence === 'number' ? draft.aiConfidence : null,
    createdAt: nowISO,
  }
}

function handleConfirmDraft() {
  const errorMessage = validateDraft()
  if (errorMessage) {
    setAnalyzeMessage('error', errorMessage)
    return
  }

  try {
    const nextEntries = appendLedgerEntry(buildLedgerEntryFromDraft())
    ledgerEntries.value = nextEntries
    setAnalyzeMessage('success', '记账已保存')
    $q.notify({
      type: 'positive',
      message: '记账成功，已写入本地账本',
      position: 'top',
      timeout: 1800,
    })
    resetDraft()
    resetFileSelection()
  } catch (error) {
    const message = error instanceof Error ? error.message : '记账保存失败'
    setAnalyzeMessage('error', message)
  }
}

function formatLedgerAmount(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return '-'
  }
  return `${amount.toFixed(2)} ${currency || 'CNY'}`
}

function formatLedgerTime(isoText) {
  const date = new Date(isoText)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  return date.toLocaleString('zh-CN', {
    hour12: false,
  })
}

function parseAliasesText(aliasesText) {
  if (typeof aliasesText !== 'string') {
    return []
  }
  const aliasSet = new Set()
  const aliases = []
  for (const alias of aliasesText.split(/[,\n，]/)) {
    const normalized = alias.trim()
    if (!normalized || aliasSet.has(normalized)) {
      continue
    }
    aliasSet.add(normalized)
    aliases.push(normalized)
  }
  return aliases
}

function createPresetId() {
  const uuidFactory = globalThis.crypto?.randomUUID
  if (typeof uuidFactory === 'function') {
    return `preset-${uuidFactory.call(globalThis.crypto)}`
  }
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function persistPresets(nextPresets, successText) {
  try {
    categoryPresets.value = saveCategoryPresets(nextPresets)
    setPresetMessage('success', successText)
  } catch (error) {
    const message = error instanceof Error ? error.message : '类别预设保存失败'
    setPresetMessage('error', message)
  }
}

function handleAddPreset() {
  const name = newPresetName.value.trim()
  if (!name) {
    setPresetMessage('error', '请先输入类别名称')
    return
  }

  const normalizedName = normalizeCategoryText(name)
  const duplicated = categoryPresets.value.some(
    (preset) => normalizeCategoryText(preset.name) === normalizedName,
  )
  if (duplicated) {
    setPresetMessage('error', '类别已存在，请直接维护该类别别名')
    return
  }

  const aliases = parseAliasesText(newPresetAliases.value)
  const nextPresets = [
    ...categoryPresets.value,
    {
      id: createPresetId(),
      name,
      aliases,
    },
  ]

  persistPresets(nextPresets, `类别 ${name} 已添加`)
  newPresetName.value = ''
  newPresetAliases.value = ''
}

function handleDeletePreset(presetId) {
  const nextPresets = categoryPresets.value.filter((preset) => preset.id !== presetId)
  persistPresets(nextPresets, '类别预设已删除')
}

function handleAddAlias(presetId) {
  const aliasInput = aliasDraftMap[presetId] || ''
  const aliasesToAdd = parseAliasesText(aliasInput)
  if (aliasesToAdd.length === 0) {
    setPresetMessage('error', '请先输入别名')
    return
  }

  const nextPresets = categoryPresets.value.map((preset) => {
    if (preset.id !== presetId) {
      return preset
    }

    const aliasSet = new Set(preset.aliases)
    for (const alias of aliasesToAdd) {
      aliasSet.add(alias)
    }
    return {
      ...preset,
      aliases: [...aliasSet],
    }
  })

  persistPresets(nextPresets, '别名已添加')
  aliasDraftMap[presetId] = ''
}

function handleDeleteAlias(presetId, aliasToDelete) {
  const nextPresets = categoryPresets.value.map((preset) => {
    if (preset.id !== presetId) {
      return preset
    }
    return {
      ...preset,
      aliases: preset.aliases.filter((alias) => alias !== aliasToDelete),
    }
  })
  persistPresets(nextPresets, '别名已删除')
}
</script>

<template>
  <section class="home-shell">
    <div class="hero">
      <p class="hero-tag">AI 智能记账</p>
      <h1 class="hero-title">主页</h1>
      <p class="hero-subtitle">上传交易截图，自动生成可确认的记账草稿</p>
    </div>

    <q-banner
      v-if="!isConfigReady"
      rounded
      class="bg-orange-1 text-orange-10"
      inline-actions
    >
      当前 AI 配置未完成，请先配置 provider、token 与模型。
      <template #action>
        <q-btn flat color="orange-10" label="去配置" @click="emit('request-config')" />
      </template>
    </q-banner>

    <q-card flat bordered class="section-card">
      <q-card-section class="section-title">上传与识别</q-card-section>
      <q-separator />
      <q-card-section class="section-body">
        <q-file
          v-model="selectedFile"
          filled
          clearable
          accept=".jpg,.jpeg,.png,.webp"
          label="上传交易截图（jpg/png/webp，≤8MB）"
          @update:model-value="handleFileChanged"
        />

        <q-btn
          unelevated
          color="primary"
          no-caps
          :loading="isAnalyzing"
          :disable="!isConfigReady || isAnalyzing"
          :label="isAnalyzing ? '识别中...' : '开始识别'"
          @click="handleAnalyze"
        />

        <q-banner
          v-if="analyzeMessage.text"
          dense
          rounded
          :class="analyzeMessage.type === 'error' ? 'bg-negative text-white' : 'bg-positive text-white'"
        >
          {{ analyzeMessage.text }}
        </q-banner>

        <div v-if="previewURL" class="preview-wrap">
          <img :src="previewURL" alt="交易图片预览" class="preview-image" />
        </div>
      </q-card-section>
    </q-card>

    <q-card v-if="hasDraft" flat bordered class="section-card">
      <q-card-section class="section-title">记账草稿</q-card-section>
      <q-separator />
      <q-card-section class="section-body">
        <q-banner v-if="draftHint" dense rounded class="bg-blue-1 text-blue-10">
          {{ draftHint }}
        </q-banner>

        <div class="draft-grid">
          <q-input v-model.number="draft.amount" type="number" filled label="金额" />
          <q-input v-model="draft.currency" filled label="币种" />
          <q-input v-model="draft.occurredAtInput" type="datetime-local" filled label="交易时间" />
          <q-select
            v-model="draft.transactionType"
            :options="TRANSACTION_TYPE_OPTIONS"
            emit-value
            map-options
            filled
            label="收支方向"
          />
          <q-select
            v-model="draft.paymentMethod"
            :options="PAYMENT_METHOD_OPTIONS"
            filled
            label="交易方式"
          />
          <q-input v-model="draft.category" filled label="类别" />
          <q-input v-model="draft.merchant" filled label="商户" />
          <q-input v-model="draft.location" filled label="交易地点" />
          <q-input v-model="draft.note" filled type="textarea" autogrow label="备注" class="draft-note" />
        </div>

        <div class="draft-actions">
          <q-btn
            unelevated
            color="primary"
            no-caps
            label="确认入账"
            :disable="!canConfirmDraft"
            @click="handleConfirmDraft"
          />
          <q-btn flat color="grey-8" no-caps label="清空草稿" @click="resetDraft" />
        </div>
      </q-card-section>
    </q-card>

    <q-card flat bordered class="section-card">
      <q-card-section class="section-title">类别预设</q-card-section>
      <q-separator />
      <q-card-section class="section-body">
        <div class="preset-create-row">
          <q-input v-model="newPresetName" filled label="新增类别" />
          <q-input v-model="newPresetAliases" filled label="别名（逗号分隔）" />
          <q-btn unelevated color="secondary" no-caps label="添加类别" @click="handleAddPreset" />
        </div>

        <q-banner
          v-if="presetMessage.text"
          dense
          rounded
          :class="presetMessage.type === 'error' ? 'bg-negative text-white' : 'bg-positive text-white'"
        >
          {{ presetMessage.text }}
        </q-banner>

        <q-list bordered separator class="rounded-borders bg-white">
          <q-item v-for="preset in categoryPresets" :key="preset.id">
            <q-item-section>
              <div class="preset-name-row">
                <span class="preset-name">{{ preset.name }}</span>
                <q-chip
                  v-for="alias in preset.aliases"
                  :key="`${preset.id}-${alias}`"
                  removable
                  dense
                  color="teal-1"
                  text-color="teal-10"
                  @remove="handleDeleteAlias(preset.id, alias)"
                >
                  {{ alias }}
                </q-chip>
              </div>

              <div class="alias-row">
                <q-input
                  v-model="aliasDraftMap[preset.id]"
                  dense
                  filled
                  label="新增别名（逗号分隔）"
                  @keyup.enter="handleAddAlias(preset.id)"
                />
                <q-btn dense unelevated color="secondary" no-caps label="添加别名" @click="handleAddAlias(preset.id)" />
              </div>
            </q-item-section>

            <q-item-section side>
              <q-btn flat dense color="negative" icon="delete" @click="handleDeletePreset(preset.id)" />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>
    </q-card>

    <q-card flat bordered class="section-card">
      <q-card-section class="section-title">最近账单</q-card-section>
      <q-separator />
      <q-card-section class="section-body">
        <q-banner v-if="sortedLedgerEntries.length === 0" rounded class="bg-grey-2 text-grey-7">
          暂无账单，先上传交易图片试试。
        </q-banner>

        <q-list v-else bordered separator class="rounded-borders bg-white">
          <q-item v-for="entry in sortedLedgerEntries" :key="entry.id">
            <q-item-section>
              <div class="ledger-main-row">
                <span class="ledger-category">{{ entry.category }}</span>
                <q-chip dense :color="entry.transactionType === 'income' ? 'positive' : 'negative'" text-color="white">
                  {{ entry.transactionType === 'income' ? '收入' : '支出' }}
                </q-chip>
              </div>
              <div class="ledger-sub-row">
                <span>金额：{{ formatLedgerAmount(entry.amount, entry.currency) }}</span>
                <span>时间：{{ formatLedgerTime(entry.occurredAt) }}</span>
              </div>
              <div class="ledger-sub-row">
                <span>商户：{{ entry.merchant || '-' }}</span>
                <span>方式：{{ entry.paymentMethod || '-' }}</span>
              </div>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>
    </q-card>
  </section>
</template>

<style scoped>
.home-shell {
  width: min(100%, 1000px);
  display: grid;
  gap: 1rem;
}

.hero {
  text-align: center;
  display: grid;
  gap: 0.35rem;
}

.hero-tag {
  color: #0e7490;
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}

.hero-title {
  margin: 0;
  font-size: clamp(1.5rem, 2.6vw, 2rem);
  color: #0f172a;
  font-weight: 700;
}

.hero-subtitle {
  margin: 0;
  color: #475569;
  font-size: 0.94rem;
}

.section-card {
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(10px);
}

.section-title {
  font-weight: 700;
  color: #0f172a;
}

.section-body {
  display: grid;
  gap: 0.8rem;
}

.preview-wrap {
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #cbd5e1;
  background: #f8fafc;
}

.preview-image {
  width: 100%;
  max-height: 360px;
  object-fit: contain;
  display: block;
}

.draft-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.7rem;
}

.draft-note {
  grid-column: 1 / -1;
}

.draft-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}

.preset-create-row {
  display: grid;
  grid-template-columns: minmax(150px, 0.8fr) 1fr auto;
  gap: 0.55rem;
}

.preset-name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.preset-name {
  font-weight: 700;
  color: #0f172a;
}

.alias-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.45rem;
  margin-top: 0.35rem;
}

.ledger-main-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.ledger-category {
  font-weight: 700;
  color: #0f172a;
}

.ledger-sub-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  color: #475569;
  font-size: 0.9rem;
}

@media (max-width: 760px) {
  .draft-grid {
    grid-template-columns: 1fr;
  }

  .preset-create-row {
    grid-template-columns: 1fr;
  }

  .alias-row {
    grid-template-columns: 1fr;
  }
}
</style>
