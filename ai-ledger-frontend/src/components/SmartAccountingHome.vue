<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { analyzeTransactionImage } from '../services/aiProviders'
import { matchCategoryPreset } from '../services/categoryMatcher'
import { useSelectPopupPolicy } from '../services/selectPopupPolicy'
import {
  appendLedgerEntry,
  deleteLedgerEntry,
  ensureLedgerStoreReady,
  listAllLedgerEntries,
  listLedgerEntriesByDate,
  listRecentLedgerEntries,
  loadCategoryPresets,
  restoreLedgerEntry,
  updateLedgerEntry,
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
// 最近账单默认展示条数。
const RECENT_LEDGER_LIMIT = 30
// 账单页签选项。
const LEDGER_TAB_OPTIONS = [
  { label: '最近账单', value: 'recent' },
  { label: '月账单', value: 'monthly' },
  { label: '全部账单', value: 'all' },
]
// 删除账单后可撤销提示停留时长（毫秒）。
const LEDGER_DELETE_UNDO_TIMEOUT_MS = 5000

const selectedFile = ref(null)
const previewURL = ref('')
const isAnalyzing = ref(false)
const hasDraft = ref(false)
const isDraftDialogVisible = ref(false)
const draftDialogMode = ref('create')
const draftHint = ref('')
const analyzeMessage = ref({ type: '', text: '' })
const isLedgerLoading = ref(false)
const activeLedgerTab = ref('recent')
const selectedLedgerDate = ref(formatDateToYMD(new Date()))
const ledgerEntries = ref([])
const currentLedgerRequestId = ref(0)
const editingLedgerEntryMeta = ref(null)
const draftBackupBeforeEdit = ref(null)
const isLedgerActionLoading = ref(false)
const categoryPresetOptions = ref([])

const draft = reactive(createEmptyDraft())

const visibleLedgerEntries = computed(() => ledgerEntries.value)
// Quasar Screen 插件使用 gt/lt，不提供 gte 字段。
const isDesktop = computed(() => $q.screen.gt.sm)
const draftSelectPopupPolicy = useSelectPopupPolicy($q)

const canConfirmDraft = computed(() => {
  const amount = Number(draft.amount)
  return Number.isFinite(amount) && amount > 0
})

const isEditingDraft = computed(() => draftDialogMode.value === 'edit')

const draftDialogTitle = computed(() => (isEditingDraft.value ? '编辑账单' : '记账草稿'))

const draftDialogDescription = computed(() =>
  isEditingDraft.value ? '可修改后保存覆盖原账单。' : '识别结果可直接修改，确认后写入服务端账本。',
)

const draftConfirmButtonLabel = computed(() => (isEditingDraft.value ? '保存修改' : '确认入账'))

const draftSecondaryButtonLabel = computed(() => (isEditingDraft.value ? '取消' : '清空草稿'))

const selectedLedgerDateLabel = computed(() => formatDateToLabel(selectedLedgerDate.value))

const ledgerEmptyMessage = computed(() => {
  if (activeLedgerTab.value === 'monthly') {
    return `${selectedLedgerDateLabel.value}暂无账单，可点击“手动记账”添加首条记录。`
  }
  if (activeLedgerTab.value === 'all') {
    return '暂无账单，可先手动记账，或完成 AI 配置后上传交易截图识别。'
  }
  return '暂无最近账单，可先手动记账，或完成 AI 配置后上传交易截图识别。'
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

watch(
  () => activeLedgerTab.value,
  () => {
    refreshLedgerEntries()
  },
)

watch(
  () => selectedLedgerDate.value,
  () => {
    if (activeLedgerTab.value !== 'monthly') {
      return
    }
    refreshLedgerEntries()
  },
)

onMounted(async () => {
  try {
    await ensureLedgerStoreReady()
    refreshCategoryPresetOptions()
    await refreshLedgerEntries()
  } catch (error) {
    const message = error instanceof Error ? error.message : '账本初始化失败'
    setAnalyzeMessage('error', message)
  }
})

onBeforeUnmount(() => {
  revokePreviewURL()
})

/**
 * 将日期对象格式化为 `YYYY-MM-DD` 文本。
 *
 * @param {Date} date 日期对象。
 * @returns {string} 日期文本。
 */
function formatDateToYMD(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 将 `YYYY-MM-DD` 文本格式化为页面展示文案。
 *
 * @param {string} dateText 日期文本。
 * @returns {string} 展示文案。
 */
function formatDateToLabel(dateText) {
  const matched = typeof dateText === 'string' ? dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null
  if (!matched) {
    return dateText || '-'
  }
  return `${matched[1]}年${matched[2]}月${matched[3]}日`
}

/**
 * 按当前页签刷新账单列表，带请求序号避免并发响应覆盖。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function refreshLedgerEntries() {
  const requestId = currentLedgerRequestId.value + 1
  currentLedgerRequestId.value = requestId
  isLedgerLoading.value = true

  try {
    let entries = []
    if (activeLedgerTab.value === 'monthly') {
      entries = await listLedgerEntriesByDate(selectedLedgerDate.value)
    } else if (activeLedgerTab.value === 'all') {
      entries = await listAllLedgerEntries()
    } else {
      entries = await listRecentLedgerEntries(RECENT_LEDGER_LIMIT)
    }

    if (requestId !== currentLedgerRequestId.value) {
      return
    }
    ledgerEntries.value = entries
  } catch (error) {
    if (requestId !== currentLedgerRequestId.value) {
      return
    }
    const message = error instanceof Error ? error.message : '账单加载失败'
    setAnalyzeMessage('error', message)
  } finally {
    if (requestId === currentLedgerRequestId.value) {
      isLedgerLoading.value = false
    }
  }
}

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
 * 清理编辑态上下文，恢复为默认草稿弹窗模式。
 *
 * @returns {void} 无返回值。
 */
function clearDraftEditContext() {
  draftDialogMode.value = 'create'
  editingLedgerEntryMeta.value = null
  draftBackupBeforeEdit.value = null
}

/**
 * 进入账单编辑前备份当前草稿，避免编辑态覆盖未保存的 AI 草稿。
 *
 * @returns {void} 无返回值。
 */
function backupDraftBeforeEditSession() {
  if (!hasDraft.value) {
    draftBackupBeforeEdit.value = null
    return
  }
  draftBackupBeforeEdit.value = {
    draft: { ...draft },
    draftHint: draftHint.value,
  }
}

/**
 * 结束编辑态后恢复草稿快照；若无快照则清空草稿状态。
 *
 * @returns {void} 无返回值。
 */
function restoreDraftAfterEditSession() {
  const backup = draftBackupBeforeEdit.value
  if (!backup) {
    Object.assign(draft, createEmptyDraft())
    hasDraft.value = false
    draftHint.value = ''
    clearDraftEditContext()
    return
  }
  Object.assign(draft, backup.draft)
  hasDraft.value = true
  draftHint.value = backup.draftHint
  clearDraftEditContext()
}

/**
 * 重置草稿及草稿状态提示。
 *
 * @returns {void} 无返回值。
 */
function resetDraft() {
  Object.assign(draft, createEmptyDraft())
  hasDraft.value = false
  isDraftDialogVisible.value = false
  draftHint.value = ''
  clearDraftEditContext()
}

/**
 * 清空当前选中的文件与预览资源。
 *
 * @returns {void} 无返回值。
 */
function resetFileSelection() {
  selectedFile.value = null
  revokePreviewURL()
}

/**
 * 释放当前图片预览 URL，避免内存泄漏。
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
 * 设置识别流程提示消息。
 *
 * @param {'success' | 'error' | ''} type 消息类型。
 * @param {string} text 消息文本。
 * @returns {void} 无返回值。
 */
function setAnalyzeMessage(type, text) {
  analyzeMessage.value = { type, text }
}

/**
 * 将 Date 转换为 datetime-local 输入框格式。
 *
 * @param {Date} date 日期对象。
 * @returns {string} `YYYY-MM-DDTHH:mm` 格式文本。
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
 * 将 AI 返回的时间文本转换为 datetime-local 可用格式。
 *
 * @param {unknown} occurredAtText AI 返回的时间字符串。
 * @returns {string} 可用于输入框的时间文本；解析失败返回空字符串。
 */
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

/**
 * 将 datetime-local 输入值转换为 ISO 时间。
 *
 * @param {string} inputValue 输入框时间文本。
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
 * 将账单 ISO 时间转换为 datetime-local 输入框值。
 *
 * @param {unknown} occurredAtISO 账单交易时间。
 * @returns {string} 输入框时间文本；解析失败返回空字符串。
 */
function parseLedgerOccurredAtToInputValue(occurredAtISO) {
  const parsedDate = new Date(occurredAtISO)
  if (Number.isNaN(parsedDate.getTime())) {
    return ''
  }
  return parseDateToInputValue(parsedDate)
}

/**
 * 构建类别下拉选项，仅保留预设标准类别名称并去重。
 *
 * @param {Array<{name?: string}>} [categoryPresets=[]] 类别预设列表。
 * @returns {string[]} 去重后的类别名称数组。
 */
function buildCategoryPresetOptions(categoryPresets = []) {
  if (!Array.isArray(categoryPresets)) {
    return []
  }

  const optionSet = new Set()
  const options = []
  for (const preset of categoryPresets) {
    const name = typeof preset?.name === 'string' ? preset.name.trim() : ''
    if (!name || optionSet.has(name)) {
      continue
    }
    optionSet.add(name)
    options.push(name)
  }
  return options
}

/**
 * 刷新草稿弹窗类别下拉选项。
 *
 * @param {Array<{name?: string}>} [categoryPresets=loadCategoryPresets()] 可选预设列表。
 * @returns {void} 无返回值。
 */
function refreshCategoryPresetOptions(categoryPresets = loadCategoryPresets()) {
  categoryPresetOptions.value = buildCategoryPresetOptions(categoryPresets)
}

/**
 * 处理类别输入框文本更新，保证同一控件可直接输入自定义类别。
 *
 * @param {string} inputValue 当前输入值。
 * @returns {void} 无返回值。
 */
function handleCategoryInputValue(inputValue) {
  draft.category = typeof inputValue === 'string' ? inputValue : ''
}

/**
 * 归一化 q-file 返回值为单个 File 对象。
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
 * 判断 MIME 类型是否在允许范围内。
 *
 * @param {string} mimeType MIME 类型。
 * @returns {boolean} 是否支持。
 */
function isSupportedMimeType(mimeType) {
  return SUPPORTED_MIME_TYPES.includes(mimeType)
}

/**
 * 检测文件 MIME 类型，优先使用浏览器给出的 type，失败时回退后缀推断。
 *
 * @param {File | null | undefined} file 文件对象。
 * @returns {string} 识别到的 MIME 类型；失败返回空字符串。
 */
function detectMimeType(file) {
  if (file?.type && isSupportedMimeType(file.type)) {
    return file.type
  }

  // 部分浏览器/设备上传时 type 为空，回退到文件后缀推断 MIME。
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

/**
 * 校验上传文件合法性（存在性、类型、大小）。
 *
 * @param {File | File[] | null | undefined} file 文件对象或数组。
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
    // 前端先拦截超大图，避免无效请求占用带宽和模型额度。
    return { ok: false, error: `图片大小不能超过 ${MAX_IMAGE_SIZE_MB}MB` }
  }

  return { ok: true, file: normalizedFile, mimeType }
}

/**
 * 处理上传文件变化并更新提示信息。
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
    }
    return
  }

  selectedFile.value = validation.file
  setAnalyzeMessage('', '')
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
 * @throws {Error} 当 DataURL 结构不合法时抛出。
 */
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

/**
 * 根据当前配置生成识别请求配置。
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
 * }} parsedData AI 解析结果。
 * @param {{provider: 'openai' | 'anthropic', model: string}} analysisConfig 识别配置。
 * @param {string} sourceImageName 源图片文件名。
 * @returns {void} 无返回值。
 */
function applyDraftFromAI(parsedData, analysisConfig, sourceImageName, categoryPresetList) {
  const matchedCategory = matchCategoryPreset(parsedData.category, categoryPresetList)
  const fallbackDate = parseDateToInputValue(new Date())
  const parsedOccurredAt = parseOccurredAtTextToInputValue(parsedData.occurredAt)
  const occurredAtInput = parsedOccurredAt || fallbackDate
  refreshCategoryPresetOptions(categoryPresetList)

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
  clearDraftEditContext()
  hasDraft.value = true
  isDraftDialogVisible.value = true
}

/**
 * 判断识别结果是否具备草稿填充所需结构。
 *
 * @param {unknown} data 识别结果。
 * @returns {boolean} 是否可用于生成草稿。
 */
function isValidAnalyzeResult(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false
  }
  // 仅校验关键字段是否存在，避免接口兼容层返回异常结构导致草稿静默失败。
  return 'amount' in data && 'currency' in data && 'category' in data && 'transactionType' in data
}

/**
 * 打开草稿弹窗（已有草稿时可重复编辑）。
 *
 * @returns {void} 无返回值。
 */
function openDraftDialog() {
  if (!hasDraft.value) {
    return
  }
  refreshCategoryPresetOptions()
  clearDraftEditContext()
  isDraftDialogVisible.value = true
}

/**
 * 以手动模式打开空白草稿弹窗，并预填当前交易时间。
 *
 * @returns {void} 无返回值。
 */
function openManualDraftDialog() {
  Object.assign(draft, createEmptyDraft())
  refreshCategoryPresetOptions()
  draft.occurredAtInput = parseDateToInputValue(new Date())
  clearDraftEditContext()
  hasDraft.value = true
  isDraftDialogVisible.value = true
  draftHint.value = '手动记账模式：请补充交易信息后确认入账。'
  setAnalyzeMessage('', '')
}

/**
 * 提取账单 ID，兼容脏数据并统一去空白。
 *
 * @param {object} entry 账单对象。
 * @returns {string} 账单 ID；无效时返回空字符串。
 */
function resolveLedgerEntryId(entry) {
  return typeof entry?.id === 'string' ? entry.id.trim() : ''
}

/**
 * 点击账单行进入编辑。
 *
 * @param {object} entry 账单对象。
 * @returns {void} 无返回值。
 */
function handleLedgerItemClick(entry) {
  if (isLedgerActionLoading.value) {
    return
  }
  openEditDialogFromEntry(entry)
}

/**
 * 点击账单编辑按钮（PC 与移动端共用）。
 *
 * @param {object} entry 账单对象。
 * @returns {void} 无返回值。
 */
function handleLedgerEditAction(entry) {
  if (isLedgerActionLoading.value) {
    return
  }
  openEditDialogFromEntry(entry)
}

/**
 * 弹出删除确认框。
 *
 * @returns {Promise<boolean>} 用户是否确认删除。
 */
function confirmDeleteLedgerEntry() {
  const confirmMessage = '删除后账单将从列表隐藏，并同步到服务端。可在 5 秒内撤销。'
  return new Promise((resolve) => {
    $q.dialog({
      title: '确认删除',
      message: confirmMessage,
      ok: {
        label: '确认删除',
        color: 'negative',
        unelevated: true,
        noCaps: true,
      },
      cancel: {
        label: '取消',
        flat: true,
        noCaps: true,
      },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false))
  })
}

/**
 * 执行账单撤销删除。
 *
 * @param {string} entryId 账单 ID。
 * @returns {Promise<void>} 无返回值。
 */
async function handleLedgerRestore(entryId) {
  if (isLedgerActionLoading.value) {
    return
  }
  isLedgerActionLoading.value = true
  try {
    await restoreLedgerEntry(entryId)
    await refreshLedgerEntries()
    setAnalyzeMessage('success', '账单删除已撤销')
    $q.notify({
      type: 'positive',
      message: '账单已恢复',
      position: 'top',
      timeout: 1800,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '撤销删除失败'
    setAnalyzeMessage('error', message)
  } finally {
    isLedgerActionLoading.value = false
  }
}

/**
 * 执行账单删除，并提供短时撤销入口。
 *
 * @param {object} entry 账单对象。
 * @returns {Promise<boolean>} 是否删除成功。
 */
async function handleLedgerDeleteAction(entry) {
  if (isLedgerActionLoading.value) {
    return false
  }

  const entryId = resolveLedgerEntryId(entry)
  if (!entryId) {
    setAnalyzeMessage('error', '账单数据异常，无法删除')
    return false
  }

  const confirmed = await confirmDeleteLedgerEntry()
  if (!confirmed) {
    return false
  }

  isLedgerActionLoading.value = true
  try {
    await deleteLedgerEntry(entryId)
    await refreshLedgerEntries()
    setAnalyzeMessage('success', '账单已删除')
    $q.notify({
      type: 'warning',
      message: '账单已删除，可在 5 秒内撤销',
      position: 'top',
      timeout: LEDGER_DELETE_UNDO_TIMEOUT_MS,
      actions: [
        {
          label: '撤销',
          color: 'white',
          noCaps: true,
          handler: () => {
            void handleLedgerRestore(entryId)
          },
        },
      ],
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : '账单删除失败'
    setAnalyzeMessage('error', message)
    return false
  } finally {
    isLedgerActionLoading.value = false
  }
}

/**
 * 在编辑弹窗内执行当前账单删除；删除成功后关闭弹窗并清理编辑上下文。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleDraftDialogDeleteAction() {
  if (!isEditingDraft.value || isLedgerActionLoading.value) {
    return
  }
  const entryId = resolveLedgerEntryId(editingLedgerEntryMeta.value)
  if (!entryId) {
    setAnalyzeMessage('error', '编辑上下文丢失，请重新选择账单后再试')
    return
  }
  const deleted = await handleLedgerDeleteAction({ id: entryId })
  if (!deleted) {
    return
  }
  if (!isEditingDraft.value || !isDraftDialogVisible.value) {
    return
  }
  isDraftDialogVisible.value = false
}

/**
 * 将账单实体映射到草稿表单，并进入编辑态。
 *
 * @param {object} entry 账单对象。
 * @returns {void} 无返回值。
 */
function openEditDialogFromEntry(entry) {
  const entryId = resolveLedgerEntryId(entry)
  if (!entryId) {
    setAnalyzeMessage('error', '账单数据异常，无法编辑')
    return
  }

  backupDraftBeforeEditSession()
  refreshCategoryPresetOptions()

  const parsedOccurredAt = parseLedgerOccurredAtToInputValue(entry.occurredAt)
  draft.amount = typeof entry.amount === 'number' ? entry.amount : ''
  draft.currency = entry.currency || 'CNY'
  draft.occurredAtInput = parsedOccurredAt || parseDateToInputValue(new Date())
  draft.location = entry.location || ''
  draft.paymentMethod = entry.paymentMethod || '其他'
  draft.merchant = entry.merchant || ''
  draft.category = entry.category || '其他'
  draft.note = entry.note || ''
  draft.transactionType = entry.transactionType === 'income' ? 'income' : 'expense'
  draft.sourceImageName = entry.sourceImageName || ''
  draft.aiProvider = entry.aiProvider === 'anthropic' ? 'anthropic' : 'openai'
  draft.aiModel = entry.aiModel || ''
  draft.aiConfidence = typeof entry.aiConfidence === 'number' ? entry.aiConfidence : null
  hasDraft.value = false
  draftHint.value = ''
  draftDialogMode.value = 'edit'
  editingLedgerEntryMeta.value = {
    id: entryId,
    createdAt: entry.createdAt || '',
  }
  isDraftDialogVisible.value = true
}

/**
 * 关闭草稿弹窗。
 *
 * @returns {void} 无返回值。
 */
function handleCloseDraftDialog() {
  isDraftDialogVisible.value = false
}

/**
 * 草稿弹窗隐藏后统一收尾；覆盖按钮、遮罩与 Esc 三种关闭路径。
 *
 * @returns {void} 无返回值。
 */
function handleDraftDialogHide() {
  if (!isEditingDraft.value) {
    return
  }
  restoreDraftAfterEditSession()
}

/**
 * 处理草稿弹窗次要按钮动作（编辑态取消，新增态清空草稿）。
 *
 * @returns {void} 无返回值。
 */
function handleDraftSecondaryAction() {
  if (isEditingDraft.value) {
    handleCloseDraftDialog()
    return
  }
  resetDraft()
}

/**
 * 执行图片识别主流程。
 *
 * @returns {Promise<void>} 无返回值。
 */
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
  const latestPresets = loadCategoryPresets()
  const categoryNames = latestPresets.map((preset) => preset.name)
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

    if (!isValidAnalyzeResult(result.data)) {
      setAnalyzeMessage('error', '识别结果格式异常，未能生成草稿，请重试')
      return
    }

    applyDraftFromAI(result.data, analysisConfig, payload.fileName, latestPresets)
    setAnalyzeMessage('success', `识别成功，耗时 ${result.latencyMs}ms，已生成草稿`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '识别失败，请重试'
    setAnalyzeMessage('error', message)
  } finally {
    isAnalyzing.value = false
  }
}

/**
 * 校验当前草稿是否可入账。
 *
 * @returns {string} 校验错误信息；空字符串表示通过。
 */
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

/**
 * 将草稿转换为账单实体。
 *
 * @param {{id?: string, createdAt?: string}} [options={}] 构建选项。
 * @returns {object} 可持久化的账单对象。
 */
function buildLedgerEntryFromDraft(options = {}) {
  const nowISO = new Date().toISOString()
  const occurredAtISO = parseInputValueToISO(draft.occurredAtInput) || nowISO
  const createdAt =
    typeof options.createdAt === 'string' && options.createdAt.trim() ? options.createdAt : nowISO
  const latestPresets = loadCategoryPresets()
  const normalizedCategory = matchCategoryPreset(draft.category, latestPresets)
  // 入账前统一归一化草稿字段，保证存储层数据结构稳定。
  return {
    id: typeof options.id === 'string' ? options.id.trim() : '',
    amount: Number(draft.amount),
    currency: draft.currency?.trim() || 'CNY',
    occurredAt: occurredAtISO,
    location: draft.location?.trim() || '',
    paymentMethod: draft.paymentMethod?.trim() || '其他',
    merchant: draft.merchant?.trim() || '',
    category: normalizedCategory.category,
    note: draft.note?.trim() || '',
    transactionType: draft.transactionType === 'income' ? 'income' : 'expense',
    sourceImageName: draft.sourceImageName,
    aiProvider: draft.aiProvider === 'anthropic' ? 'anthropic' : 'openai',
    aiModel: draft.aiModel,
    aiConfidence: typeof draft.aiConfidence === 'number' ? draft.aiConfidence : null,
    createdAt,
  }
}

/**
 * 确认草稿并写入账本。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleConfirmDraft() {
  const errorMessage = validateDraft()
  if (errorMessage) {
    setAnalyzeMessage('error', errorMessage)
    return
  }

  const isEditMode = isEditingDraft.value
  const editingMeta = editingLedgerEntryMeta.value
  if (isEditMode && !editingMeta?.id) {
    setAnalyzeMessage('error', '编辑上下文丢失，请重新选择账单后再试')
    return
  }

  try {
    // 保存后按当前页签刷新，保证最近/月/全部三个视图的数据一致。
    if (isEditMode) {
      await updateLedgerEntry(buildLedgerEntryFromDraft({
        id: editingMeta.id,
        createdAt: editingMeta.createdAt,
      }))
    } else {
      await appendLedgerEntry(buildLedgerEntryFromDraft())
    }
    await refreshLedgerEntries()
    setAnalyzeMessage('success', isEditMode ? '账单已更新' : '记账已保存')
    $q.notify({
      type: 'positive',
      message: isEditMode ? '账单修改成功，已更新账本' : '记账成功，已写入账本',
      position: 'top',
      timeout: 1800,
    })
    if (isEditMode) {
      restoreDraftAfterEditSession()
      isDraftDialogVisible.value = false
    } else {
      resetDraft()
      resetFileSelection()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '记账保存失败'
    setAnalyzeMessage('error', message)
  }
}

/**
 * 格式化账单金额展示文本。
 *
 * @param {unknown} amount 金额值。
 * @param {string} currency 币种。
 * @returns {string} 展示文本。
 */
function formatLedgerAmount(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return '-'
  }
  return `${amount.toFixed(2)} ${currency || 'CNY'}`
}

/**
 * 格式化账单时间展示文本。
 *
 * @param {string} isoText ISO 时间文本。
 * @returns {string} 本地化时间文本；非法值返回 `-`。
 */
function formatLedgerTime(isoText) {
  const date = new Date(isoText)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  return date.toLocaleString('zh-CN', {
    hour12: false,
  })
}
</script>

<template>
  <section class="home-shell">
    <div class="hero">
      <p class="hero-tag">AI 智能记账，您的记账小助手</p>
      <p class="hero-subtitle">上传交易截图，自动生成可确认的记账草稿</p>
    </div>

    <q-banner
      v-if="!isConfigReady"
      dense
      rounded
      class="bg-orange-1 text-orange-10"
      inline-actions
    >
      当前可先手动记账；如需 AI 识别，请先在「AI 配置」中完善 provider、token 与模型。
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

        <div class="analyze-actions">
          <q-btn
            unelevated
            color="primary"
            no-caps
            :loading="isAnalyzing"
            :disable="!isConfigReady || isAnalyzing"
            :label="isAnalyzing ? '正在识别...' : '开始识别'"
            @click="handleAnalyze"
          />
          <q-btn
            flat
            color="primary"
            no-caps
            label="手动记账"
            :disable="isAnalyzing"
            @click="openManualDraftDialog"
          />
          <q-btn
            v-if="hasDraft"
            flat
            color="secondary"
            no-caps
            label="查看记账草稿"
            @click="openDraftDialog"
          />
        </div>

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

    <q-card flat bordered class="section-card ledger-section-card">
      <q-card-section class="section-title">账单</q-card-section>
      <q-separator />
      <q-card-section class="section-body ledger-section-body">
        <q-tabs
          v-model="activeLedgerTab"
          inline-label
          align="left"
          active-color="primary"
          indicator-color="primary"
          class="ledger-tabs"
        >
          <q-tab
            v-for="tab in LEDGER_TAB_OPTIONS"
            :key="tab.value"
            :name="tab.value"
            :label="tab.label"
          />
        </q-tabs>

        <div v-if="activeLedgerTab === 'monthly'" class="ledger-filter-row">
          <q-input
            v-model="selectedLedgerDate"
            readonly
            dense
            filled
            class="ledger-date-input"
            label="选择日期"
          >
            <template #append>
              <q-icon name="event" class="cursor-pointer">
                <q-popup-proxy cover transition-show="scale" transition-hide="scale">
                  <q-date v-model="selectedLedgerDate" mask="YYYY-MM-DD">
                    <div class="row items-center justify-end">
                      <q-btn v-close-popup flat color="primary" label="确定" />
                    </div>
                  </q-date>
                </q-popup-proxy>
              </q-icon>
            </template>
          </q-input>
        </div>

        <div class="ledger-panel-content">
          <q-banner v-if="isLedgerLoading" rounded class="bg-blue-1 text-blue-10">
            账单加载中...
          </q-banner>

          <q-banner v-else-if="visibleLedgerEntries.length === 0" rounded class="bg-grey-2 text-grey-7">
            {{ ledgerEmptyMessage }}
          </q-banner>

          <div v-else class="ledger-list-scroll">
            <q-list bordered separator class="rounded-borders bg-white">
              <template v-if="isDesktop">
                <q-item
                  v-for="entry in visibleLedgerEntries"
                  :key="entry.id"
                  clickable
                  class="ledger-item"
                  @click="handleLedgerItemClick(entry)"
                >
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

                  <q-item-section side class="ledger-actions-desktop">
                    <div class="ledger-actions-desktop-wrap">
                      <q-btn
                        flat
                        round
                        dense
                        color="primary"
                        icon="edit"
                        aria-label="编辑账单"
                        :disable="isLedgerActionLoading"
                        @click.stop="handleLedgerEditAction(entry)"
                      />
                      <q-btn
                        flat
                        round
                        dense
                        color="negative"
                        icon="delete"
                        aria-label="删除账单"
                        :disable="isLedgerActionLoading"
                        @click.stop="handleLedgerDeleteAction(entry)"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </template>

              <template v-else>
                <q-item
                  v-for="entry in visibleLedgerEntries"
                  :key="entry.id"
                  clickable
                  class="ledger-item"
                  @click="handleLedgerItemClick(entry)"
                >
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
              </template>
            </q-list>
          </div>
        </div>
      </q-card-section>
    </q-card>

    <q-dialog v-model="isDraftDialogVisible" :persistent="isLedgerActionLoading" @hide="handleDraftDialogHide">
      <q-card class="draft-dialog">
        <q-card-section class="draft-dialog-header">
          <div>
            <p class="text-h6 text-weight-bold">{{ draftDialogTitle }}</p>
            <p class="text-caption text-grey-7">{{ draftDialogDescription }}</p>
          </div>
          <q-btn flat round dense icon="close" :disable="isLedgerActionLoading" @click="handleCloseDraftDialog" />
        </q-card-section>

        <q-separator />

        <q-card-section class="section-body draft-dialog-body">
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
              :behavior="draftSelectPopupPolicy.behavior.value"
              :menu-anchor="draftSelectPopupPolicy.menuAnchor"
              :menu-self="draftSelectPopupPolicy.menuSelf"
              :menu-offset="draftSelectPopupPolicy.menuOffset"
              :popup-content-style="draftSelectPopupPolicy.popupContentStyle"
              emit-value
              map-options
              filled
              label="收支方向"
            />
            <q-select
              v-model="draft.paymentMethod"
              :options="PAYMENT_METHOD_OPTIONS"
              :behavior="draftSelectPopupPolicy.behavior.value"
              :menu-anchor="draftSelectPopupPolicy.menuAnchor"
              :menu-self="draftSelectPopupPolicy.menuSelf"
              :menu-offset="draftSelectPopupPolicy.menuOffset"
              :popup-content-style="draftSelectPopupPolicy.popupContentStyle"
              filled
              label="交易方式"
            />
            <q-select
              v-model="draft.category"
              :options="categoryPresetOptions"
              :behavior="draftSelectPopupPolicy.behavior.value"
              :menu-anchor="draftSelectPopupPolicy.menuAnchor"
              :menu-self="draftSelectPopupPolicy.menuSelf"
              :menu-offset="draftSelectPopupPolicy.menuOffset"
              :popup-content-style="draftSelectPopupPolicy.popupContentStyle"
              use-input
              fill-input
              hide-selected
              input-debounce="0"
              filled
              label="类别"
              @input-value="handleCategoryInputValue"
            />
            <q-input v-model="draft.merchant" filled label="商户" />
            <q-input v-model="draft.location" filled label="交易地点" />
            <q-input v-model="draft.note" filled type="textarea" autogrow label="备注" class="draft-note" />
          </div>

          <div class="draft-actions">
            <q-btn
              unelevated
              color="primary"
              no-caps
              :label="draftConfirmButtonLabel"
              :disable="!canConfirmDraft || isLedgerActionLoading"
              @click="handleConfirmDraft"
            />
            <q-btn
              flat
              color="grey-8"
              no-caps
              :label="draftSecondaryButtonLabel"
              :disable="isLedgerActionLoading"
              @click="handleDraftSecondaryAction"
            />
            <q-btn
              v-if="isEditingDraft"
              flat
              color="negative"
              no-caps
              label="删除账单"
              :loading="isLedgerActionLoading"
              :disable="isLedgerActionLoading"
              @click="handleDraftDialogDeleteAction"
            />
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
  flex: 1;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
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

.ledger-section-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ledger-section-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ledger-panel-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.ledger-list-scroll {
  flex: 1;
  min-height: 240px;
  overflow: auto;
}

.ledger-tabs {
  border-bottom: 1px solid #e2e8f0;
}

.ledger-filter-row {
  display: flex;
  justify-content: flex-start;
}

.ledger-date-input {
  width: min(280px, 100%);
}

.analyze-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
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

.draft-dialog {
  width: min(860px, 96vw);
  max-height: calc(var(--app-viewport-height, 100vh) - 16px);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
}

.draft-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
  flex: 0 0 auto;
}

.draft-dialog-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding-bottom: max(0.8rem, env(safe-area-inset-bottom));
}

.ledger-main-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.ledger-item {
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.ledger-actions-desktop {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    visibility 0.16s ease;
}

.ledger-actions-desktop-wrap {
  display: flex;
  align-items: center;
  gap: 0.3rem;
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
  .home-shell {
    gap: 0.75rem;
  }

  .hero {
    gap: 0.2rem;
  }

  .hero-tag {
    letter-spacing: 0.04em;
  }

  .section-body {
    gap: 0.65rem;
  }

  .ledger-panel-content {
    gap: 0.65rem;
  }

  .ledger-sub-row {
    display: grid;
    gap: 0.15rem;
    font-size: 0.92rem;
  }

  .draft-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-height: 700px) {
  .home-shell {
    height: auto;
  }

  .ledger-list-scroll {
    overflow: visible;
  }
}

@media (min-width: 1024px) {
  .ledger-item:hover {
    background-color: #f8fafc;
  }

  .ledger-item:hover .ledger-actions-desktop,
  .ledger-item:focus-within .ledger-actions-desktop {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }
}
</style>
