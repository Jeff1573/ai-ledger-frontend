import {
  bulkUpsertLedgerEntries,
  getAppMetaRecord,
  listAllLedgerEntriesDesc,
  listLedgerEntriesInRangeDesc,
  listRecentLedgerEntriesDesc,
  putAppMetaRecord,
  upsertLedgerEntry,
} from './ledgerDb'

// localStorage 键名统一集中管理，便于后续版本迁移与清理。
const AI_CONFIG_STORAGE_KEY = 'ai_accounting_config_v1'
// 账单数据存储键。
const LEDGER_STORAGE_KEY = 'ai_accounting_ledger_entries_v1'
// 类别预设存储键。
const CATEGORY_PRESETS_STORAGE_KEY = 'ai_accounting_category_presets_v1'
// 账本迁移元数据键（写入 IndexedDB appMeta 表）。
const LEDGER_MIGRATION_META_KEY = 'ledger_migrated_from_localstorage_v1'
// 最近账单默认条数。
const DEFAULT_RECENT_LEDGER_LIMIT = 30

// 账本初始化 Promise（含迁移）；用于并发场景去重执行。
let ledgerStoreReadyPromise = null

// Provider 默认配置集合，切换 Provider 时用于补全默认 baseURL。
export const PROVIDER_DEFAULTS = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
  },
}

// 当前支持的 Provider 列表。
const PROVIDERS = ['openai', 'anthropic']

// 首次使用时的默认类别预设。
const DEFAULT_CATEGORY_PRESETS = [
  { id: 'cat-catering', name: '餐饮', aliases: ['吃饭', '外卖'] },
  { id: 'cat-transport', name: '交通', aliases: ['打车', '公交', '地铁'] },
  { id: 'cat-shopping', name: '购物', aliases: ['买东西'] },
  { id: 'cat-housing', name: '居住', aliases: ['房租', '水电'] },
  { id: 'cat-medical', name: '医疗', aliases: ['看病', '药店'] },
  { id: 'cat-learning', name: '学习', aliases: ['课程', '培训'] },
  { id: 'cat-entertainment', name: '娱乐', aliases: ['电影', '游戏'] },
  { id: 'cat-other', name: '其他', aliases: [] },
]

/**
 * 安全解析 JSON 文本。
 *
 * @param {string} rawText 待解析文本。
 * @returns {any | null} 解析结果；失败返回 null。
 */
function safeParseJSON(rawText) {
  try {
    return JSON.parse(rawText)
  } catch {
    // 存储内容损坏时回退为空，避免初始化阶段直接抛错中断页面。
    return null
  }
}

/**
 * 创建 providerModels 的空状态对象。
 *
 * @returns {{
 *   openai: { currentModel: string, models: string[] },
 *   anthropic: { currentModel: string, models: string[] }
 * }} provider 模型状态初始值。
 */
function createEmptyProviderModels() {
  return {
    openai: {
      currentModel: '',
      models: [],
    },
    anthropic: {
      currentModel: '',
      models: [],
    },
  }
}

/**
 * 去重并清洗模型列表。
 *
 * @param {unknown} rawList 原始模型数组。
 * @returns {string[]} 清洗后的模型名数组。
 */
function dedupeModelList(rawList) {
  if (!Array.isArray(rawList)) {
    return []
  }

  const modelSet = new Set()
  const models = []
  for (const item of rawList) {
    if (typeof item !== 'string') {
      continue
    }
    const modelName = item.trim()
    if (!modelName || modelSet.has(modelName)) {
      continue
    }
    modelSet.add(modelName)
    models.push(modelName)
  }
  return models
}

/**
 * 归一化单个 provider 的模型状态。
 *
 * @param {{currentModel?: string, models?: string[]}} rawState 原始模型状态。
 * @param {string} [fallbackCurrentModel=''] 兼容旧字段的兜底模型。
 * @returns {{currentModel: string, models: string[]}} 归一化结果。
 */
function normalizeProviderModelState(rawState, fallbackCurrentModel = '') {
  const models = dedupeModelList(rawState?.models)
  let currentModel =
    typeof rawState?.currentModel === 'string' ? rawState.currentModel.trim() : ''

  // 兼容旧版本只有 model 字段的场景，迁移到当前 provider 对应的 currentModel。
  if (!currentModel && fallbackCurrentModel) {
    currentModel = fallbackCurrentModel
  }

  if (currentModel && !models.includes(currentModel)) {
    models.unshift(currentModel)
  }
  if (!currentModel && models.length > 0) {
    currentModel = models[0]
  }

  return {
    currentModel,
    models,
  }
}

/**
 * 深拷贝 provider 模型状态，避免外部直接修改内部引用。
 *
 * @param {{
 *   openai: { currentModel: string, models: string[] },
 *   anthropic: { currentModel: string, models: string[] }
 * }} providerModels provider 模型状态。
 * @returns {{
 *   openai: { currentModel: string, models: string[] },
 *   anthropic: { currentModel: string, models: string[] }
 * }} 拷贝后的状态对象。
 */
function cloneProviderModels(providerModels) {
  return {
    openai: {
      currentModel: providerModels.openai.currentModel,
      models: [...providerModels.openai.models],
    },
    anthropic: {
      currentModel: providerModels.anthropic.currentModel,
      models: [...providerModels.anthropic.models],
    },
  }
}

// AI 配置默认值。
export const DEFAULT_AI_CONFIG = {
  provider: 'openai',
  baseURL: PROVIDER_DEFAULTS.openai.baseURL,
  token: '',
  providerModels: createEmptyProviderModels(),
}

/**
 * 归一化 AI 配置对象，补齐默认值并兼容旧结构。
 *
 * @param {any} [raw={}] 原始配置对象。
 * @returns {{
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: {
 *     openai: { currentModel: string, models: string[] },
 *     anthropic: { currentModel: string, models: string[] }
 *   }
 * }} 归一化配置对象。
 */
function normalizeConfig(raw = {}) {
  const provider = raw.provider === 'anthropic' ? 'anthropic' : 'openai'
  const baseURL =
    typeof raw.baseURL === 'string' && raw.baseURL.trim()
      ? raw.baseURL.trim()
      : PROVIDER_DEFAULTS[provider].baseURL
  const token = typeof raw.token === 'string' ? raw.token : ''
  const legacyModel = typeof raw.model === 'string' ? raw.model.trim() : ''
  const rawProviderModels =
    raw.providerModels && typeof raw.providerModels === 'object' ? raw.providerModels : {}
  const providerModels = createEmptyProviderModels()

  // 兼容旧配置只有 model 字段的场景，仅对当前 provider 进行迁移兜底。
  for (const providerId of PROVIDERS) {
    const fallbackCurrentModel = providerId === provider ? legacyModel : ''
    providerModels[providerId] = normalizeProviderModelState(
      rawProviderModels[providerId],
      fallbackCurrentModel,
    )
  }

  return {
    provider,
    baseURL,
    token,
    providerModels,
  }
}

/**
 * 读取并归一化 AI 配置。
 *
 * @returns {{
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: {
 *     openai: { currentModel: string, models: string[] },
 *     anthropic: { currentModel: string, models: string[] }
 *   }
 * }} 可直接用于页面与请求构建的配置对象。
 */
export function loadAIConfig() {
  const raw = localStorage.getItem(AI_CONFIG_STORAGE_KEY)
  if (!raw) {
    return {
      ...DEFAULT_AI_CONFIG,
      providerModels: cloneProviderModels(DEFAULT_AI_CONFIG.providerModels),
    }
  }

  const parsed = safeParseJSON(raw)
  if (!parsed) {
    return {
      ...DEFAULT_AI_CONFIG,
      providerModels: cloneProviderModels(DEFAULT_AI_CONFIG.providerModels),
    }
  }

  return normalizeConfig(parsed)
}

/**
 * 保存 AI 配置到 localStorage，并返回可安全复用的归一化副本。
 *
 * @param {object} config 待保存配置。
 * @returns {{
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: {
 *     openai: { currentModel: string, models: string[] },
 *     anthropic: { currentModel: string, models: string[] }
 *   }
 * }} 归一化配置副本。
 * @throws {Error} 浏览器存储不可写时抛出。
 */
export function saveAIConfig(config) {
  const normalized = normalizeConfig(config)
  try {
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    throw new Error('配置保存失败，请检查浏览器存储权限或清理存储空间后重试')
  }
  return {
    ...normalized,
    providerModels: cloneProviderModels(normalized.providerModels),
  }
}

/**
 * 归一化文本字段，空值回退到默认值。
 *
 * @param {unknown} value 原始字段值。
 * @param {string} [fallback=''] 兜底值。
 * @returns {string} 归一化后的文本。
 */
function normalizeTextField(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback
  }
  const normalized = value.trim()
  return normalized || fallback
}

/**
 * 归一化币种字段，统一转大写并提供默认币种。
 *
 * @param {unknown} value 原始币种值。
 * @returns {string} 归一化后的币种。
 */
function normalizeCurrency(value) {
  const normalized = normalizeTextField(value).toUpperCase()
  return normalized || 'CNY'
}

/**
 * 归一化交易类型，仅允许 income 或 expense。
 *
 * @param {unknown} value 原始交易类型。
 * @returns {'income' | 'expense'} 合法交易类型。
 */
function normalizeTransactionType(value) {
  return value === 'income' ? 'income' : 'expense'
}

/**
 * 归一化置信度，限定在 [0, 1] 区间。
 *
 * @param {unknown} value 原始置信度。
 * @returns {number | null} 合法置信度或 null。
 */
function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (value < 0 || value > 1) {
    return null
  }
  return value
}

/**
 * 归一化日期字段，非法日期回退到指定 ISO 时间。
 *
 * @param {unknown} value 原始日期值。
 * @param {string} fallbackISO 兜底 ISO 时间。
 * @returns {string} ISO 格式时间。
 */
function normalizeISODate(value, fallbackISO) {
  const parsedDate = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) {
    return fallbackISO
  }
  return parsedDate.toISOString()
}

/**
 * 创建运行时 ID，用于离线场景下生成本地唯一标识。
 *
 * @param {string} prefix ID 前缀。
 * @returns {string} 生成的唯一 ID。
 */
function createRuntimeId(prefix) {
  // 优先使用浏览器原生 UUID，保证前端离线场景下也有稳定唯一标识。
  const uuidFactory = globalThis.crypto?.randomUUID
  if (typeof uuidFactory === 'function') {
    return `${prefix}-${uuidFactory.call(globalThis.crypto)}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 归一化别名列表，去空与去重。
 *
 * @param {unknown} rawAliases 原始别名列表。
 * @returns {string[]} 清洗后的别名数组。
 */
function normalizeAliases(rawAliases) {
  if (!Array.isArray(rawAliases)) {
    return []
  }

  const aliasSet = new Set()
  const aliases = []
  for (const alias of rawAliases) {
    const normalized = normalizeTextField(alias)
    if (!normalized || aliasSet.has(normalized)) {
      continue
    }
    aliasSet.add(normalized)
    aliases.push(normalized)
  }
  return aliases
}

/**
 * 归一化单条类别预设。
 *
 * @param {any} [rawPreset={}] 原始预设对象。
 * @param {number} [index=0] 预设索引，用于兜底 ID。
 * @returns {{id: string, name: string, aliases: string[]} | null} 合法预设或 null。
 */
function normalizeCategoryPreset(rawPreset = {}, index = 0) {
  const name = normalizeTextField(rawPreset.name)
  if (!name) {
    return null
  }

  const fallbackId = `cat-custom-${index + 1}`
  const id = normalizeTextField(rawPreset.id, fallbackId)

  return {
    id,
    name,
    aliases: normalizeAliases(rawPreset.aliases),
  }
}

/**
 * 深拷贝类别预设列表。
 *
 * @param {Array<{id: string, name: string, aliases: string[]}>} categoryPresets 预设列表。
 * @returns {Array<{id: string, name: string, aliases: string[]}>} 拷贝后的预设列表。
 */
function cloneCategoryPresets(categoryPresets) {
  return categoryPresets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    aliases: [...preset.aliases],
  }))
}

/**
 * 归一化类别预设列表，过滤非法项并按名称去重。
 *
 * @param {unknown} rawList 原始预设列表。
 * @returns {Array<{id: string, name: string, aliases: string[]}>} 归一化后的预设列表。
 */
function normalizeCategoryPresetList(rawList) {
  if (!Array.isArray(rawList)) {
    return cloneCategoryPresets(DEFAULT_CATEGORY_PRESETS)
  }

  const presetNameSet = new Set()
  const normalized = []
  for (let index = 0; index < rawList.length; index += 1) {
    const preset = normalizeCategoryPreset(rawList[index], index)
    if (!preset) {
      continue
    }

    // 类别名按大小写不敏感去重，避免“餐饮/餐 饮”被视为不同类别。
    const nameKey = preset.name.toLowerCase()
    if (presetNameSet.has(nameKey)) {
      continue
    }
    presetNameSet.add(nameKey)
    normalized.push(preset)
  }

  if (normalized.length === 0) {
    return cloneCategoryPresets(DEFAULT_CATEGORY_PRESETS)
  }

  return normalized
}

/**
 * 读取类别预设；缺失或损坏时回退到默认预设。
 *
 * @returns {Array<{id: string, name: string, aliases: string[]}>} 类别预设列表。
 */
export function loadCategoryPresets() {
  const raw = localStorage.getItem(CATEGORY_PRESETS_STORAGE_KEY)
  if (!raw) {
    return cloneCategoryPresets(DEFAULT_CATEGORY_PRESETS)
  }

  const parsed = safeParseJSON(raw)
  if (!parsed) {
    return cloneCategoryPresets(DEFAULT_CATEGORY_PRESETS)
  }

  return normalizeCategoryPresetList(parsed)
}

/**
 * 保存类别预设并返回归一化结果。
 *
 * @param {Array<{id?: string, name?: string, aliases?: string[]}>} categoryPresets 待保存预设列表。
 * @returns {Array<{id: string, name: string, aliases: string[]}>} 归一化后的预设。
 * @throws {Error} 浏览器存储不可写时抛出。
 */
export function saveCategoryPresets(categoryPresets) {
  const normalized = normalizeCategoryPresetList(categoryPresets)
  try {
    localStorage.setItem(CATEGORY_PRESETS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    throw new Error('类别预设保存失败，请检查浏览器存储权限后重试')
  }
  return cloneCategoryPresets(normalized)
}

/**
 * 归一化单条账单记录。
 *
 * @param {any} [rawEntry={}] 原始账单对象。
 * @param {number} [index=0] 账单索引，用于兜底 ID。
 * @returns {object | null} 合法账单对象；非法数据返回 null。
 */
function normalizeLedgerEntry(rawEntry = {}, index = 0) {
  const amount = Number(rawEntry.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    // 过滤无效金额，防止脏数据进入账本。
    return null
  }

  const nowISO = new Date().toISOString()
  const id = normalizeTextField(rawEntry.id, `ledger-${index + 1}`)

  return {
    id,
    amount: Math.round(amount * 100) / 100,
    currency: normalizeCurrency(rawEntry.currency),
    occurredAt: normalizeISODate(rawEntry.occurredAt, nowISO),
    location: normalizeTextField(rawEntry.location),
    paymentMethod: normalizeTextField(rawEntry.paymentMethod),
    merchant: normalizeTextField(rawEntry.merchant),
    category: normalizeTextField(rawEntry.category, '其他'),
    note: normalizeTextField(rawEntry.note),
    transactionType: normalizeTransactionType(rawEntry.transactionType),
    sourceImageName: normalizeTextField(rawEntry.sourceImageName),
    aiProvider: rawEntry.aiProvider === 'anthropic' ? 'anthropic' : 'openai',
    aiModel: normalizeTextField(rawEntry.aiModel),
    aiConfidence: normalizeConfidence(rawEntry.aiConfidence),
    createdAt: normalizeISODate(rawEntry.createdAt, nowISO),
  }
}

/**
 * 归一化账单列表，过滤非法记录。
 *
 * @param {unknown} rawList 原始账单列表。
 * @returns {object[]} 归一化后的账单数组。
 */
function normalizeLedgerEntryList(rawList) {
  if (!Array.isArray(rawList)) {
    return []
  }

  const normalized = []
  for (let index = 0; index < rawList.length; index += 1) {
    const entry = normalizeLedgerEntry(rawList[index], index)
    if (entry) {
      normalized.push(entry)
    }
  }
  return normalized
}

/**
 * 深拷贝账单数组。
 *
 * @param {object[]} entries 账单数组。
 * @returns {object[]} 拷贝后的账单数组。
 */
function cloneLedgerEntries(entries) {
  return entries.map((entry) => ({ ...entry }))
}

/**
 * 从 localStorage 读取历史账单并做字段归一化，用于一次性迁移。
 *
 * @returns {Array<object>} 可直接渲染的账单数组。
 */
function loadLegacyLedgerEntries() {
  const raw = localStorage.getItem(LEDGER_STORAGE_KEY)
  if (!raw) {
    return []
  }

  const parsed = safeParseJSON(raw)
  if (!parsed) {
    return []
  }

  return normalizeLedgerEntryList(parsed)
}

/**
 * 归一化最近账单查询条数，避免无效参数导致空查询或异常。
 *
 * @param {unknown} limit 最近条数。
 * @returns {number} 合法条数。
 */
function normalizeRecentLimit(limit) {
  const parsed = Number(limit)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RECENT_LEDGER_LIMIT
  }
  return Math.floor(parsed)
}

/**
 * 将 `YYYY-MM-DD` 日期文本转换为本地日范围 ISO（左闭右开）。
 *
 * @param {string} dateText 日期文本。
 * @returns {{startISO: string, endISO: string} | null} 日期范围；非法输入返回 null。
 */
function parseDateTextToDayRange(dateText) {
  if (typeof dateText !== 'string') {
    return null
  }

  const matched = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!matched) {
    return null
  }

  const [, yearText, monthText, dayText] = matched
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1
  const day = Number(dayText)
  const start = new Date(year, monthIndex, day, 0, 0, 0, 0)
  if (Number.isNaN(start.getTime())) {
    return null
  }

  // 若 Date 自动进位导致年月日变化，说明输入日期本身非法（如 2026-02-30）。
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== monthIndex ||
    start.getDate() !== day
  ) {
    return null
  }

  const end = new Date(year, monthIndex, day + 1, 0, 0, 0, 0)
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  }
}

/**
 * 确保账本已完成初始化与历史数据迁移。
 *
 * @returns {Promise<void>} 无返回值。
 */
export function ensureLedgerStoreReady() {
  if (ledgerStoreReadyPromise) {
    return ledgerStoreReadyPromise
  }

  ledgerStoreReadyPromise = (async () => {
    const migrationMeta = await getAppMetaRecord(LEDGER_MIGRATION_META_KEY)
    if (migrationMeta?.value) {
      return
    }

    const legacyEntries = loadLegacyLedgerEntries()
    if (legacyEntries.length > 0) {
      await bulkUpsertLedgerEntries(legacyEntries)
    }

    await putAppMetaRecord({
      key: LEDGER_MIGRATION_META_KEY,
      value: new Date().toISOString(),
    })
  })().catch((error) => {
    // 迁移失败时重置 promise，允许用户刷新后重试。
    ledgerStoreReadyPromise = null
    throw error
  })

  return ledgerStoreReadyPromise
}

/**
 * 查询全部账单（按交易时间倒序）。
 *
 * @returns {Promise<Array<object>>} 账单列表。
 */
export async function listAllLedgerEntries() {
  await ensureLedgerStoreReady()
  const entries = await listAllLedgerEntriesDesc()
  return cloneLedgerEntries(entries)
}

/**
 * 查询最近账单（默认最近 30 条，按交易时间倒序）。
 *
 * @param {number} [limit=30] 最大条数。
 * @returns {Promise<Array<object>>} 账单列表。
 */
export async function listRecentLedgerEntries(limit = DEFAULT_RECENT_LEDGER_LIMIT) {
  await ensureLedgerStoreReady()
  const normalizedLimit = normalizeRecentLimit(limit)
  const entries = await listRecentLedgerEntriesDesc(normalizedLimit)
  return cloneLedgerEntries(entries)
}

/**
 * 查询指定日期账单（本地日，按交易时间倒序）。
 *
 * @param {string} dateText `YYYY-MM-DD` 日期文本。
 * @returns {Promise<Array<object>>} 账单列表；日期非法时返回空数组。
 */
export async function listLedgerEntriesByDate(dateText) {
  const dayRange = parseDateTextToDayRange(dateText)
  if (!dayRange) {
    return []
  }

  await ensureLedgerStoreReady()
  const entries = await listLedgerEntriesInRangeDesc(dayRange.startISO, dayRange.endISO)
  return cloneLedgerEntries(entries)
}

/**
 * 追加单条账单到 IndexedDB。
 *
 * @param {object} entry 待追加账单。
 * @returns {Promise<object>} 写入后的归一化账单。
 * @throws {Error} 当账单格式不合法或存储失败时抛出。
 */
export async function appendLedgerEntry(entry) {
  await ensureLedgerStoreReady()

  const normalizedEntry = normalizeLedgerEntry({
    ...entry,
    id: normalizeTextField(entry?.id, createRuntimeId('ledger')),
  })

  if (!normalizedEntry) {
    throw new Error('账单格式不合法，保存失败')
  }

  await upsertLedgerEntry(normalizedEntry)
  return {
    ...normalizedEntry,
  }
}

/**
 * 测试辅助：重置账本初始化状态，便于验证迁移幂等性。
 *
 * @returns {void} 无返回值。
 */
export function __resetLedgerStoreReadyForTest() {
  ledgerStoreReadyPromise = null
}
