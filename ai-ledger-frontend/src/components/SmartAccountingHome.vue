<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { analyzeTransactionImage } from '../services/aiProviders'
import { matchCategoryPreset } from '../services/categoryMatcher'
import { buildHomeLedgerSummary, DEFAULT_HOME_INCOME_CATEGORY_NAMES, mergeHomeLedgerEntry } from '../services/homeLedgerSummary'
import { useSelectPopupPolicy } from '../services/selectPopupPolicy'
import { appendLedgerEntry, ensureLedgerStoreReady, listAllLedgerEntries, loadCategoryPresets } from '../services/storage'

const props = defineProps({
  aiConfig: { type: Object, required: true },
  isConfigReady: { type: Boolean, default: false },
})

const emit = defineEmits(['request-config'])
const $q = useQuasar()

/** AI 识别支持的最大图片体积（MB）。 */
const MAX_IMAGE_SIZE_MB = 8
/** AI 识别支持的最大图片体积（字节）。 */
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024
/** AI 上传支持的 MIME 列表。 */
const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']
/** 记账表单可选的支付方式。 */
const PAYMENT_METHOD_OPTIONS = ['现金', '微信', '支付宝', '银行卡', '信用卡', 'Apple Pay', '其他']
/** 记账表单可选的交易类型。 */
const TRANSACTION_TYPE_OPTIONS = [
  { label: '支出', value: 'expense' },
  { label: '收入', value: 'income' },
]
/** 类别卡片的图标与配色映射。 */
const CATEGORY_CARD_META = Object.freeze({
  餐饮: { icon: 'lunch_dining', accent: '#f1c75b', surface: 'linear-gradient(180deg, #f8efd8 0%, #f5ead0 100%)' },
  交通: { icon: 'directions_bus', accent: '#5f92e5', surface: 'linear-gradient(180deg, #dce7fb 0%, #d6e3f8 100%)' },
  购物: { icon: 'shopping_bag', accent: '#ea6a64', surface: 'linear-gradient(180deg, #f8e0e2 0%, #f5d9dc 100%)' },
  娱乐: { icon: 'sports_esports', accent: '#b57adf', surface: 'linear-gradient(180deg, #efe3f7 0%, #eadcf5 100%)' },
  医疗: { icon: 'medical_services', accent: '#68d2c0', surface: 'linear-gradient(180deg, #daf5f0 0%, #d5f0eb 100%)' },
  学习: { icon: 'school', accent: '#68d2c0', surface: 'linear-gradient(180deg, #daf5f0 0%, #d5f0eb 100%)' },
  医教: { icon: 'health_and_safety', accent: '#68d2c0', surface: 'linear-gradient(180deg, #daf5f0 0%, #d5f0eb 100%)' },
  居住: { icon: 'home_work', accent: '#e59a58', surface: 'linear-gradient(180deg, #f6e7dc 0%, #f3dfcf 100%)' },
  居家: { icon: 'fireplace', accent: '#e59a58', surface: 'linear-gradient(180deg, #f6e7dc 0%, #f3dfcf 100%)' },
  人情: { icon: 'favorite', accent: '#ea8eb1', surface: 'linear-gradient(180deg, #f9e1ea 0%, #f4d7e2 100%)' },
  父母: { icon: 'family_restroom', accent: '#7d95d9', surface: 'linear-gradient(180deg, #dee5f7 0%, #d6def3 100%)' },
  宠物: { icon: 'pets', accent: '#63c98c', surface: 'linear-gradient(180deg, #dcf3e8 0%, #d4eddf 100%)' },
  其他: { icon: 'widgets', accent: '#94a3b8', surface: 'linear-gradient(180deg, #eef2f7 0%, #e6ebf2 100%)' },
  工资: { icon: 'account_balance_wallet', accent: '#4fc5b6', surface: 'linear-gradient(180deg, #d4f4ee 0%, #caeee7 100%)' },
  奖金: { icon: 'emoji_events', accent: '#f0c55d', surface: 'linear-gradient(180deg, #faefd5 0%, #f7e7c3 100%)' },
  兼职: { icon: 'schedule', accent: '#e49a56', surface: 'linear-gradient(180deg, #f7e6d7 0%, #f3deca 100%)' },
})

const selectedFile = ref(null)
const previewURL = ref('')
const isAiDialogVisible = ref(false)
const isAnalyzing = ref(false)
const isDraftDialogVisible = ref(false)
const isDraftSaving = ref(false)
const isHomeLoading = ref(false)
const analyzeMessage = ref({ type: '', text: '' })
const homeMessage = ref({ type: '', text: '' })
const draftHint = ref('')
const summaryRequestId = ref(0)
const ledgerEntries = ref([])
const categoryPresets = ref([])
const categoryPresetOptions = ref([])

const draft = reactive(createEmptyDraft())
const draftSelectPopupPolicy = useSelectPopupPolicy($q)

const canConfirmDraft = computed(() => {
  const amount = Number(draft.amount)
  return Number.isFinite(amount) && amount > 0
})
const draftDialogTitle = computed(() => (draft.sourceImageName ? 'AI记账草稿' : '手动记账'))
const draftDialogDescription = computed(() => (
  draft.sourceImageName ? '识别结果可直接修改，确认后写入账本。' : '请补充交易信息后确认入账。'
))
const homeSummary = computed(() => buildHomeLedgerSummary({
  entries: ledgerEntries.value,
  categoryPresets: categoryPresets.value,
  incomeCategoryNames: DEFAULT_HOME_INCOME_CATEGORY_NAMES,
  now: new Date(),
}))
const expenseCards = computed(() => homeSummary.value.expenseCards.map((card) => ({ ...card, ...resolveCategoryCardMeta(card.name, 'expense') })))
const incomeCards = computed(() => homeSummary.value.incomeCards.map((card) => ({ ...card, ...resolveCategoryCardMeta(card.name, 'income') })))

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

onMounted(async () => {
  await refreshHomeData()
})

onBeforeUnmount(() => {
  revokePreviewURL()
})

/**
 * 创建空白记账草稿。
 *
 * @returns {{
 *   amount: string,
 *   currency: string,
 *   occurredAtInput: string,
 *   location: string,
 *   paymentMethod: string,
 *   merchant: string,
 *   category: string,
 *   note: string,
 *   transactionType: 'expense' | 'income',
 *   sourceImageName: string,
 *   aiProvider: 'openai' | 'anthropic',
 *   aiModel: string,
 *   aiConfidence: number | null
 * }} 初始化草稿对象。
 */
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

/**
 * 统一设置首页反馈消息。
 *
 * @param {'success' | 'error' | ''} type 消息类型。
 * @param {string} text 消息文本。
 * @returns {void} 无返回值。
 */
function setHomeMessage(type, text) {
  homeMessage.value = { type, text }
}

/**
 * 统一设置 AI 上传弹窗反馈消息。
 *
 * @param {'success' | 'error' | ''} type 消息类型。
 * @param {string} text 消息文本。
 * @returns {void} 无返回值。
 */
function setAnalyzeMessage(type, text) {
  analyzeMessage.value = { type, text }
}

/**
 * 刷新首页所需的账单与类别数据。
 *
 * @param {{silent?: boolean}} [options={}] 刷新选项；`silent` 为 `true` 时仅静默对齐数据，不展示骨架屏。
 * @returns {Promise<void>} 无返回值。
 */
async function refreshHomeData(options = {}) {
  const { silent = false } = options
  const requestId = summaryRequestId.value + 1
  summaryRequestId.value = requestId
  if (!silent) {
    isHomeLoading.value = true
  }

  try {
    await ensureLedgerStoreReady()
    const latestCategoryPresets = loadCategoryPresets()
    const latestLedgerEntries = await listAllLedgerEntries()
    if (requestId !== summaryRequestId.value) {
      return
    }

    categoryPresets.value = latestCategoryPresets
    refreshCategoryPresetOptions(latestCategoryPresets)
    ledgerEntries.value = latestLedgerEntries
    setHomeMessage('', '')
  } catch (error) {
    if (requestId !== summaryRequestId.value) {
      return
    }
    const message = error instanceof Error ? error.message : '首页数据加载失败'
    setHomeMessage('error', message)
  } finally {
    if (requestId === summaryRequestId.value) {
      isHomeLoading.value = false
    }
  }
}

/**
 * 构建类别下拉选项，并补入首页固定收入类别。
 *
 * @param {Array<{name?: string}>} [presets=[]] 当前类别预设。
 * @returns {void} 无返回值。
 */
function refreshCategoryPresetOptions(presets = []) {
  const optionSet = new Set()
  const nextOptions = []

  for (const preset of Array.isArray(presets) ? presets : []) {
    const normalizedName = typeof preset?.name === 'string' ? preset.name.trim() : ''
    if (!normalizedName || optionSet.has(normalizedName)) {
      continue
    }
    optionSet.add(normalizedName)
    nextOptions.push(normalizedName)
  }

  for (const incomeName of DEFAULT_HOME_INCOME_CATEGORY_NAMES) {
    if (optionSet.has(incomeName)) {
      continue
    }
    optionSet.add(incomeName)
    nextOptions.push(incomeName)
  }

  categoryPresetOptions.value = nextOptions
}

/**
 * 处理类别输入框文本更新，保证可录入自定义类别。
 *
 * @param {string} inputValue 当前输入值。
 * @returns {void} 无返回值。
 */
function handleCategoryInputValue(inputValue) {
  draft.category = typeof inputValue === 'string' ? inputValue : ''
}

/**
 * 根据类别名称解析卡片展示元信息。
 *
 * @param {string} categoryName 类别名称。
 * @param {'expense' | 'income'} transactionType 交易类型。
 * @returns {{icon: string, accent: string, surface: string}} 图标与配色配置。
 */
function resolveCategoryCardMeta(categoryName, transactionType) {
  const meta = CATEGORY_CARD_META[categoryName]
  if (meta) {
    return meta
  }

  if (transactionType === 'income') {
    return { icon: 'payments', accent: '#4fc5b6', surface: 'linear-gradient(180deg, #d4f4ee 0%, #caeee7 100%)' }
  }

  return { icon: 'category', accent: '#94a3b8', surface: 'linear-gradient(180deg, #eef2f7 0%, #e6ebf2 100%)' }
}

/**
 * 将数值格式化为首页金额展示文案。
 *
 * @param {unknown} amount 金额值。
 * @returns {string} 最多两位小数的金额文本。
 */
function formatCurrencyAmount(amount) {
  const parsed = Number(amount)
  if (!Number.isFinite(parsed)) {
    return '0'
  }
  return parsed.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}
/**
 * 打开 AI 记账上传弹窗。
 *
 * @returns {void} 无返回值。
 */
function openAiDialog() {
  setAnalyzeMessage('', '')
  isAiDialogVisible.value = true
}

/**
 * 关闭 AI 上传弹窗。
 *
 * @returns {void} 无返回值。
 */
function handleCloseAiDialog() {
  isAiDialogVisible.value = false
}

/**
 * 从 AI 弹窗跳转到配置页。
 *
 * @returns {void} 无返回值。
 */
function handleRequestConfigFromAiDialog() {
  isAiDialogVisible.value = false
  emit('request-config')
}

/**
 * 关闭 AI 上传弹窗后重置上传状态。
 *
 * @returns {void} 无返回值。
 */
function handleAiDialogHide() {
  resetAiDialogState()
}

/**
 * 清空 AI 上传相关状态，避免旧预览与消息残留。
 *
 * @returns {void} 无返回值。
 */
function resetAiDialogState() {
  selectedFile.value = null
  revokePreviewURL()
  setAnalyzeMessage('', '')
}

/**
 * 打开手动记账弹窗，并预填类别与收支类型。
 *
 * @param {{category?: string, transactionType?: 'expense' | 'income'}} [options={}] 预填选项。
 * @returns {void} 无返回值。
 */
function openManualDraftDialog(options = {}) {
  const latestCategoryPresets = loadCategoryPresets()
  categoryPresets.value = latestCategoryPresets
  refreshCategoryPresetOptions(latestCategoryPresets)

  Object.assign(draft, createEmptyDraft())
  draft.occurredAtInput = parseDateToInputValue(new Date())
  draft.transactionType = options.transactionType === 'income' ? 'income' : 'expense'
  draft.category = resolveInitialDraftCategory(options.category, draft.transactionType, latestCategoryPresets)
  draftHint.value = '手动记账模式：请补充交易信息后确认入账。'
  isDraftDialogVisible.value = true
}

/**
 * 解析手动记账时的初始类别。
 *
 * @param {string | undefined} categoryName 目标类别。
 * @param {'expense' | 'income'} transactionType 交易类型。
 * @param {Array<{id?: string, name?: string, aliases?: string[]}>} presets 当前类别预设。
 * @returns {string} 归一化后的初始类别。
 */
function resolveInitialDraftCategory(categoryName, transactionType, presets) {
  if (transactionType === 'income') {
    const normalizedCategory = typeof categoryName === 'string' ? categoryName.trim() : ''
    return normalizedCategory || DEFAULT_HOME_INCOME_CATEGORY_NAMES[0]
  }

  return matchCategoryPreset(categoryName, presets).category
}

/**
 * 处理支出类别卡片点击。
 *
 * @param {{name: string}} card 支出卡片数据。
 * @returns {void} 无返回值。
 */
function handleExpenseCardClick(card) {
  openManualDraftDialog({ category: card.name, transactionType: 'expense' })
}

/**
 * 处理收入类别卡片点击。
 *
 * @param {{name: string}} card 收入卡片数据。
 * @returns {void} 无返回值。
 */
function handleIncomeCardClick(card) {
  openManualDraftDialog({ category: card.name, transactionType: 'income' })
}

/**
 * 将日期对象格式化为 `YYYY-MM-DDTHH:mm`。
 *
 * @param {Date} date 日期对象。
 * @returns {string} 输入框可用的本地时间文本。
 */
function parseDateToInputValue(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

/**
 * 将 AI 返回的交易时间文本转换为输入框可用格式。
 *
 * @param {unknown} occurredAtText AI 返回的交易时间。
 * @returns {string} 输入框时间文本；解析失败返回空字符串。
 */
function parseOccurredAtTextToInputValue(occurredAtText) {
  if (typeof occurredAtText !== 'string') {
    return ''
  }

  const matched = occurredAtText.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
  if (!matched) {
    return ''
  }

  const [, year, month, day, hour, minute, second] = matched
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return parseDateToInputValue(date)
}

/**
 * 将 datetime-local 输入值转换为 ISO 时间。
 *
 * @param {string} inputValue 输入值。
 * @returns {string} ISO 时间文本；解析失败返回空字符串。
 */
function parseInputValueToISO(inputValue) {
  const parsedDate = new Date(inputValue)
  if (Number.isNaN(parsedDate.getTime())) {
    return ''
  }
  return parsedDate.toISOString()
}

/**
 * 归一化 q-file 返回值为单个文件。
 *
 * @param {File | File[] | null | undefined} fileLike 文件值。
 * @returns {File | null} 单个文件对象。
 */
function normalizeInputFile(fileLike) {
  if (!fileLike) {
    return null
  }
  if (Array.isArray(fileLike)) {
    return fileLike[0] || null
  }
  return fileLike
}

/**
 * 判断 MIME 是否在支持范围内。
 *
 * @param {string} mimeType MIME 类型。
 * @returns {boolean} 是否支持。
 */
function isSupportedMimeType(mimeType) {
  return SUPPORTED_MIME_TYPES.includes(mimeType)
}

/**
 * 检测文件 MIME 类型，必要时回退到后缀推断。
 *
 * @param {File | null | undefined} file 文件对象。
 * @returns {string} 识别出的 MIME 类型；失败返回空字符串。
 */
function detectMimeType(file) {
  if (file?.type && isSupportedMimeType(file.type)) {
    return file.type
  }

  const normalizedFileName = typeof file?.name === 'string' ? file.name.toLowerCase() : ''
  if (normalizedFileName.endsWith('.jpg') || normalizedFileName.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  if (normalizedFileName.endsWith('.png')) {
    return 'image/png'
  }
  if (normalizedFileName.endsWith('.webp')) {
    return 'image/webp'
  }
  return ''
}
/**
 * 校验上传文件的存在性、类型与大小。
 *
 * @param {File | File[] | null | undefined} file 文件对象。
 * @returns {{ok: true, file: File, mimeType: string} | {ok: false, error: string}} 校验结果。
 */
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

/**
 * 处理上传文件变化并同步提示信息。
 *
 * @param {File | File[] | null | undefined} nextFile 新文件值。
 * @returns {void} 无返回值。
 */
function handleFileChanged(nextFile) {
  const validation = validateSelectedFile(nextFile)
  if (!validation.ok) {
    selectedFile.value = null
    if (nextFile) {
      setAnalyzeMessage('error', validation.error)
      return
    }
    setAnalyzeMessage('', '')
    return
  }

  selectedFile.value = validation.file
  setAnalyzeMessage('', '')
}

/**
 * 释放当前图片预览资源，避免内存泄漏。
 *
 * @returns {void} 无返回值。
 */
function revokePreviewURL() {
  if (!previewURL.value) {
    return
  }
  URL.revokeObjectURL(previewURL.value)
  previewURL.value = ''
}

/**
 * 将文件读取为 DataURL。
 *
 * @param {File} file 文件对象。
 * @returns {Promise<string>} DataURL 字符串。
 */
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

/**
 * 构建图片识别请求载荷。
 *
 * @param {File} file 文件对象。
 * @returns {Promise<{mimeType: string, base64Data: string, fileName: string}>} 图片载荷。
 */
async function buildImagePayload(file) {
  const mimeType = detectMimeType(file)
  if (!mimeType) {
    throw new Error('图片格式不受支持，请重新上传')
  }

  const dataURL = await fileToDataURL(file)
  const splitIndex = dataURL.indexOf(',')
  if (splitIndex <= 0) {
    throw new Error('图片读取结果异常，请重新上传')
  }

  return {
    mimeType,
    base64Data: dataURL.slice(splitIndex + 1),
    fileName: file.name || 'transaction-image',
  }
}

/**
 * 提取当前 AI 识别配置。
 *
 * @returns {{provider: 'openai' | 'anthropic', baseURL: string, token: string, model: string}} 识别配置。
 */
function buildAnalyzeConfig() {
  const provider = props.aiConfig?.provider === 'anthropic' ? 'anthropic' : 'openai'
  return {
    provider,
    baseURL: props.aiConfig?.baseURL || '',
    token: props.aiConfig?.token || '',
    model: props.aiConfig?.providerModels?.[provider]?.currentModel || '',
  }
}

/**
 * 判断识别结果是否具备可生成草稿的关键字段。
 *
 * @param {unknown} data 识别结果。
 * @returns {boolean} 是否可用。
 */
function isValidAnalyzeResult(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false
  }
  return 'amount' in data && 'currency' in data && 'category' in data && 'transactionType' in data
}

/**
 * 将 AI 识别结果写入草稿表单。
 *
 * @param {{
 *   amount: number | null,
 *   currency: string | null,
 *   occurredAt: string | null,
 *   location: string | null,
 *   paymentMethod: string | null,
 *   merchant: string | null,
 *   category: string | null,
 *   note: string | null,
 *   transactionType: 'expense' | 'income' | null,
 *   confidence: number | null
 * }} parsedData AI 识别结果。
 * @param {{provider: 'openai' | 'anthropic', model: string}} analysisConfig 识别配置。
 * @param {string} sourceImageName 源图片文件名。
 * @param {Array<{id?: string, name?: string, aliases?: string[]}>} latestCategoryPresets 最新类别预设。
 * @returns {void} 无返回值。
 */
function applyDraftFromAI(parsedData, analysisConfig, sourceImageName, latestCategoryPresets) {
  const fallbackDate = parseDateToInputValue(new Date())
  const parsedOccurredAt = parseOccurredAtTextToInputValue(parsedData.occurredAt)
  const occurredAtInput = parsedOccurredAt || fallbackDate
  const normalizedTransactionType = parsedData.transactionType === 'income' ? 'income' : 'expense'
  const normalizedCategory = normalizedTransactionType === 'expense'
    ? matchCategoryPreset(parsedData.category, latestCategoryPresets).category
    : (typeof parsedData.category === 'string' && parsedData.category.trim()) || DEFAULT_HOME_INCOME_CATEGORY_NAMES[0]

  draft.amount = parsedData.amount ?? ''
  draft.currency = parsedData.currency || 'CNY'
  draft.occurredAtInput = occurredAtInput
  draft.location = parsedData.location || ''
  draft.paymentMethod = parsedData.paymentMethod || '其他'
  draft.merchant = parsedData.merchant || ''
  draft.category = normalizedCategory
  draft.note = parsedData.note || ''
  draft.transactionType = normalizedTransactionType
  draft.sourceImageName = sourceImageName
  draft.aiProvider = analysisConfig.provider
  draft.aiModel = analysisConfig.model
  draft.aiConfidence = parsedData.confidence
  draftHint.value = parsedOccurredAt ? '' : 'AI 未识别到交易时间，已使用当前时间，请手动确认。'
  isAiDialogVisible.value = false
  isDraftDialogVisible.value = true
}

/**
 * 执行 AI 图片识别主流程。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleAnalyze() {
  if (!props.isConfigReady) {
    setAnalyzeMessage('error', '请先完成 AI 配置并保存，再进行图片识别')
    return
  }

  const validation = validateSelectedFile(selectedFile.value)
  if (!validation.ok) {
    setAnalyzeMessage('error', validation.error)
    return
  }

  const latestCategoryPresets = loadCategoryPresets()
  const categoryNames = latestCategoryPresets.map((preset) => preset.name)
  const analysisConfig = buildAnalyzeConfig()
  setAnalyzeMessage('', '')
  isAnalyzing.value = true

  try {
    const payload = await buildImagePayload(validation.file)
    const result = await analyzeTransactionImage(analysisConfig, payload, { categoryNames })

    if (!result.ok) {
      setAnalyzeMessage('error', result.error || '识别失败，请稍后重试')
      return
    }

    if (!isValidAnalyzeResult(result.data)) {
      setAnalyzeMessage('error', '识别结果格式异常，未能生成草稿，请重试')
      return
    }

    categoryPresets.value = latestCategoryPresets
    refreshCategoryPresetOptions(latestCategoryPresets)
    applyDraftFromAI(result.data, analysisConfig, payload.fileName, latestCategoryPresets)
  } catch (error) {
    const message = error instanceof Error ? error.message : '识别失败，请重试'
    setAnalyzeMessage('error', message)
  } finally {
    isAnalyzing.value = false
  }
}

/**
 * 关闭记账草稿弹窗。
 *
 * @returns {void} 无返回值。
 */
function handleCloseDraftDialog() {
  isDraftDialogVisible.value = false
}

/**
 * 草稿弹窗隐藏后清空草稿，避免旧数据残留到下次记账。
 *
 * @returns {void} 无返回值。
 */
function handleDraftDialogHide() {
  Object.assign(draft, createEmptyDraft())
  draftHint.value = ''
}

/**
 * 校验当前草稿是否可入账。
 *
 * @returns {string} 错误提示；空字符串代表校验通过。
 */
function validateDraft() {
  const amount = Number(draft.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return '请输入大于 0 的金额'
  }
  if (!draft.occurredAtInput) {
    return '请选择交易时间'
  }
  return ''
}

/**
 * 构建可写入账本的标准账单对象。
 *
 * @returns {{
 *   amount: number,
 *   currency: string,
 *   occurredAt: string,
 *   location: string,
 *   paymentMethod: string,
 *   merchant: string,
 *   category: string,
 *   note: string,
 *   transactionType: 'expense' | 'income',
 *   sourceImageName: string,
 *   aiProvider: 'openai' | 'anthropic',
 *   aiModel: string,
 *   aiConfidence: number | null,
 *   createdAt: string
 * }} 标准账单对象。
 */
function buildLedgerEntryFromDraft() {
  const latestCategoryPresets = loadCategoryPresets()
  const nowISO = new Date().toISOString()
  const occurredAtISO = parseInputValueToISO(draft.occurredAtInput) || nowISO
  const normalizedTransactionType = draft.transactionType === 'income' ? 'income' : 'expense'
  const normalizedCategory = normalizedTransactionType === 'expense'
    ? matchCategoryPreset(draft.category, latestCategoryPresets).category
    : (typeof draft.category === 'string' && draft.category.trim()) || DEFAULT_HOME_INCOME_CATEGORY_NAMES[0]

  return {
    amount: Number(draft.amount),
    currency: draft.currency?.trim() || 'CNY',
    occurredAt: occurredAtISO,
    location: draft.location?.trim() || '',
    paymentMethod: draft.paymentMethod?.trim() || '其他',
    merchant: draft.merchant?.trim() || '',
    category: normalizedCategory,
    note: draft.note?.trim() || '',
    transactionType: normalizedTransactionType,
    sourceImageName: draft.sourceImageName,
    aiProvider: draft.aiProvider === 'anthropic' ? 'anthropic' : 'openai',
    aiModel: draft.aiModel,
    aiConfidence: typeof draft.aiConfidence === 'number' ? draft.aiConfidence : null,
    createdAt: nowISO,
  }
}

/**
 * 确认草稿并写入账本，然后刷新首页汇总。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleConfirmDraft() {
  const errorMessage = validateDraft()
  if (errorMessage) {
    $q.notify({ type: 'negative', message: errorMessage, position: 'top', timeout: 1800 })
    return
  }

  isDraftSaving.value = true
  try {
    const savedEntry = await appendLedgerEntry(buildLedgerEntryFromDraft())
    // 先本地更新数字，再静默回拉云端账本，兼顾响应速度与多端一致性。
    ledgerEntries.value = mergeHomeLedgerEntry(ledgerEntries.value, savedEntry)
    void refreshHomeData({ silent: true })
    isDraftDialogVisible.value = false
    $q.notify({ type: 'positive', message: '记账成功，已写入账本', position: 'top', timeout: 1800 })
  } catch (error) {
    const message = error instanceof Error ? error.message : '记账保存失败'
    $q.notify({ type: 'negative', message, position: 'top', timeout: 2000 })
  } finally {
    isDraftSaving.value = false
  }
}
</script>
<template>
  <section class="home-shell">
    <q-banner v-if="homeMessage.text" rounded dense
      :class="homeMessage.type === 'error' ? 'bg-negative text-white' : 'bg-positive text-white'">
      {{ homeMessage.text }}
    </q-banner>

    <section class="summary-section">
      <div class="summary-header">
        <p class="summary-month">本月</p>
        <p class="summary-label">支出</p>
        <div v-if="isHomeLoading" class="summary-skeleton-wrap">
          <q-skeleton type="text" width="120px" height="42px" />
        </div>
        <h1 v-else class="summary-amount">¥{{ formatCurrencyAmount(homeSummary.expenseTotal) }}</h1>
      </div>

      <div class="category-grid">
        <template v-if="isHomeLoading">
          <q-skeleton v-for="index in 6" :key="`expense-skeleton-${index}`" class="category-skeleton" />
        </template>

        <button v-for="card in expenseCards" v-else :key="`expense-${card.name}`" type="button" class="category-card"
          :style="{ background: card.surface }" @click="handleExpenseCardClick(card)">
          <span class="category-card__name">{{ card.name }}</span>
          <span class="category-card__icon" :style="{ backgroundColor: card.accent }">
            <q-icon :name="card.icon" />
          </span>
          <span class="category-card__amount">¥{{ formatCurrencyAmount(card.amount) }}</span>
        </button>
      </div>
    </section>

    <section class="summary-section summary-section--income">
      <div class="summary-header summary-header--income">
        <p class="summary-label">收入</p>
        <div v-if="isHomeLoading" class="summary-skeleton-wrap">
          <q-skeleton type="text" width="96px" height="36px" />
        </div>
        <h2 v-else class="summary-amount summary-amount--income">¥{{ formatCurrencyAmount(homeSummary.incomeTotal) }}
        </h2>
      </div>

      <div class="category-grid category-grid--income">
        <template v-if="isHomeLoading">
          <q-skeleton v-for="index in 3" :key="`income-skeleton-${index}`" class="category-skeleton" />
        </template>

        <button v-for="card in incomeCards" v-else :key="`income-${card.name}`" type="button" class="category-card"
          :style="{ background: card.surface }" @click="handleIncomeCardClick(card)">
          <span class="category-card__name">{{ card.name }}</span>
          <span class="category-card__icon" :style="{ backgroundColor: card.accent }">
            <q-icon :name="card.icon" />
          </span>
          <span class="category-card__amount">¥{{ formatCurrencyAmount(card.amount) }}</span>
        </button>
      </div>
    </section>

    <button type="button" class="ai-entry" @click="openAiDialog">
      <span class="ai-entry__icon">
        <q-icon name="auto_awesome" />
      </span>
      <span class="ai-entry__label">AI记账</span>
    </button>

    <q-dialog v-model="isAiDialogVisible" :persistent="isAnalyzing" @hide="handleAiDialogHide">
      <q-card class="ai-dialog">
        <q-card-section class="dialog-header">
          <div>
            <p class="text-h6 text-weight-bold">AI记账</p>
            <p class="text-caption text-grey-7">上传交易截图，识别后进入草稿复核。</p>
          </div>
          <q-btn flat round dense icon="close" :disable="isAnalyzing" @click="handleCloseAiDialog" />
        </q-card-section>

        <q-separator />

        <q-card-section class="dialog-body">
          <q-banner v-if="!isConfigReady" dense rounded class="bg-orange-1 text-orange-10" inline-actions>
            当前尚未完成 AI 配置，请先配置后再识别图片。
            <template #action>
              <q-btn flat color="orange-10" label="去配置" @click="handleRequestConfigFromAiDialog" />
            </template>
          </q-banner>

          <q-file v-model="selectedFile" filled clearable accept=".jpg,.jpeg,.png,.webp"
            label="上传交易截图（jpg/png/webp，≤8MB）" @update:model-value="handleFileChanged" />

          <div class="dialog-actions">
            <q-btn unelevated color="primary" no-caps :loading="isAnalyzing" :disable="!isConfigReady || isAnalyzing"
              :label="isAnalyzing ? '正在识别...' : '开始识别'" @click="handleAnalyze" />
            <q-btn flat color="grey-8" no-caps label="清空图片" :disable="isAnalyzing" @click="resetAiDialogState" />
          </div>

          <q-banner v-if="analyzeMessage.text" dense rounded
            :class="analyzeMessage.type === 'error' ? 'bg-negative text-white' : 'bg-positive text-white'">
            {{ analyzeMessage.text }}
          </q-banner>

          <div v-if="previewURL" class="preview-wrap">
            <img :src="previewURL" alt="交易图片预览" class="preview-image" />
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>
    <q-dialog v-model="isDraftDialogVisible" :persistent="isDraftSaving" @hide="handleDraftDialogHide">
      <q-card class="draft-dialog">
        <q-card-section class="dialog-header">
          <div>
            <p class="text-h6 text-weight-bold">{{ draftDialogTitle }}</p>
            <p class="text-caption text-grey-7">{{ draftDialogDescription }}</p>
          </div>
          <q-btn flat round dense icon="close" :disable="isDraftSaving" @click="handleCloseDraftDialog" />
        </q-card-section>

        <q-separator />

        <q-card-section class="dialog-body">
          <q-banner v-if="draftHint" dense rounded class="bg-blue-1 text-blue-10">
            {{ draftHint }}
          </q-banner>

          <div class="draft-grid">
            <q-input v-model.number="draft.amount" type="number" filled label="金额" />
            <q-input v-model="draft.currency" filled label="币种" />
            <q-input v-model="draft.occurredAtInput" type="datetime-local" filled label="交易时间" />
            <q-select v-model="draft.transactionType" :options="TRANSACTION_TYPE_OPTIONS" emit-value map-options filled
              label="交易类型" :behavior="draftSelectPopupPolicy.behavior.value"
              :menu-anchor="draftSelectPopupPolicy.menuAnchor" :menu-self="draftSelectPopupPolicy.menuSelf"
              :menu-offset="draftSelectPopupPolicy.menuOffset"
              :popup-content-style="draftSelectPopupPolicy.popupContentStyle" />
            <q-select v-model="draft.paymentMethod" :options="PAYMENT_METHOD_OPTIONS" filled label="支付方式"
              :behavior="draftSelectPopupPolicy.behavior.value" :menu-anchor="draftSelectPopupPolicy.menuAnchor"
              :menu-self="draftSelectPopupPolicy.menuSelf" :menu-offset="draftSelectPopupPolicy.menuOffset"
              :popup-content-style="draftSelectPopupPolicy.popupContentStyle" />
            <q-select v-model="draft.category" :options="categoryPresetOptions"
              :behavior="draftSelectPopupPolicy.behavior.value" :menu-anchor="draftSelectPopupPolicy.menuAnchor"
              :menu-self="draftSelectPopupPolicy.menuSelf" :menu-offset="draftSelectPopupPolicy.menuOffset"
              :popup-content-style="draftSelectPopupPolicy.popupContentStyle" use-input fill-input hide-selected
              input-debounce="0" filled label="类别" @input-value="handleCategoryInputValue" />
            <q-input v-model="draft.merchant" filled label="商户" />
            <q-input v-model="draft.location" filled label="交易地点" />
            <q-input v-model="draft.note" filled type="textarea" autogrow label="备注" class="draft-note" />
          </div>

          <div class="dialog-actions">
            <q-btn unelevated color="primary" no-caps label="确认入账" :loading="isDraftSaving"
              :disable="!canConfirmDraft || isDraftSaving" @click="handleConfirmDraft" />
            <q-btn flat color="grey-8" no-caps label="取消" :disable="isDraftSaving" @click="handleCloseDraftDialog" />
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>
  </section>
</template>

<style scoped>
.home-shell {
  width: 100%;
  max-width: 1000px;
  min-width: 0;
  display: grid;
  gap: 1rem;
  padding-bottom: calc(8.5rem + env(safe-area-inset-bottom));
}

.summary-section {
  display: grid;
  gap: 0.9rem;
}

.summary-section--income {
  padding-top: 0.4rem;
}

.summary-header {
  display: grid;
  justify-items: center;
  gap: 0.15rem;
}

.summary-header--income {
  gap: 0.2rem;
}

.summary-month {
  margin: 0;
  color: #0f172a;
  font-size: 1.15rem;
  font-weight: 700;
}

.summary-label {
  margin: 0;
  color: #475569;
  font-size: 1.1rem;
  font-weight: 700;
}

.summary-skeleton-wrap {
  display: flex;
  justify-content: center;
}

.summary-amount {
  margin: 0;
  color: #0f172a;
  font-size: clamp(2rem, 6vw, 2.5rem);
  font-weight: 800;
  letter-spacing: -0.04em;
}

.summary-amount--income {
  font-size: clamp(1.65rem, 5vw, 2rem);
}

.category-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.9rem;
}

.category-grid--income {
  gap: 0.95rem;
}

.category-card {
  min-height: 10.8rem;
  border: 0;
  border-radius: 22px;
  box-shadow: 0 14px 30px rgba(148, 163, 184, 0.18);
  padding: 1rem 0.85rem 0.9rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  color: #1f2937;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}

.category-card__name {
  font-size: 1.05rem;
  font-weight: 700;
}

.category-card__icon {
  width: 3rem;
  height: 3rem;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 1.45rem;
  box-shadow: 0 10px 18px rgba(15, 23, 42, 0.14);
}

.category-card__amount {
  font-size: 1.55rem;
  font-weight: 800;
}

.category-skeleton {
  height: 10.8rem;
  border-radius: 22px;
}

.ai-entry {
  position: fixed;
  left: 20%;
  bottom: calc(4.9rem + env(safe-area-inset-bottom));
  z-index: 41;
  display: inline-flex;
  align-items: center;
  gap: 0.42rem;
  padding: 0.4rem 0.8rem 0.4rem 0.45rem;
  border: 0;
  border-radius: 999px;
  color: #5b51d8;
  background: transparent;
  transform: translateX(-50%);
  cursor: pointer;
}

.ai-entry__icon {
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* background: linear-gradient/(180deg, #efe6ff 0%, #e4dcff 100%); */
  font-size: 1.2rem;

}

.ai-entry__label {
  font-size: 0.95rem;
  font-weight: 700;
}

.ai-dialog,
.draft-dialog {
  width: min(760px, 96vw);
  max-height: calc(var(--app-viewport-height, 100vh) - 16px);
  border-radius: 20px;
  display: flex;
  flex-direction: column;
}

.dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
  flex: 0 0 auto;
}

.dialog-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  gap: 0.75rem;
  padding-bottom: max(0.8rem, env(safe-area-inset-bottom));
}

.dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}

.preview-wrap {
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid #dbe4f0;
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

@media (hover: hover) {

  .category-card:hover,
  .ai-entry:hover {
    transform: translateY(-2px);
  }

  .category-card:hover {
    box-shadow: 0 18px 36px rgba(148, 163, 184, 0.24);
  }
}

@media (min-width: 960px) {
  .category-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .category-grid--income {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .home-shell {
    gap: 0.9rem;
    padding-bottom: calc(7.8rem + env(safe-area-inset-bottom));
  }

  .summary-month {
    font-size: 1.05rem;
  }

  .summary-label {
    font-size: 1rem;
  }

  .category-grid {
    gap: 0.72rem;
  }

  .category-card {
    min-height: 9.7rem;
    padding: 0.85rem 0.7rem 0.8rem;
    border-radius: 20px;
  }

  .category-card__name {
    font-size: 0.98rem;
  }

  .category-card__icon {
    width: 2.8rem;
    height: 2.8rem;
    font-size: 1.28rem;
  }

  .category-card__amount {
    font-size: 1.35rem;
  }

  .category-skeleton {
    height: 9.7rem;
    border-radius: 20px;
  }

  .ai-entry {
    bottom: calc(5.9rem + env(safe-area-inset-bottom));
    padding-inline: 0.72rem;
  }

  .draft-grid {
    grid-template-columns: 1fr;
  }
}
</style>
