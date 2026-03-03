const STORAGE_KEY = 'ai_accounting_config_v1'

export const PROVIDER_DEFAULTS = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
  },
}

export const DEFAULT_AI_CONFIG = {
  provider: 'openai',
  baseURL: PROVIDER_DEFAULTS.openai.baseURL,
  token: '',
  model: '',
  modelSource: 'manual',
}

function normalizeConfig(raw = {}) {
  const provider = raw.provider === 'anthropic' ? 'anthropic' : 'openai'
  const baseURL =
    typeof raw.baseURL === 'string' && raw.baseURL.trim()
      ? raw.baseURL.trim()
      : PROVIDER_DEFAULTS[provider].baseURL
  const token = typeof raw.token === 'string' ? raw.token : ''
  const model = typeof raw.model === 'string' ? raw.model : ''
  const modelSource = raw.modelSource === 'list' ? 'list' : 'manual'

  return {
    provider,
    baseURL,
    token,
    model,
    modelSource,
  }
}

export function loadAIConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_AI_CONFIG }
    }

    return normalizeConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

export function saveAIConfig(config) {
  const normalized = normalizeConfig(config)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    throw new Error('配置保存失败，请检查浏览器存储权限或清理存储空间后重试')
  }
  return normalized
}
