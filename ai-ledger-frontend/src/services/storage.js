import { cloudApiRequest, isCloudApiConfigured } from './cloudApiClient'

export const GUEST_OWNER_KEY = 'guest'
const SERVER_OWNER_KEY = 'server'
const DEFAULT_RECENT_LEDGER_LIMIT = 30
const LEDGER_CLOUD_PULL_LIMIT = 1000
const AI_CONFIG_CLOUD_BUNDLE_KEY = '__profile_bundle_v2'
const AI_CONFIG_CLOUD_BUNDLE_VERSION = 2

export const PROVIDER_DEFAULTS = {
  openai: { baseURL: 'https://api.openai.com/v1' },
  anthropic: { baseURL: 'https://api.anthropic.com/v1' },
}

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

let activeOwnerKey = SERVER_OWNER_KEY
let aiConfigCache = null
let categoryPresetsCache = null
let ledgerEntriesCache = []
let lastLedgerMutationMs = 0
const singleFlightMap = new Map()

function normalizeText(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback
  }
  const normalized = value.trim()
  return normalized || fallback
}

function createRuntimeId(prefix = 'id') {
  const safePrefix = normalizeText(prefix, 'id')
  const randomText = Math.random().toString(36).slice(2, 10)
  return `${safePrefix}-${Date.now()}-${randomText}`
}

function normalizeISO(value, fallback = '') {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return fallback
  }
  return parsed.toISOString()
}

function nextLedgerMutationISO() {
  const nowMs = Date.now()
  const nextMs = nowMs <= lastLedgerMutationMs ? lastLedgerMutationMs + 1 : nowMs
  lastLedgerMutationMs = nextMs
  return new Date(nextMs).toISOString()
}

function dedupeStringList(rawList) {
  if (!Array.isArray(rawList)) {
    return []
  }
  const set = new Set()
  const list = []
  for (const item of rawList) {
    const normalized = normalizeText(item)
    if (!normalized || set.has(normalized)) {
      continue
    }
    set.add(normalized)
    list.push(normalized)
  }
  return list
}

function cloneProviderModels(providerModels) {
  const source = providerModels && typeof providerModels === 'object' ? providerModels : {}
  const normalizeState = (rawState) => {
    const state = rawState && typeof rawState === 'object' ? rawState : {}
    const models = dedupeStringList(state.models)
    let currentModel = normalizeText(state.currentModel)
    if (!currentModel && models.length > 0) {
      currentModel = models[0]
    }
    if (currentModel && !models.includes(currentModel)) {
      models.unshift(currentModel)
    }
    return { currentModel, models }
  }
  return {
    openai: normalizeState(source.openai),
    anthropic: normalizeState(source.anthropic),
  }
}

function createDefaultProfile(profileId = 'ai-profile-default', profileName = '配置 1') {
  return {
    id: profileId,
    name: profileName,
    provider: 'openai',
    baseURL: PROVIDER_DEFAULTS.openai.baseURL,
    token: '',
    providerModels: cloneProviderModels({}),
  }
}

function normalizeProfile(rawProfile, index) {
  const source = rawProfile && typeof rawProfile === 'object' ? rawProfile : {}
  const provider = source.provider === 'anthropic' ? 'anthropic' : 'openai'
  return {
    id: normalizeText(source.id, `ai-profile-${index + 1}`),
    name: normalizeText(source.name, `配置 ${index + 1}`),
    provider,
    baseURL: normalizeText(source.baseURL, PROVIDER_DEFAULTS[provider].baseURL),
    token: typeof source.token === 'string' ? source.token : '',
    providerModels: cloneProviderModels(source.providerModels),
  }
}

function readCloudBundle(providerModels) {
  if (!providerModels || typeof providerModels !== 'object') {
    return null
  }
  const bundle = providerModels[AI_CONFIG_CLOUD_BUNDLE_KEY]
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.profiles)) {
    return null
  }
  return {
    activeProfileId: normalizeText(bundle.activeProfileId),
    profiles: bundle.profiles,
  }
}

function buildActiveSnapshot(profile) {
  const provider = profile.provider === 'anthropic' ? 'anthropic' : 'openai'
  return {
    provider,
    baseURL: normalizeText(profile.baseURL, PROVIDER_DEFAULTS[provider].baseURL),
    token: typeof profile.token === 'string' ? profile.token : '',
    providerModels: cloneProviderModels(profile.providerModels),
  }
}

function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const cloudBundle = readCloudBundle(source.providerModels)
  const rawProfiles = cloudBundle
    ? cloudBundle.profiles
    : Array.isArray(source.profiles)
      ? source.profiles
      : [source]

  const profiles = rawProfiles.map((profile, index) => normalizeProfile(profile, index)).filter((profile) => profile.name)
  if (profiles.length === 0) {
    profiles.push(createDefaultProfile())
  }

  const preferredActiveId = cloudBundle ? cloudBundle.activeProfileId : normalizeText(source.activeProfileId)
  const activeProfile = profiles.find((profile) => profile.id === preferredActiveId) || profiles[0]

  return {
    activeProfileId: activeProfile.id,
    profiles,
    ...buildActiveSnapshot(activeProfile),
    updatedAt: normalizeISO(source.updatedAt),
    dirty: Boolean(source.dirty),
  }
}

function cloneConfig(config) {
  return {
    activeProfileId: config.activeProfileId,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      providerModels: cloneProviderModels(profile.providerModels),
    })),
    provider: config.provider,
    baseURL: config.baseURL,
    token: config.token,
    providerModels: cloneProviderModels(config.providerModels),
    updatedAt: config.updatedAt,
    dirty: Boolean(config.dirty),
  }
}

export const DEFAULT_AI_CONFIG = normalizeConfig(createDefaultProfile())

function runSingleFlight(key, task) {
  if (singleFlightMap.has(key)) {
    return singleFlightMap.get(key)
  }
  const promise = task().finally(() => {
    singleFlightMap.delete(key)
  })
  singleFlightMap.set(key, promise)
  return promise
}

function ensureAiCache() {
  if (!aiConfigCache) {
    aiConfigCache = cloneConfig(DEFAULT_AI_CONFIG)
  }
}

function ensureCategoryCache() {
  if (!categoryPresetsCache) {
    categoryPresetsCache = DEFAULT_CATEGORY_PRESETS.map((preset) => ({ ...preset, aliases: [...preset.aliases] }))
  }
}

function normalizeCategoryPresetList(rawList) {
  if (!Array.isArray(rawList)) {
    ensureCategoryCache()
    return categoryPresetsCache.map((preset) => ({ ...preset, aliases: [...preset.aliases] }))
  }
  const seenNameSet = new Set()
  const seenIdSet = new Set()
  const list = []
  for (let index = 0; index < rawList.length; index += 1) {
    const source = rawList[index] && typeof rawList[index] === 'object' ? rawList[index] : {}
    const name = normalizeText(source.name)
    if (!name) {
      continue
    }
    const nameKey = name.toLowerCase()
    if (seenNameSet.has(nameKey)) {
      continue
    }
    seenNameSet.add(nameKey)
    let id = normalizeText(source.id, `cat-${index + 1}`)
    while (seenIdSet.has(id)) {
      id = `${id}-dup`
    }
    seenIdSet.add(id)
    list.push({
      id,
      name,
      aliases: dedupeStringList(source.aliases),
    })
  }
  if (list.length === 0) {
    ensureCategoryCache()
    return categoryPresetsCache.map((preset) => ({ ...preset, aliases: [...preset.aliases] }))
  }
  return list
}

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

function buildCloudProviderModelsPayload(config) {
  const providerModelsPayload = cloneProviderModels(config.providerModels)
  providerModelsPayload[AI_CONFIG_CLOUD_BUNDLE_KEY] = {
    version: AI_CONFIG_CLOUD_BUNDLE_VERSION,
    activeProfileId: config.activeProfileId,
    profiles: config.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      baseURL: profile.baseURL,
      token: profile.token,
      providerModels: cloneProviderModels(profile.providerModels),
    })),
  }
  return providerModelsPayload
}

function mapLocalAIConfigToCloudRow(config) {
  const nowISO = new Date().toISOString()
  return {
    provider: config.provider,
    base_url: config.baseURL,
    token: config.token,
    provider_models: buildCloudProviderModelsPayload(config),
    updated_at: normalizeISO(config.updatedAt, nowISO),
    created_at: nowISO,
  }
}

export function loadAIConfig() {
  ensureAiCache()
  return cloneConfig(aiConfigCache)
}

export async function pullAIConfig() {
  if (!isCloudApiConfigured()) {
    return null
  }
  const response = await cloudApiRequest('/sync/ai-config')
  return response?.item ? mapCloudAIConfigRowToLocal(response.item) : null
}

export async function pushAIConfig(_userId, config) {
  if (!isCloudApiConfigured()) {
    throw new Error('云服务未配置，无法推送 AI 配置')
  }
  const row = mapLocalAIConfigToCloudRow(normalizeConfig(config))
  const response = await cloudApiRequest('/sync/ai-config', {
    method: 'PUT',
    body: row,
  })
  return response?.item ? mapCloudAIConfigRowToLocal(response.item) : normalizeConfig({ ...config, updatedAt: row.updated_at, dirty: false })
}

/**
 * 保存 AI 配置到服务端，成功后更新内存态。
 *
 * @param {object} config 待保存配置。
 * @returns {Promise<ReturnType<typeof normalizeConfig>>} 服务端落库后的配置。
 */
export async function saveAIConfig(config) {
  const persisted = await pushAIConfig(activeOwnerKey, config)
  aiConfigCache = cloneConfig({ ...persisted, dirty: false })
  return loadAIConfig()
}

/**
 * 从服务端刷新 AI 配置到本地内存缓存。
 *
 * @returns {Promise<{direction: 'pull' | 'noop'}>} 刷新结果。
 */
export async function syncAIConfigNow(_userId) {
  if (!isCloudApiConfigured()) {
    return { direction: 'noop' }
  }
  return runSingleFlight('sync:ai', async () => {
    const remote = await pullAIConfig()
    if (!remote) {
      return { direction: 'noop' }
    }
    aiConfigCache = cloneConfig({ ...remote, dirty: false })
    return { direction: 'pull' }
  })
}

export function loadCategoryPresets() {
  ensureCategoryCache()
  return categoryPresetsCache.map((preset) => ({ ...preset, aliases: [...preset.aliases] }))
}

function mapCloudCategoryRowToLocal(row) {
  return {
    presets: normalizeCategoryPresetList(row.category_presets),
    updatedAt: normalizeISO(row.updated_at),
  }
}

async function pullCategoryPresetsFromCloud() {
  if (!isCloudApiConfigured()) {
    return null
  }
  const response = await cloudApiRequest('/sync/category-presets')
  return response?.item ? mapCloudCategoryRowToLocal(response.item) : null
}

async function pushCategoryPresetsToCloud(presets, updatedAt) {
  if (!isCloudApiConfigured()) {
    throw new Error('云服务未配置，无法推送类别预设')
  }
  const nextUpdatedAt = normalizeISO(updatedAt, new Date().toISOString())
  const response = await cloudApiRequest('/sync/category-presets', {
    method: 'PUT',
    body: {
      category_presets: normalizeCategoryPresetList(presets),
      updated_at: nextUpdatedAt,
    },
  })
  return response?.item
    ? mapCloudCategoryRowToLocal(response.item)
    : { presets: normalizeCategoryPresetList(presets), updatedAt: nextUpdatedAt }
}

/**
 * 保存类别预设到服务端，成功后更新内存态。
 *
 * @param {Array<{id?: string, name?: string, aliases?: string[]}>} categoryPresets 待保存预设。
 * @returns {Promise<Array<{id: string, name: string, aliases: string[]}>>} 服务端落库后的预设。
 */
export async function saveCategoryPresets(categoryPresets) {
  const pushed = await pushCategoryPresetsToCloud(normalizeCategoryPresetList(categoryPresets), new Date().toISOString())
  categoryPresetsCache = pushed.presets.map((preset) => ({ ...preset, aliases: [...preset.aliases] }))
  return loadCategoryPresets()
}

/**
 * 从服务端刷新类别预设到内存缓存。
 *
 * @returns {Promise<{direction: 'pull' | 'noop'}>} 刷新结果。
 */
export async function syncCategoryPresetsForUser(_userId) {
  if (!isCloudApiConfigured()) {
    return { direction: 'noop' }
  }
  return runSingleFlight('sync:category', async () => {
    const remote = await pullCategoryPresetsFromCloud()
    if (!remote) {
      return { direction: 'noop' }
    }
    categoryPresetsCache = remote.presets.map((preset) => ({ ...preset, aliases: [...preset.aliases] }))
    return { direction: 'pull' }
  })
}

function normalizeLedgerEntry(rawEntry = {}, index = 0) {
  const amount = Number(rawEntry.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }
  const nowISO = new Date().toISOString()
  const createdAt = normalizeISO(rawEntry.createdAt || rawEntry.created_at, nowISO)
  const updatedAt = normalizeISO(rawEntry.updatedAt || rawEntry.updated_at, createdAt)
  const isDeleted = rawEntry.isDeleted === true || rawEntry.is_deleted === true
  const deletedAtSource = rawEntry.deletedAt || rawEntry.deleted_at || updatedAt
  return {
    id: normalizeText(rawEntry.id, `ledger-${index + 1}`),
    amount: Math.round(amount * 100) / 100,
    currency: normalizeText(rawEntry.currency, 'CNY').toUpperCase(),
    occurredAt: normalizeISO(rawEntry.occurredAt || rawEntry.occurred_at, nowISO),
    location: normalizeText(rawEntry.location),
    paymentMethod: normalizeText(rawEntry.paymentMethod || rawEntry.payment_method),
    merchant: normalizeText(rawEntry.merchant),
    category: normalizeText(rawEntry.category, '其他'),
    note: normalizeText(rawEntry.note),
    transactionType: rawEntry.transactionType === 'income' || rawEntry.transaction_type === 'income' ? 'income' : 'expense',
    sourceImageName: normalizeText(rawEntry.sourceImageName || rawEntry.source_image_name),
    aiProvider: rawEntry.aiProvider === 'anthropic' || rawEntry.ai_provider === 'anthropic' ? 'anthropic' : 'openai',
    aiModel: normalizeText(rawEntry.aiModel || rawEntry.ai_model),
    aiConfidence:
      typeof (rawEntry.aiConfidence ?? rawEntry.ai_confidence) === 'number' &&
      Number.isFinite(rawEntry.aiConfidence ?? rawEntry.ai_confidence)
        ? rawEntry.aiConfidence ?? rawEntry.ai_confidence
        : null,
    createdAt,
    updatedAt,
    isDeleted,
    deletedAt: isDeleted ? normalizeISO(deletedAtSource, updatedAt) : '',
  }
}

function mapLocalLedgerEntryToCloudRow(entry) {
  const normalized = normalizeLedgerEntry(entry)
  if (!normalized) {
    throw new Error('账单格式不合法，无法提交到服务端')
  }
  return {
    id: normalized.id,
    amount: normalized.amount,
    currency: normalized.currency,
    occurred_at: normalized.occurredAt,
    location: normalized.location || null,
    payment_method: normalized.paymentMethod || null,
    merchant: normalized.merchant || null,
    category: normalized.category,
    note: normalized.note || null,
    transaction_type: normalized.transactionType,
    source_image_name: normalized.sourceImageName || null,
    ai_provider: normalized.aiProvider,
    ai_model: normalized.aiModel || null,
    ai_confidence: typeof normalized.aiConfidence === 'number' ? normalized.aiConfidence : null,
    is_deleted: normalized.isDeleted,
    deleted_at: normalized.isDeleted ? normalized.deletedAt || normalized.updatedAt : null,
    created_at: normalized.createdAt,
    updated_at: normalized.updatedAt,
  }
}

function mapCloudLedgerRowToLocalEntry(row) {
  return normalizeLedgerEntry(row)
}

function parseDateTextToDayRange(dateText) {
  const matched = typeof dateText === 'string' ? dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null
  if (!matched) {
    return null
  }
  const [, yearText, monthText, dayText] = matched
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1
  const day = Number(dayText)
  const start = new Date(year, monthIndex, day, 0, 0, 0, 0)
  if (Number.isNaN(start.getTime()) || start.getFullYear() !== year || start.getMonth() !== monthIndex || start.getDate() !== day) {
    return null
  }
  return {
    startISO: start.toISOString(),
    endISO: new Date(year, monthIndex, day + 1, 0, 0, 0, 0).toISOString(),
  }
}

function sortByOccurredAtDesc(entries) {
  return [...entries].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
}

async function fetchAllLedgerEntriesFromCloud() {
  if (!isCloudApiConfigured()) {
    return ledgerEntriesCache.map((entry) => ({ ...entry }))
  }

  const allEntries = []
  let cursorUpdatedAt = ''
  let cursorId = ''

  while (true) {
    const query = new URLSearchParams()
    query.set('limit', String(LEDGER_CLOUD_PULL_LIMIT))
    if (cursorUpdatedAt) {
      query.set('updatedAfter', cursorUpdatedAt)
      query.set('cursorId', cursorId)
    }

    const response = await cloudApiRequest(`/sync/ledger/pull?${query.toString()}`)
    const rows = Array.isArray(response?.items) ? response.items : []
    if (rows.length === 0) {
      break
    }

    allEntries.push(
      ...rows
        .map((row) => mapCloudLedgerRowToLocalEntry(row))
        .filter(Boolean),
    )

    if (rows.length < LEDGER_CLOUD_PULL_LIMIT) {
      break
    }

    const lastRow = rows[rows.length - 1]
    cursorUpdatedAt = normalizeISO(lastRow?.updated_at || lastRow?.updatedAt)
    cursorId = normalizeText(lastRow?.id)
    if (!cursorUpdatedAt || !cursorId) {
      break
    }
  }

  ledgerEntriesCache = allEntries.map((entry) => ({ ...entry }))
  return ledgerEntriesCache.map((entry) => ({ ...entry }))
}

async function pushLedgerEntries(entries) {
  if (!entries.length) {
    return
  }
  await cloudApiRequest('/sync/ledger/push', {
    method: 'POST',
    body: {
      entries: entries.map((entry) => mapLocalLedgerEntryToCloudRow(entry)),
    },
  })
}

async function findLedgerEntryById(entryId, options = {}) {
  const normalizedId = normalizeText(entryId)
  if (!normalizedId) {
    return null
  }
  const allEntries = await fetchAllLedgerEntriesFromCloud()
  const target = allEntries.find((entry) => entry.id === normalizedId)
  if (!target) {
    return null
  }
  if (options.includeDeleted !== true && target.isDeleted) {
    return null
  }
  return { ...target }
}

function normalizeRecentLimit(limit) {
  const parsed = Number(limit)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RECENT_LEDGER_LIMIT
  }
  return Math.floor(parsed)
}

export function ensureLedgerStoreReady() {
  return Promise.resolve()
}

export async function listAllLedgerEntries() {
  await ensureLedgerStoreReady()
  const visible = (await fetchAllLedgerEntriesFromCloud()).filter((entry) => !entry.isDeleted)
  return sortByOccurredAtDesc(visible)
}

export async function listRecentLedgerEntries(limit = DEFAULT_RECENT_LEDGER_LIMIT) {
  const entries = await listAllLedgerEntries()
  return entries.slice(0, normalizeRecentLimit(limit))
}

export async function listLedgerEntriesByDate(dateText) {
  const dayRange = parseDateTextToDayRange(dateText)
  if (!dayRange) {
    return []
  }
  const entries = await listAllLedgerEntries()
  const startMs = new Date(dayRange.startISO).getTime()
  const endMs = new Date(dayRange.endISO).getTime()
  return entries.filter((entry) => {
    const occurredAtMs = new Date(entry.occurredAt).getTime()
    return occurredAtMs >= startMs && occurredAtMs < endMs
  })
}

export async function appendLedgerEntry(entry) {
  const nowISO = nextLedgerMutationISO()
  const normalized = normalizeLedgerEntry({
    ...entry,
    id: normalizeText(entry?.id, createRuntimeId('ledger')),
    createdAt: normalizeISO(entry?.createdAt, nowISO),
    updatedAt: nowISO,
    isDeleted: false,
    deletedAt: '',
  })
  if (!normalized) {
    throw new Error('账单格式不合法，保存失败')
  }
  await pushLedgerEntries([normalized])
  return (await findLedgerEntryById(normalized.id, { includeDeleted: true })) || { ...normalized }
}

export async function updateLedgerEntry(entry) {
  const normalizedId = normalizeText(entry?.id)
  if (!normalizedId) {
    throw new Error('账单 ID 不能为空，无法编辑')
  }
  const existed = await findLedgerEntryById(normalizedId, { includeDeleted: true })
  if (!existed) {
    throw new Error('未找到可编辑的账单记录')
  }
  if (existed.isDeleted) {
    throw new Error('账单已删除，请先撤销删除后再编辑')
  }
  const normalized = normalizeLedgerEntry({
    ...existed,
    ...entry,
    id: normalizedId,
    createdAt: existed.createdAt,
    updatedAt: nextLedgerMutationISO(),
    isDeleted: false,
    deletedAt: '',
  })
  if (!normalized) {
    throw new Error('账单格式不合法，保存失败')
  }
  await pushLedgerEntries([normalized])
  return (await findLedgerEntryById(normalized.id, { includeDeleted: true })) || { ...normalized }
}

export async function deleteLedgerEntry(entryId) {
  const normalizedId = normalizeText(entryId)
  if (!normalizedId) {
    throw new Error('账单 ID 不能为空，无法删除')
  }
  const existed = await findLedgerEntryById(normalizedId, { includeDeleted: true })
  if (!existed) {
    throw new Error('未找到可删除的账单记录')
  }
  if (existed.isDeleted) {
    return existed
  }
  const nowISO = nextLedgerMutationISO()
  const normalized = normalizeLedgerEntry({
    ...existed,
    isDeleted: true,
    deletedAt: nowISO,
    updatedAt: nowISO,
  })
  if (!normalized) {
    throw new Error('账单格式不合法，删除失败')
  }
  await pushLedgerEntries([normalized])
  return (await findLedgerEntryById(normalized.id, { includeDeleted: true })) || { ...normalized }
}

export async function restoreLedgerEntry(entryId) {
  const normalizedId = normalizeText(entryId)
  if (!normalizedId) {
    throw new Error('账单 ID 不能为空，无法撤销删除')
  }
  const existed = await findLedgerEntryById(normalizedId, { includeDeleted: true })
  if (!existed) {
    throw new Error('未找到可恢复的账单记录')
  }
  if (!existed.isDeleted) {
    return existed
  }
  const normalized = normalizeLedgerEntry({
    ...existed,
    isDeleted: false,
    deletedAt: '',
    updatedAt: nextLedgerMutationISO(),
  })
  if (!normalized) {
    throw new Error('账单格式不合法，恢复失败')
  }
  await pushLedgerEntries([normalized])
  return (await findLedgerEntryById(normalized.id, { includeDeleted: true })) || { ...normalized }
}

export function setStorageOwnerKey(ownerKey) {
  activeOwnerKey = normalizeText(ownerKey, SERVER_OWNER_KEY)
  return activeOwnerKey
}

export function getStorageOwnerKey() {
  return activeOwnerKey
}

export async function syncLedgerEntriesForUser(_userId) {
  if (!isCloudApiConfigured()) {
    return { migrated: 0, pushed: 0, pulled: 0 }
  }
  return runSingleFlight('sync:ledger', async () => {
    const entries = await fetchAllLedgerEntriesFromCloud()
    return { migrated: 0, pushed: 0, pulled: entries.length }
  })
}

export async function syncCloudDataForUser(userId) {
  if (!isCloudApiConfigured()) {
    return {
      aiConfig: { direction: 'noop' },
      categoryPresets: { direction: 'noop' },
      ledger: { migrated: 0, pushed: 0, pulled: 0 },
    }
  }
  return runSingleFlight('sync:all', async () => {
    const aiConfig = await syncAIConfigNow(userId)
    const categoryPresets = await syncCategoryPresetsForUser(userId)
    const ledger = await syncLedgerEntriesForUser(userId)
    return { aiConfig, categoryPresets, ledger }
  })
}

export function __resetLedgerStoreReadyForTest() {
  activeOwnerKey = SERVER_OWNER_KEY
  aiConfigCache = cloneConfig(DEFAULT_AI_CONFIG)
  categoryPresetsCache = DEFAULT_CATEGORY_PRESETS.map((preset) => ({ ...preset, aliases: [...preset.aliases] }))
  ledgerEntriesCache = []
  singleFlightMap.clear()
}

__resetLedgerStoreReadyForTest()

