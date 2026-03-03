const AI_CONFIG_STORAGE_KEY = 'ai_accounting_config_v1'
const LEDGER_STORAGE_KEY = 'ai_accounting_ledger_entries_v1'
const CATEGORY_PRESETS_STORAGE_KEY = 'ai_accounting_category_presets_v1'

export const PROVIDER_DEFAULTS = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
  },
}

const PROVIDERS = ['openai', 'anthropic']

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

function safeParseJSON(rawText) {
  try {
    return JSON.parse(rawText)
  } catch {
    return null
  }
}

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

export const DEFAULT_AI_CONFIG = {
  provider: 'openai',
  baseURL: PROVIDER_DEFAULTS.openai.baseURL,
  token: '',
  providerModels: createEmptyProviderModels(),
}

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

function normalizeTextField(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback
  }
  const normalized = value.trim()
  return normalized || fallback
}

function normalizeCurrency(value) {
  const normalized = normalizeTextField(value).toUpperCase()
  return normalized || 'CNY'
}

function normalizeTransactionType(value) {
  return value === 'income' ? 'income' : 'expense'
}

function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (value < 0 || value > 1) {
    return null
  }
  return value
}

function normalizeISODate(value, fallbackISO) {
  const parsedDate = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) {
    return fallbackISO
  }
  return parsedDate.toISOString()
}

function createRuntimeId(prefix) {
  // 优先使用浏览器原生 UUID，保证前端离线场景下也有稳定唯一标识。
  const uuidFactory = globalThis.crypto?.randomUUID
  if (typeof uuidFactory === 'function') {
    return `${prefix}-${uuidFactory.call(globalThis.crypto)}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

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

function cloneCategoryPresets(categoryPresets) {
  return categoryPresets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    aliases: [...preset.aliases],
  }))
}

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

export function saveCategoryPresets(categoryPresets) {
  const normalized = normalizeCategoryPresetList(categoryPresets)
  try {
    localStorage.setItem(CATEGORY_PRESETS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    throw new Error('类别预设保存失败，请检查浏览器存储权限后重试')
  }
  return cloneCategoryPresets(normalized)
}

function normalizeLedgerEntry(rawEntry = {}, index = 0) {
  const amount = Number(rawEntry.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
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

function cloneLedgerEntries(entries) {
  return entries.map((entry) => ({ ...entry }))
}

export function loadLedgerEntries() {
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

export function saveLedgerEntries(entries) {
  const normalized = normalizeLedgerEntryList(entries)
  try {
    localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    throw new Error('账单保存失败，请检查浏览器存储权限后重试')
  }
  return cloneLedgerEntries(normalized)
}

export function appendLedgerEntry(entry) {
  const existing = loadLedgerEntries()
  const normalizedEntry = normalizeLedgerEntry({
    ...entry,
    id: normalizeTextField(entry?.id, createRuntimeId('ledger')),
  })

  if (!normalizedEntry) {
    throw new Error('账单格式不合法，保存失败')
  }

  const nextEntries = [...existing, normalizedEntry]
  return saveLedgerEntries(nextEntries)
}
