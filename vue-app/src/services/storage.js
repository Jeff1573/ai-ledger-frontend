const STORAGE_KEY = 'ai_accounting_config_v1'

export const PROVIDER_DEFAULTS = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
  },
}

const PROVIDERS = ['openai', 'anthropic']

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
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {
        ...DEFAULT_AI_CONFIG,
        providerModels: cloneProviderModels(DEFAULT_AI_CONFIG.providerModels),
      }
    }

    return normalizeConfig(JSON.parse(raw))
  } catch {
    return {
      ...DEFAULT_AI_CONFIG,
      providerModels: cloneProviderModels(DEFAULT_AI_CONFIG.providerModels),
    }
  }
}

export function saveAIConfig(config) {
  const normalized = normalizeConfig(config)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    throw new Error('配置保存失败，请检查浏览器存储权限或清理存储空间后重试')
  }
  return {
    ...normalized,
    providerModels: cloneProviderModels(normalized.providerModels),
  }
}
