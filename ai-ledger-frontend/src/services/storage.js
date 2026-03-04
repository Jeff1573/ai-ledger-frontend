import {
  bulkUpsertLedgerEntries,
  getAppMetaRecord,
  listAllLedgerEntriesDesc,
  listAllLedgerEntriesRaw,
  listLedgerEntriesInRangeDesc,
  putAppMetaRecord,
  upsertLedgerEntry,
} from './ledgerDb'
import { cloudApiRequest, isCloudApiConfigured } from './cloudApiClient'

// 访客模式 ownerKey；未登录时所有本地数据都挂在该命名空间下。
export const GUEST_OWNER_KEY = 'guest'

// localStorage 键名统一集中管理，便于后续版本迁移与清理。
const AI_CONFIG_STORAGE_KEY = 'ai_accounting_config_v1'
// 账单数据历史存储键（仅用于首次迁移）。
const LEDGER_STORAGE_KEY = 'ai_accounting_ledger_entries_v1'
// 类别预设存储键。
const CATEGORY_PRESETS_STORAGE_KEY = 'ai_accounting_category_presets_v1'
// 类别预设同步元信息键（updatedAt/dirty）。
const CATEGORY_PRESETS_META_STORAGE_KEY = 'ai_accounting_category_presets_meta_v1'
// 账本迁移元数据键（写入 IndexedDB appMeta 表）。
const LEDGER_MIGRATION_META_KEY = 'ledger_migrated_from_localstorage_v1'
// 云端账单最近拉取游标前缀。
const LEDGER_CLOUD_LAST_PULL_META_PREFIX = 'ledger_cloud_last_pull_v1_'
// 访客账单迁移到指定账号的标记前缀。
const LEDGER_GUEST_MIGRATED_META_PREFIX = 'ledger_guest_migrated_v1_'
// 最近账单默认条数。
const DEFAULT_RECENT_LEDGER_LIMIT = 30
// 账单云端批量 upsert 条数。
const LEDGER_CLOUD_PUSH_BATCH_SIZE = 100
// 账单云端增量拉取上限。
const LEDGER_CLOUD_PULL_LIMIT = 1000
// 自动触发本地变更同步的延迟（毫秒）。
const AUTO_SYNC_DELAY_MS = 300
// 同步失败退避策略（毫秒）。
const LEDGER_SYNC_RETRY_DELAYS_MS = [5000, 30000, 120000, 600000, 1800000]

// 账本初始化 Promise（含迁移）；用于并发场景去重执行。
let ledgerStoreReadyPromise = null
// 当前激活 ownerKey（访客或用户 ID）。
let activeOwnerKey = GUEST_OWNER_KEY

// 云同步单飞任务，避免重复并发请求。
const cloudSyncSingleFlightMap = new Map()
// 各 owner 的延时同步定时器（AI 配置）。
const aiConfigSyncTimerMap = new Map()
// 各 owner 的延时同步定时器（类别预设）。
const categorySyncTimerMap = new Map()
// 各 owner 的延时同步定时器（账单）。
const ledgerSyncTimerMap = new Map()

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
 * 创建类别预设同步元信息默认值。
 *
 * @returns {{updatedAt: string, dirty: boolean}} 默认元信息。
 */
function createDefaultCategoryMeta() {
  return {
    updatedAt: '',
    dirty: false,
  }
}

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
 * 归一化 ownerKey，非法值回退到兜底值。
 *
 * @param {unknown} ownerKey 原始 ownerKey。
 * @param {string} [fallback=GUEST_OWNER_KEY] 兜底值。
 * @returns {string} 合法 ownerKey。
 */
function normalizeOwnerKey(ownerKey, fallback = GUEST_OWNER_KEY) {
  if (typeof ownerKey !== 'string') {
    return fallback
  }
  const normalized = ownerKey.trim()
  return normalized || fallback
}

/**
 * 构建 owner 维度的 localStorage 键名。
 *
 * @param {string} baseKey 基础键名。
 * @param {string} [ownerKey=activeOwnerKey] ownerKey。
 * @returns {string} owner 维度键名。
 */
function buildScopedStorageKey(baseKey, ownerKey = activeOwnerKey) {
  return `${baseKey}__${normalizeOwnerKey(ownerKey)}`
}

/**
 * 读取 localStorage，访客模式兼容历史未分区键名。
 *
 * @param {string} baseKey 基础键名。
 * @param {string} [ownerKey=activeOwnerKey] ownerKey。
 * @returns {string | null} 读取到的原始值。
 */
function readScopedStorage(baseKey, ownerKey = activeOwnerKey) {
  const scopedKey = buildScopedStorageKey(baseKey, ownerKey)
  const scopedRaw = localStorage.getItem(scopedKey)
  if (scopedRaw !== null) {
    return scopedRaw
  }

  // 访客模式兼容旧版本直接写入 baseKey 的数据。
  if (normalizeOwnerKey(ownerKey) === GUEST_OWNER_KEY) {
    return localStorage.getItem(baseKey)
  }
  return null
}

/**
 * 写入 localStorage，并在访客模式额外写入历史键名。
 *
 * @param {string} baseKey 基础键名。
 * @param {string} rawValue 原始值。
 * @param {string} [ownerKey=activeOwnerKey] ownerKey。
 * @returns {void} 无返回值。
 */
function writeScopedStorage(baseKey, rawValue, ownerKey = activeOwnerKey) {
  const scopedKey = buildScopedStorageKey(baseKey, ownerKey)
  localStorage.setItem(scopedKey, rawValue)

  // 访客模式继续兼容旧键名，避免用户升级后丢失历史配置。
  if (normalizeOwnerKey(ownerKey) === GUEST_OWNER_KEY) {
    localStorage.setItem(baseKey, rawValue)
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
 * 判断给定时间文本是否可解析为合法日期。
 *
 * @param {unknown} value 时间文本。
 * @returns {boolean} 是否合法。
 */
function isValidDateValue(value) {
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime())
}

/**
 * 归一化 ISO 时间文本。
 *
 * @param {unknown} value 原始时间。
 * @param {string} [fallback=''] 兜底值。
 * @returns {string} 归一化后的 ISO 文本。
 */
function normalizeISOText(value, fallback = '') {
  if (!isValidDateValue(value)) {
    return fallback
  }
  return new Date(value).toISOString()
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
  updatedAt: '',
  dirty: false,
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
 *   },
 *   updatedAt: string,
 *   dirty: boolean
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
    updatedAt: normalizeISOText(raw.updatedAt),
    dirty: Boolean(raw.dirty),
  }
}

/**
 * 判断 AI 配置是否具备可用请求条件。
 *
 * @param {ReturnType<typeof normalizeConfig>} config AI 配置。
 * @returns {boolean} 是否可用。
 */
function isAIConfigUsable(config) {
  const provider = config.provider === 'anthropic' ? 'anthropic' : 'openai'
  const activeModel = config.providerModels?.[provider]?.currentModel?.trim() || ''
  return Boolean(config.baseURL?.trim() && config.token?.trim() && activeModel)
}

/**
 * 获取 AI 配置更新时间时间戳。
 *
 * @param {ReturnType<typeof normalizeConfig> | null} config AI 配置。
 * @returns {number} 时间戳；不存在时返回 0。
 */
function getAIConfigUpdatedAtMs(config) {
  if (!config?.updatedAt) {
    return 0
  }
  const parsed = new Date(config.updatedAt).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 读取并归一化 AI 配置。
 *
 * @param {string} [ownerKey=activeOwnerKey] ownerKey。
 * @returns {{
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: {
 *     openai: { currentModel: string, models: string[] },
 *     anthropic: { currentModel: string, models: string[] }
 *   },
 *   updatedAt: string,
 *   dirty: boolean
 * }} 可直接用于页面与请求构建的配置对象。
 */
export function loadAIConfig(ownerKey = activeOwnerKey) {
  const raw = readScopedStorage(AI_CONFIG_STORAGE_KEY, ownerKey)
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

  const normalized = normalizeConfig(parsed)
  return {
    ...normalized,
    providerModels: cloneProviderModels(normalized.providerModels),
  }
}

/**
 * 单飞执行异步任务；相同 key 在任务完成前复用同一个 Promise。
 *
 * @template T
 * @param {string} key 单飞键名。
 * @param {() => Promise<T>} task 异步任务。
 * @returns {Promise<T>} 任务结果。
 */
function runSingleFlight(key, task) {
  if (cloudSyncSingleFlightMap.has(key)) {
    return cloudSyncSingleFlightMap.get(key)
  }

  const promise = task().finally(() => {
    cloudSyncSingleFlightMap.delete(key)
  })
  cloudSyncSingleFlightMap.set(key, promise)
  return promise
}

/**
 * 安排 owner 级延时同步任务（后一次调用会覆盖前一次）。
 *
 * @param {Map<string, ReturnType<typeof setTimeout>>} timerMap 定时器映射。
 * @param {string} ownerKey ownerKey。
 * @param {() => Promise<void>} task 同步任务。
 * @returns {void} 无返回值。
 */
function scheduleOwnerSync(timerMap, ownerKey, task) {
  const normalizedOwnerKey = normalizeOwnerKey(ownerKey)
  const existedTimer = timerMap.get(normalizedOwnerKey)
  if (existedTimer) {
    clearTimeout(existedTimer)
  }

  const timer = setTimeout(() => {
    timerMap.delete(normalizedOwnerKey)
    task().catch(() => {
      // 自动重试路径不打断用户操作，错误由周期同步与手动同步兜底。
    })
  }, AUTO_SYNC_DELAY_MS)
  timerMap.set(normalizedOwnerKey, timer)
}

/**
 * 保存 AI 配置到 localStorage，并返回可安全复用的归一化副本。
 *
 * @param {object} config 待保存配置。
 * @param {{markDirty?: boolean, updatedAt?: string, skipAutoSync?: boolean, ownerKey?: string}} [options={}] 保存选项。
 * @returns {{
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: {
 *     openai: { currentModel: string, models: string[] },
 *     anthropic: { currentModel: string, models: string[] }
 *   },
 *   updatedAt: string,
 *   dirty: boolean
 * }} 归一化配置副本。
 * @throws {Error} 浏览器存储不可写时抛出。
 */
export function saveAIConfig(config, options = {}) {
  const normalized = normalizeConfig(config)
  const updatedAt = normalizeISOText(options.updatedAt, normalized.updatedAt || new Date().toISOString())
  const markDirty = options.markDirty ?? true
  const targetOwnerKey = normalizeOwnerKey(options.ownerKey, activeOwnerKey)
  const persistPayload = {
    ...normalized,
    updatedAt,
    dirty: markDirty,
  }

  try {
    writeScopedStorage(AI_CONFIG_STORAGE_KEY, JSON.stringify(persistPayload), targetOwnerKey)
  } catch {
    throw new Error('配置保存失败，请检查浏览器存储权限或清理存储空间后重试')
  }

  const cloned = {
    ...persistPayload,
    providerModels: cloneProviderModels(persistPayload.providerModels),
  }

  // 已登录 owner 保存配置后自动触发一次 AI 配置同步。
  if (!options.skipAutoSync && targetOwnerKey !== GUEST_OWNER_KEY && markDirty) {
    scheduleOwnerSync(aiConfigSyncTimerMap, targetOwnerKey, async () => {
      await syncAIConfigNow(targetOwnerKey)
    })
  }

  return cloned
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
 * 归一化可选 ISO 日期字段，非法值返回空串。
 *
 * @param {unknown} value 原始日期值。
 * @returns {string} ISO 文本或空串。
 */
function normalizeOptionalISODate(value) {
  if (!value) {
    return ''
  }
  return normalizeISOText(value)
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
 * 读取类别预设同步元信息。
 *
 * @param {string} [ownerKey=activeOwnerKey] ownerKey。
 * @returns {{updatedAt: string, dirty: boolean}} 元信息。
 */
function loadCategoryPresetsMeta(ownerKey = activeOwnerKey) {
  const raw = readScopedStorage(CATEGORY_PRESETS_META_STORAGE_KEY, ownerKey)
  if (!raw) {
    return createDefaultCategoryMeta()
  }
  const parsed = safeParseJSON(raw)
  if (!parsed || typeof parsed !== 'object') {
    return createDefaultCategoryMeta()
  }
  return {
    updatedAt: normalizeISOText(parsed.updatedAt),
    dirty: Boolean(parsed.dirty),
  }
}

/**
 * 保存类别预设同步元信息。
 *
 * @param {{updatedAt: string, dirty: boolean}} meta 元信息。
 * @param {string} [ownerKey=activeOwnerKey] ownerKey。
 * @returns {{updatedAt: string, dirty: boolean}} 已保存元信息。
 */
function saveCategoryPresetsMeta(meta, ownerKey = activeOwnerKey) {
  const normalized = {
    updatedAt: normalizeISOText(meta.updatedAt),
    dirty: Boolean(meta.dirty),
  }
  writeScopedStorage(CATEGORY_PRESETS_META_STORAGE_KEY, JSON.stringify(normalized), ownerKey)
  return normalized
}

/**
 * 获取类别预设更新时间时间戳。
 *
 * @param {{updatedAt: string, dirty: boolean} | null} meta 元信息。
 * @returns {number} 时间戳；不存在时返回 0。
 */
function getCategoryMetaUpdatedAtMs(meta) {
  if (!meta?.updatedAt) {
    return 0
  }
  const parsed = new Date(meta.updatedAt).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 读取类别预设；缺失或损坏时回退到默认预设。
 *
 * @param {string} [ownerKey=activeOwnerKey] ownerKey。
 * @returns {Array<{id: string, name: string, aliases: string[]}>} 类别预设列表。
 */
export function loadCategoryPresets(ownerKey = activeOwnerKey) {
  const raw = readScopedStorage(CATEGORY_PRESETS_STORAGE_KEY, ownerKey)
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
 * @param {{markDirty?: boolean, updatedAt?: string, skipAutoSync?: boolean, ownerKey?: string}} [options={}] 保存选项。
 * @returns {Array<{id: string, name: string, aliases: string[]}>} 归一化后的预设。
 * @throws {Error} 浏览器存储不可写时抛出。
 */
export function saveCategoryPresets(categoryPresets, options = {}) {
  const normalized = normalizeCategoryPresetList(categoryPresets)
  const updatedAt = normalizeISOText(options.updatedAt, new Date().toISOString())
  const markDirty = options.markDirty ?? true
  const targetOwnerKey = normalizeOwnerKey(options.ownerKey, activeOwnerKey)

  try {
    writeScopedStorage(CATEGORY_PRESETS_STORAGE_KEY, JSON.stringify(normalized), targetOwnerKey)
    saveCategoryPresetsMeta({
      updatedAt,
      dirty: markDirty,
    }, targetOwnerKey)
  } catch {
    throw new Error('类别预设保存失败，请检查浏览器存储权限后重试')
  }

  // 已登录 owner 保存类别后自动触发一次云同步。
  if (!options.skipAutoSync && targetOwnerKey !== GUEST_OWNER_KEY && markDirty) {
    scheduleOwnerSync(categorySyncTimerMap, targetOwnerKey, async () => {
      await syncCategoryPresetsForUser(targetOwnerKey)
    })
  }

  return cloneCategoryPresets(normalized)
}

/**
 * 归一化账单同步状态。
 *
 * @param {unknown} value 原始同步状态。
 * @param {string} ownerKey ownerKey。
 * @returns {'pending' | 'synced' | 'failed'} 合法同步状态。
 */
function normalizeLedgerSyncStatus(value, ownerKey) {
  if (value === 'pending' || value === 'synced' || value === 'failed') {
    return value
  }
  return ownerKey === GUEST_OWNER_KEY ? 'synced' : 'pending'
}

/**
 * 归一化非负整数值。
 *
 * @param {unknown} value 原始值。
 * @param {number} [fallback=0] 兜底值。
 * @returns {number} 非负整数。
 */
function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }
  return Math.floor(parsed)
}

/**
 * 归一化单条账单记录。
 *
 * @param {any} [rawEntry={}] 原始账单对象。
 * @param {number} [index=0] 账单索引，用于兜底 ID。
 * @param {{
 *   ownerKeyFallback?: string,
 *   forceSyncStatus?: 'pending' | 'synced' | 'failed'
 * }} [options={}] 归一化选项。
 * @returns {object | null} 合法账单对象；非法数据返回 null。
 */
function normalizeLedgerEntry(rawEntry = {}, index = 0, options = {}) {
  const amount = Number(rawEntry.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    // 过滤无效金额，防止脏数据进入账本。
    return null
  }

  const nowISO = new Date().toISOString()
  const ownerKey = normalizeOwnerKey(rawEntry.ownerKey, options.ownerKeyFallback || activeOwnerKey)
  const id = normalizeTextField(rawEntry.id, `ledger-${index + 1}`)
  const createdAt = normalizeISODate(rawEntry.createdAt, nowISO)
  const occurredAt = normalizeISODate(rawEntry.occurredAt, nowISO)
  const updatedAt = normalizeISODate(rawEntry.updatedAt, createdAt)
  const syncStatus = options.forceSyncStatus || normalizeLedgerSyncStatus(rawEntry.syncStatus, ownerKey)

  return {
    id,
    ownerKey,
    amount: Math.round(amount * 100) / 100,
    currency: normalizeCurrency(rawEntry.currency),
    occurredAt,
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
    createdAt,
    updatedAt,
    syncStatus,
    syncRetryCount: normalizeNonNegativeInteger(rawEntry.syncRetryCount),
    syncNextRetryAt: normalizeOptionalISODate(rawEntry.syncNextRetryAt),
  }
}

/**
 * 归一化账单列表，过滤非法记录。
 *
 * @param {unknown} rawList 原始账单列表。
 * @param {{
 *   ownerKeyFallback?: string,
 *   forceSyncStatus?: 'pending' | 'synced' | 'failed'
 * }} [options={}] 归一化选项。
 * @returns {object[]} 归一化后的账单数组。
 */
function normalizeLedgerEntryList(rawList, options = {}) {
  if (!Array.isArray(rawList)) {
    return []
  }

  const normalized = []
  for (let index = 0; index < rawList.length; index += 1) {
    const entry = normalizeLedgerEntry(rawList[index], index, options)
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
 * 判断账单是否属于指定 owner。
 *
 * @param {object} entry 账单对象。
 * @param {string} ownerKey ownerKey。
 * @returns {boolean} 是否属于该 owner。
 */
function isEntryOwnedBy(entry, ownerKey) {
  return normalizeOwnerKey(entry?.ownerKey, GUEST_OWNER_KEY) === normalizeOwnerKey(ownerKey)
}

/**
 * 按 ownerKey 过滤账单列表。
 *
 * @param {Array<object>} entries 原始账单列表。
 * @param {string} [ownerKey=activeOwnerKey] ownerKey。
 * @returns {Array<object>} 过滤后的账单列表。
 */
function filterLedgerEntriesByOwner(entries, ownerKey = activeOwnerKey) {
  return entries.filter((entry) => isEntryOwnedBy(entry, ownerKey))
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

  return normalizeLedgerEntryList(parsed, {
    ownerKeyFallback: GUEST_OWNER_KEY,
    forceSyncStatus: 'synced',
  })
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
 * 查询全部账单（按交易时间倒序，限定当前 owner）。
 *
 * @returns {Promise<Array<object>>} 账单列表。
 */
export async function listAllLedgerEntries() {
  await ensureLedgerStoreReady()
  const entries = await listAllLedgerEntriesDesc()
  return cloneLedgerEntries(filterLedgerEntriesByOwner(entries))
}

/**
 * 查询最近账单（默认最近 30 条，按交易时间倒序，限定当前 owner）。
 *
 * @param {number} [limit=30] 最大条数。
 * @returns {Promise<Array<object>>} 账单列表。
 */
export async function listRecentLedgerEntries(limit = DEFAULT_RECENT_LEDGER_LIMIT) {
  await ensureLedgerStoreReady()
  const normalizedLimit = normalizeRecentLimit(limit)
  // 需要先按 owner 过滤再截断，避免跨 owner 数据干扰最近 N 条结果。
  const allEntries = await listAllLedgerEntriesDesc()
  const filtered = filterLedgerEntriesByOwner(allEntries)
  return cloneLedgerEntries(filtered.slice(0, normalizedLimit))
}

/**
 * 查询指定日期账单（本地日，按交易时间倒序，限定当前 owner）。
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
  return cloneLedgerEntries(filterLedgerEntriesByOwner(entries))
}

/**
 * 追加单条账单到 IndexedDB。
 *
 * @param {object} entry 待追加账单。
 * @returns {Promise<object>} 写入后的归一化账单。
 * @throws {Error} 当账单格式不合法或存储失败时抛出。
 */
export async function appendLedgerEntry(entry) {
  const ownerKeySnapshot = activeOwnerKey
  await ensureLedgerStoreReady()

  const nowISO = new Date().toISOString()
  const shouldMarkPending = ownerKeySnapshot !== GUEST_OWNER_KEY
  const normalizedEntry = normalizeLedgerEntry(
    {
      ...entry,
      id: normalizeTextField(entry?.id, createRuntimeId('ledger')),
      ownerKey: ownerKeySnapshot,
      updatedAt: nowISO,
      syncStatus: shouldMarkPending ? 'pending' : 'synced',
      syncRetryCount: 0,
      syncNextRetryAt: '',
    },
    0,
    {
      ownerKeyFallback: ownerKeySnapshot,
      forceSyncStatus: shouldMarkPending ? 'pending' : 'synced',
    },
  )

  if (!normalizedEntry) {
    throw new Error('账单格式不合法，保存失败')
  }

  await upsertLedgerEntry(normalizedEntry)

  // 登录用户新增账单后自动触发一次云同步。
  if (shouldMarkPending) {
    scheduleOwnerSync(ledgerSyncTimerMap, ownerKeySnapshot, async () => {
      await syncLedgerEntriesForUser(ownerKeySnapshot)
    })
  }

  return {
    ...normalizedEntry,
  }
}

/**
 * 按账单 ID 查找当前 owner 可编辑的账单记录。
 *
 * @param {string} entryId 账单 ID。
 * @param {string} ownerKey ownerKey 快照。
 * @returns {Promise<object | null>} 匹配到的账单；未命中返回 null。
 */
async function findOwnedLedgerEntryById(entryId, ownerKey) {
  const normalizedId = normalizeTextField(entryId)
  if (!normalizedId) {
    return null
  }

  const allEntries = await listAllLedgerEntriesRaw()
  for (let index = 0; index < allEntries.length; index += 1) {
    const normalizedEntry = normalizeLedgerEntry(allEntries[index], index, {
      ownerKeyFallback: GUEST_OWNER_KEY,
    })
    if (!normalizedEntry) {
      continue
    }
    if (normalizedEntry.id !== normalizedId) {
      continue
    }
    if (!isEntryOwnedBy(normalizedEntry, ownerKey)) {
      continue
    }
    return normalizedEntry
  }
  return null
}

/**
 * 按 ID 更新单条账单到 IndexedDB（同 ID 覆盖）。
 *
 * @param {object} entry 待更新账单。
 * @returns {Promise<object>} 更新后的归一化账单。
 * @throws {Error} 当账单不存在、owner 不匹配或格式不合法时抛出。
 */
export async function updateLedgerEntry(entry) {
  const ownerKeySnapshot = activeOwnerKey
  await ensureLedgerStoreReady()

  const normalizedEntryId = normalizeTextField(entry?.id)
  if (!normalizedEntryId) {
    throw new Error('账单 ID 不能为空，无法编辑')
  }

  const existedEntry = await findOwnedLedgerEntryById(normalizedEntryId, ownerKeySnapshot)
  if (!existedEntry) {
    throw new Error('未找到可编辑的账单记录')
  }

  const nowISO = new Date().toISOString()
  const shouldMarkPending = ownerKeySnapshot !== GUEST_OWNER_KEY
  const normalizedEntry = normalizeLedgerEntry(
    {
      ...existedEntry,
      ...entry,
      id: normalizedEntryId,
      ownerKey: ownerKeySnapshot,
      // 编辑仅刷新更新时间，保留原创建时间用于审计。
      createdAt: existedEntry.createdAt,
      updatedAt: nowISO,
      syncStatus: shouldMarkPending ? 'pending' : 'synced',
      syncRetryCount: 0,
      syncNextRetryAt: '',
    },
    0,
    {
      ownerKeyFallback: ownerKeySnapshot,
      forceSyncStatus: shouldMarkPending ? 'pending' : 'synced',
    },
  )

  if (!normalizedEntry) {
    throw new Error('账单格式不合法，保存失败')
  }

  await upsertLedgerEntry(normalizedEntry)

  // 登录用户编辑账单后自动触发一次云同步。
  if (shouldMarkPending) {
    scheduleOwnerSync(ledgerSyncTimerMap, ownerKeySnapshot, async () => {
      await syncLedgerEntriesForUser(ownerKeySnapshot)
    })
  }

  return {
    ...normalizedEntry,
  }
}

/**
 * 设置当前生效 ownerKey（访客或用户 ID）。
 *
 * @param {string} ownerKey ownerKey。
 * @returns {string} 生效后的 ownerKey。
 */
export function setStorageOwnerKey(ownerKey) {
  activeOwnerKey = normalizeOwnerKey(ownerKey, GUEST_OWNER_KEY)
  return activeOwnerKey
}

/**
 * 获取当前生效 ownerKey。
 *
 * @returns {string} ownerKey。
 */
export function getStorageOwnerKey() {
  return activeOwnerKey
}

/**
 * 将云端 AI 配置记录映射为本地配置对象。
 *
 * @param {Record<string, any>} row 云端记录。
 * @returns {ReturnType<typeof normalizeConfig>} 本地配置对象。
 */
function mapCloudAIConfigRowToLocal(row) {
  return normalizeConfig({
    provider: row.provider,
    baseURL: row.base_url,
    token: row.token,
    providerModels: row.provider_models,
    updatedAt: row.updated_at,
    dirty: false,
  })
}

/**
 * 将本地 AI 配置映射为云端 upsert 行数据。
 *
 * @param {string} userId 用户 ID。
 * @param {ReturnType<typeof normalizeConfig>} config 本地配置。
 * @returns {Record<string, any>} 云端行数据。
 */
function mapLocalAIConfigToCloudRow(userId, config) {
  const nowISO = new Date().toISOString()
  return {
    user_id: userId,
    provider: config.provider,
    base_url: config.baseURL,
    token: config.token,
    provider_models: config.providerModels,
    updated_at: normalizeISOText(config.updatedAt, nowISO),
    created_at: nowISO,
  }
}

/**
 * 从云端读取 AI 配置。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<ReturnType<typeof normalizeConfig> | null>} 云端配置或 null。
 */
export async function pullAIConfig(userId) {
  if (!isCloudApiConfigured()) {
    return null
  }

  const normalizedUserId = normalizeOwnerKey(userId)
  if (!normalizedUserId || normalizedUserId === GUEST_OWNER_KEY) {
    return null
  }

  const response = await cloudApiRequest('/sync/ai-config')
  if (!response?.item) {
    return null
  }

  return mapCloudAIConfigRowToLocal(response.item)
}

/**
 * 推送 AI 配置到云端。
 *
 * @param {string} userId 用户 ID。
 * @param {ReturnType<typeof normalizeConfig>} config AI 配置。
 * @returns {Promise<ReturnType<typeof normalizeConfig>>} 云端落库后的配置对象。
 */
export async function pushAIConfig(userId, config) {
  if (!isCloudApiConfigured()) {
    throw new Error('云服务未配置，无法推送 AI 配置')
  }

  const normalizedUserId = normalizeOwnerKey(userId)
  if (!normalizedUserId || normalizedUserId === GUEST_OWNER_KEY) {
    throw new Error('未登录状态不可推送 AI 配置')
  }

  const row = mapLocalAIConfigToCloudRow(normalizedUserId, normalizeConfig(config))
  const response = await cloudApiRequest('/sync/ai-config', {
    method: 'PUT',
    body: row,
  })
  const data = response?.item

  if (!data) {
    return normalizeConfig({
      ...config,
      updatedAt: row.updated_at,
      dirty: false,
    })
  }

  return mapCloudAIConfigRowToLocal(data)
}

/**
 * 执行 AI 配置双向同步（LWW：最后更新时间优先）。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<{direction: 'pull' | 'push' | 'noop'}>} 同步方向结果。
 */
export async function syncAIConfigNow(userId) {
  const normalizedUserId = normalizeOwnerKey(userId)
  if (!isCloudApiConfigured() || normalizedUserId === GUEST_OWNER_KEY) {
    return { direction: 'noop' }
  }

  return runSingleFlight(`sync:ai:${normalizedUserId}`, async () => {
    const localConfig = normalizeConfig(loadAIConfig(normalizedUserId))
    const remoteConfig = await pullAIConfig(normalizedUserId)
    const localUpdatedAtMs = getAIConfigUpdatedAtMs(localConfig)
    const remoteUpdatedAtMs = getAIConfigUpdatedAtMs(remoteConfig)

    if (!remoteConfig) {
      if (!isAIConfigUsable(localConfig)) {
        if (localConfig.dirty) {
          saveAIConfig(localConfig, {
            markDirty: false,
            updatedAt: localConfig.updatedAt || new Date().toISOString(),
            skipAutoSync: true,
            ownerKey: normalizedUserId,
          })
        }
        return { direction: 'noop' }
      }

      const pushedConfig = await pushAIConfig(normalizedUserId, {
        ...localConfig,
        updatedAt: localConfig.updatedAt || new Date().toISOString(),
      })
      saveAIConfig(pushedConfig, {
        markDirty: false,
        updatedAt: pushedConfig.updatedAt || new Date().toISOString(),
        skipAutoSync: true,
        ownerKey: normalizedUserId,
      })
      return { direction: 'push' }
    }

    if (remoteUpdatedAtMs > localUpdatedAtMs) {
      saveAIConfig(remoteConfig, {
        markDirty: false,
        updatedAt: remoteConfig.updatedAt || new Date().toISOString(),
        skipAutoSync: true,
        ownerKey: normalizedUserId,
      })
      return { direction: 'pull' }
    }

    if (localUpdatedAtMs > remoteUpdatedAtMs || localConfig.dirty) {
      const pushedConfig = await pushAIConfig(normalizedUserId, {
        ...localConfig,
        updatedAt: localConfig.updatedAt || new Date().toISOString(),
      })
      saveAIConfig(pushedConfig, {
        markDirty: false,
        updatedAt: pushedConfig.updatedAt || new Date().toISOString(),
        skipAutoSync: true,
        ownerKey: normalizedUserId,
      })
      return { direction: 'push' }
    }

    return { direction: 'noop' }
  })
}

/**
 * 将云端类别预设记录映射为本地数据。
 *
 * @param {Record<string, any>} row 云端记录。
 * @returns {{presets: Array<{id: string, name: string, aliases: string[]}>, updatedAt: string}} 本地数据。
 */
function mapCloudCategoryRowToLocal(row) {
  return {
    presets: normalizeCategoryPresetList(row.category_presets),
    updatedAt: normalizeISOText(row.updated_at),
  }
}

/**
 * 从云端拉取类别预设。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<{presets: Array<{id: string, name: string, aliases: string[]}>, updatedAt: string} | null>}
 * 云端记录或 null。
 */
async function pullCategoryPresetsFromCloud(userId) {
  if (!isCloudApiConfigured()) {
    return null
  }

  const normalizedUserId = normalizeOwnerKey(userId)
  if (!normalizedUserId || normalizedUserId === GUEST_OWNER_KEY) {
    return null
  }

  const response = await cloudApiRequest('/sync/category-presets')
  if (!response?.item) {
    return null
  }
  return mapCloudCategoryRowToLocal(response.item)
}

/**
 * 推送类别预设到云端。
 *
 * @param {string} userId 用户 ID。
 * @param {Array<{id: string, name: string, aliases: string[]}>} presets 类别预设。
 * @param {string} updatedAt 更新时间。
 * @returns {Promise<{presets: Array<{id: string, name: string, aliases: string[]}>, updatedAt: string}>}
 * 云端回写结果。
 */
async function pushCategoryPresetsToCloud(userId, presets, updatedAt) {
  if (!isCloudApiConfigured()) {
    throw new Error('云服务未配置，无法推送类别预设')
  }

  const normalizedUserId = normalizeOwnerKey(userId)
  if (!normalizedUserId || normalizedUserId === GUEST_OWNER_KEY) {
    throw new Error('未登录状态不可推送类别预设')
  }

  const nextUpdatedAt = normalizeISOText(updatedAt, new Date().toISOString())
  const response = await cloudApiRequest('/sync/category-presets', {
    method: 'PUT',
    body: {
      user_id: normalizedUserId,
      category_presets: normalizeCategoryPresetList(presets),
      updated_at: nextUpdatedAt,
    },
  })
  const data = response?.item

  if (!data) {
    return {
      presets: normalizeCategoryPresetList(presets),
      updatedAt: nextUpdatedAt,
    }
  }
  return mapCloudCategoryRowToLocal(data)
}

/**
 * 执行类别预设双向同步（LWW：最后更新时间优先）。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<{direction: 'pull' | 'push' | 'noop'}>} 同步方向。
 */
export async function syncCategoryPresetsForUser(userId) {
  const normalizedUserId = normalizeOwnerKey(userId)
  if (!isCloudApiConfigured() || normalizedUserId === GUEST_OWNER_KEY) {
    return { direction: 'noop' }
  }

  return runSingleFlight(`sync:category:${normalizedUserId}`, async () => {
    const localPresets = loadCategoryPresets(normalizedUserId)
    const localMeta = loadCategoryPresetsMeta(normalizedUserId)
    const remote = await pullCategoryPresetsFromCloud(normalizedUserId)
    const localUpdatedAtMs = getCategoryMetaUpdatedAtMs(localMeta)
    const remoteUpdatedAtMs = getCategoryMetaUpdatedAtMs(remote)

    if (!remote) {
      if (!localMeta.dirty) {
        return { direction: 'noop' }
      }
      const pushed = await pushCategoryPresetsToCloud(
        normalizedUserId,
        localPresets,
        localMeta.updatedAt || new Date().toISOString(),
      )
      saveCategoryPresets(pushed.presets, {
        markDirty: false,
        updatedAt: pushed.updatedAt,
        skipAutoSync: true,
        ownerKey: normalizedUserId,
      })
      return { direction: 'push' }
    }

    if (remoteUpdatedAtMs > localUpdatedAtMs) {
      saveCategoryPresets(remote.presets, {
        markDirty: false,
        updatedAt: remote.updatedAt || new Date().toISOString(),
        skipAutoSync: true,
        ownerKey: normalizedUserId,
      })
      return { direction: 'pull' }
    }

    if (localUpdatedAtMs > remoteUpdatedAtMs || localMeta.dirty) {
      const pushed = await pushCategoryPresetsToCloud(
        normalizedUserId,
        localPresets,
        localMeta.updatedAt || new Date().toISOString(),
      )
      saveCategoryPresets(pushed.presets, {
        markDirty: false,
        updatedAt: pushed.updatedAt || new Date().toISOString(),
        skipAutoSync: true,
        ownerKey: normalizedUserId,
      })
      return { direction: 'push' }
    }

    return { direction: 'noop' }
  })
}

/**
 * 构建用户维度 appMeta 键名。
 *
 * @param {string} prefix 键名前缀。
 * @param {string} userId 用户 ID。
 * @returns {string} 完整键名。
 */
function buildUserMetaKey(prefix, userId) {
  return `${prefix}${normalizeOwnerKey(userId)}`
}

/**
 * 解析账单拉取游标，兼容历史仅保存 ISO 时间字符串的格式。
 *
 * @param {unknown} rawValue appMeta 原始值。
 * @returns {{updatedAt: string, id: string}} 归一化后的游标。
 */
function parseLedgerPullCursor(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return {
      updatedAt: '',
      id: '',
    }
  }

  const legacyUpdatedAt = normalizeISOText(rawValue)
  if (legacyUpdatedAt) {
    return {
      updatedAt: legacyUpdatedAt,
      id: '',
    }
  }

  const parsed = safeParseJSON(rawValue)
  const updatedAt = normalizeISOText(parsed?.updatedAt)
  if (!updatedAt) {
    return {
      updatedAt: '',
      id: '',
    }
  }

  return {
    updatedAt,
    id: typeof parsed?.id === 'string' ? parsed.id.trim() : '',
  }
}

/**
 * 序列化账单拉取游标。
 *
 * @param {{updatedAt: string, id: string}} cursor 游标对象。
 * @returns {string} 序列化后的游标字符串；无效时返回空串。
 */
function serializeLedgerPullCursor(cursor) {
  const updatedAt = normalizeISOText(cursor?.updatedAt)
  if (!updatedAt) {
    return ''
  }
  const id = typeof cursor?.id === 'string' ? cursor.id.trim() : ''
  return JSON.stringify({
    updatedAt,
    id,
  })
}

/**
 * 根据重试次数计算下一次重试时间。
 *
 * @param {number} retryCount 当前重试次数（从 1 开始）。
 * @param {number} nowMs 当前时间戳（毫秒）。
 * @returns {string} 下一次重试的 ISO 时间。
 */
function buildNextRetryAt(retryCount, nowMs) {
  const delayIndex = Math.max(0, Math.min(retryCount - 1, LEDGER_SYNC_RETRY_DELAYS_MS.length - 1))
  const delayMs = LEDGER_SYNC_RETRY_DELAYS_MS[delayIndex]
  return new Date(nowMs + delayMs).toISOString()
}

/**
 * 判断失败账单是否已到可重试时间。
 *
 * @param {object} entry 账单对象。
 * @param {number} nowMs 当前时间戳（毫秒）。
 * @returns {boolean} 是否可重试。
 */
function canRetryFailedEntry(entry, nowMs) {
  if (entry.syncStatus !== 'failed') {
    return false
  }
  if (!entry.syncNextRetryAt) {
    return true
  }
  const nextRetryMs = new Date(entry.syncNextRetryAt).getTime()
  if (!Number.isFinite(nextRetryMs)) {
    return true
  }
  return nextRetryMs <= nowMs
}

/**
 * 将本地账单映射为云端行对象。
 *
 * @param {string} userId 用户 ID。
 * @param {object} entry 本地账单。
 * @returns {Record<string, any>} 云端行对象。
 */
function mapLocalLedgerEntryToCloudRow(userId, entry) {
  return {
    user_id: userId,
    id: entry.id,
    amount: entry.amount,
    currency: entry.currency,
    occurred_at: entry.occurredAt,
    location: entry.location,
    payment_method: entry.paymentMethod,
    merchant: entry.merchant,
    category: entry.category,
    note: entry.note,
    transaction_type: entry.transactionType,
    source_image_name: entry.sourceImageName,
    ai_provider: entry.aiProvider,
    ai_model: entry.aiModel,
    ai_confidence: entry.aiConfidence,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  }
}

/**
 * 将云端账单映射为本地账单对象。
 *
 * @param {string} userId 用户 ID。
 * @param {Record<string, any>} row 云端账单。
 * @returns {object | null} 本地账单对象。
 */
function mapCloudLedgerRowToLocalEntry(userId, row) {
  return normalizeLedgerEntry(
    {
      id: row.id,
      ownerKey: userId,
      amount: row.amount,
      currency: row.currency,
      occurredAt: row.occurred_at,
      location: row.location,
      paymentMethod: row.payment_method,
      merchant: row.merchant,
      category: row.category,
      note: row.note,
      transactionType: row.transaction_type,
      sourceImageName: row.source_image_name,
      aiProvider: row.ai_provider,
      aiModel: row.ai_model,
      aiConfidence: row.ai_confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      syncStatus: 'synced',
      syncRetryCount: 0,
      syncNextRetryAt: '',
    },
    0,
    {
      ownerKeyFallback: userId,
      forceSyncStatus: 'synced',
    },
  )
}

/**
 * 将账单数组切分为固定批次。
 *
 * @param {Array<object>} entries 账单列表。
 * @param {number} chunkSize 批次大小。
 * @returns {Array<Array<object>>} 分批结果。
 */
function chunkLedgerEntries(entries, chunkSize) {
  if (!entries.length) {
    return []
  }
  const chunks = []
  for (let index = 0; index < entries.length; index += chunkSize) {
    chunks.push(entries.slice(index, index + chunkSize))
  }
  return chunks
}

/**
 * 读取指定 owner 的全部本地账单（不保证排序）。
 *
 * @param {string} ownerKey ownerKey。
 * @returns {Promise<Array<object>>} 账单列表。
 */
async function listAllLocalLedgerEntriesByOwner(ownerKey) {
  const rawEntries = await listAllLedgerEntriesRaw()
  return rawEntries
    .map((entry) => normalizeLedgerEntry(entry, 0, { ownerKeyFallback: GUEST_OWNER_KEY }))
    .filter(Boolean)
    .filter((entry) => isEntryOwnedBy(entry, ownerKey))
}

/**
 * 首次登录时将访客账单迁移到当前登录用户。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<number>} 迁移条数。
 */
async function migrateGuestEntriesToUserIfNeeded(userId) {
  const normalizedUserId = normalizeOwnerKey(userId)
  if (!normalizedUserId || normalizedUserId === GUEST_OWNER_KEY) {
    return 0
  }

  const migratedMetaKey = buildUserMetaKey(LEDGER_GUEST_MIGRATED_META_PREFIX, normalizedUserId)
  const migratedMeta = await getAppMetaRecord(migratedMetaKey)
  if (migratedMeta?.value) {
    return 0
  }

  const guestEntries = await listAllLocalLedgerEntriesByOwner(GUEST_OWNER_KEY)
  if (guestEntries.length === 0) {
    await putAppMetaRecord({
      key: migratedMetaKey,
      value: new Date().toISOString(),
    })
    return 0
  }

  const nowISO = new Date().toISOString()
  const migratedEntries = guestEntries.map((entry) =>
    normalizeLedgerEntry(
      {
        ...entry,
        ownerKey: normalizedUserId,
        syncStatus: 'pending',
        syncRetryCount: 0,
        syncNextRetryAt: '',
        updatedAt: nowISO,
      },
      0,
      {
        ownerKeyFallback: normalizedUserId,
        forceSyncStatus: 'pending',
      },
    ),
  )
  await bulkUpsertLedgerEntries(migratedEntries.filter(Boolean))

  await putAppMetaRecord({
    key: migratedMetaKey,
    value: nowISO,
  })

  return migratedEntries.length
}

/**
 * 将待同步账单标记为失败并更新重试时间。
 *
 * @param {Array<object>} entries 待标记账单。
 * @returns {Promise<void>} 无返回值。
 */
async function markLedgerEntriesSyncFailed(entries) {
  if (!entries.length) {
    return
  }

  const nowMs = Date.now()
  const failedEntries = entries.map((entry) => {
    const nextRetryCount = normalizeNonNegativeInteger(entry.syncRetryCount) + 1
    return {
      ...entry,
      syncStatus: 'failed',
      syncRetryCount: nextRetryCount,
      syncNextRetryAt: buildNextRetryAt(nextRetryCount, nowMs),
      updatedAt: entry.updatedAt || new Date(nowMs).toISOString(),
    }
  })
  await bulkUpsertLedgerEntries(failedEntries)
}

/**
 * 推送本地待同步账单到云端。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<number>} 成功推送条数。
 */
async function pushPendingLedgerEntries(userId) {
  if (!isCloudApiConfigured()) {
    return 0
  }

  const nowMs = Date.now()
  const allEntries = await listAllLocalLedgerEntriesByOwner(userId)
  const candidates = allEntries
    .filter((entry) => entry.syncStatus === 'pending' || canRetryFailedEntry(entry, nowMs))
    .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())

  if (candidates.length === 0) {
    return 0
  }

  const chunks = chunkLedgerEntries(candidates, LEDGER_CLOUD_PUSH_BATCH_SIZE)
  let pushedCount = 0

  for (const chunk of chunks) {
    const rows = chunk.map((entry) => mapLocalLedgerEntryToCloudRow(userId, entry))
    let data = null
    try {
      const response = await cloudApiRequest('/sync/ledger/push', {
        method: 'POST',
        body: { entries: rows },
      })
      data = response?.items || []
    } catch (error) {
      await markLedgerEntriesSyncFailed(chunk)
      throw error
    }

    const updatedAtMap = new Map()
    for (const row of data || []) {
      if (row?.id) {
        updatedAtMap.set(String(row.id), normalizeISOText(row.updated_at || row.updatedAt))
      }
    }

    const syncedEntries = chunk.map((entry) => ({
      ...entry,
      syncStatus: 'synced',
      syncRetryCount: 0,
      syncNextRetryAt: '',
      updatedAt: updatedAtMap.get(entry.id) || entry.updatedAt,
    }))
    await bulkUpsertLedgerEntries(syncedEntries)
    pushedCount += chunk.length
  }

  return pushedCount
}

/**
 * 从云端拉取账单增量并落地到本地。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<number>} 拉取条数。
 */
async function pullLedgerEntriesFromCloud(userId) {
  if (!isCloudApiConfigured()) {
    return 0
  }

  const lastPullMetaKey = buildUserMetaKey(LEDGER_CLOUD_LAST_PULL_META_PREFIX, userId)
  const lastPullMeta = await getAppMetaRecord(lastPullMetaKey)
  const lastPullCursor = parseLedgerPullCursor(lastPullMeta?.value)

  const query = new URLSearchParams()
  query.set('limit', String(LEDGER_CLOUD_PULL_LIMIT))
  if (lastPullCursor.updatedAt) {
    query.set('updatedAfter', lastPullCursor.updatedAt)
    query.set('cursorId', lastPullCursor.id)
  }

  const response = await cloudApiRequest(`/sync/ledger/pull?${query.toString()}`)
  const data = Array.isArray(response?.items) ? response.items : []

  if (!Array.isArray(data) || data.length === 0) {
    return 0
  }

  const mappedEntries = data
    .map((row) => mapCloudLedgerRowToLocalEntry(userId, row))
    .filter(Boolean)
  if (mappedEntries.length > 0) {
    await bulkUpsertLedgerEntries(mappedEntries)
  }

  const lastRow = data[data.length - 1] || null
  const nextCursorRaw = serializeLedgerPullCursor({
    updatedAt: normalizeISOText(lastRow?.updated_at),
    id: typeof lastRow?.id === 'string' ? lastRow.id.trim() : '',
  })
  if (nextCursorRaw) {
    await putAppMetaRecord({
      key: lastPullMetaKey,
      value: nextCursorRaw,
    })
  }

  return mappedEntries.length
}

/**
 * 执行账单双向同步（先 push 后 pull）。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<{migrated: number, pushed: number, pulled: number}>} 同步结果。
 */
export async function syncLedgerEntriesForUser(userId) {
  const normalizedUserId = normalizeOwnerKey(userId)
  if (!isCloudApiConfigured() || normalizedUserId === GUEST_OWNER_KEY) {
    return { migrated: 0, pushed: 0, pulled: 0 }
  }

  return runSingleFlight(`sync:ledger:${normalizedUserId}`, async () => {
    await ensureLedgerStoreReady()

    const migrated = await migrateGuestEntriesToUserIfNeeded(normalizedUserId)
    const pushed = await pushPendingLedgerEntries(normalizedUserId)
    const pulled = await pullLedgerEntriesFromCloud(normalizedUserId)
    return {
      migrated,
      pushed,
      pulled,
    }
  })
}

/**
 * 执行用户全量云同步（AI 配置 + 类别预设 + 账单）。
 *
 * @param {string} userId 用户 ID。
 * @returns {Promise<{
 *   aiConfig: {direction: 'pull' | 'push' | 'noop'},
 *   categoryPresets: {direction: 'pull' | 'push' | 'noop'},
 *   ledger: {migrated: number, pushed: number, pulled: number}
 * }>} 同步汇总结果。
 */
export async function syncCloudDataForUser(userId) {
  const normalizedUserId = normalizeOwnerKey(userId)
  if (!isCloudApiConfigured() || normalizedUserId === GUEST_OWNER_KEY) {
    return {
      aiConfig: { direction: 'noop' },
      categoryPresets: { direction: 'noop' },
      ledger: { migrated: 0, pushed: 0, pulled: 0 },
    }
  }

  return runSingleFlight(`sync:all:${normalizedUserId}`, async () => {
    const aiConfig = await syncAIConfigNow(normalizedUserId)
    const categoryPresets = await syncCategoryPresetsForUser(normalizedUserId)
    const ledger = await syncLedgerEntriesForUser(normalizedUserId)
    return {
      aiConfig,
      categoryPresets,
      ledger,
    }
  })
}

/**
 * 测试辅助：重置账本初始化状态与同步上下文。
 *
 * @returns {void} 无返回值。
 */
export function __resetLedgerStoreReadyForTest() {
  ledgerStoreReadyPromise = null
  activeOwnerKey = GUEST_OWNER_KEY
  cloudSyncSingleFlightMap.clear()

  for (const timer of aiConfigSyncTimerMap.values()) {
    clearTimeout(timer)
  }
  aiConfigSyncTimerMap.clear()
  for (const timer of categorySyncTimerMap.values()) {
    clearTimeout(timer)
  }
  categorySyncTimerMap.clear()
  for (const timer of ledgerSyncTimerMap.values()) {
    clearTimeout(timer)
  }
  ledgerSyncTimerMap.clear()
}
