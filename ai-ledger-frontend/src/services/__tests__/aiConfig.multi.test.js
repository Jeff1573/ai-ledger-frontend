import { beforeEach, describe, expect, it } from 'vitest'
import {
  GUEST_OWNER_KEY,
  __resetLedgerStoreReadyForTest,
  loadAIConfig,
  saveAIConfig,
  setStorageOwnerKey,
} from '../storage'

// AI 配置历史 localStorage 键名。
const AI_CONFIG_STORAGE_KEY = 'ai_accounting_config_v1'

/**
 * 创建最小 localStorage mock，满足 AI 配置测试读写需求。
 *
 * @returns {{getItem: Function, setItem: Function, removeItem: Function, clear: Function}}
 */
function createLocalStorageMock() {
  const storage = new Map()
  return {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
    clear() {
      storage.clear()
    },
  }
}

/**
 * 构造 providerModels 测试夹具。
 *
 * @param {{openai?: string, anthropic?: string}} [currentModelMap={}] 当前模型映射。
 * @returns {{
 *   openai: {currentModel: string, models: string[]},
 *   anthropic: {currentModel: string, models: string[]}
 * }} providerModels 对象。
 */
function buildProviderModels(currentModelMap = {}) {
  const openaiModel = currentModelMap.openai || ''
  const anthropicModel = currentModelMap.anthropic || ''
  return {
    openai: {
      currentModel: openaiModel,
      models: openaiModel ? [openaiModel] : [],
    },
    anthropic: {
      currentModel: anthropicModel,
      models: anthropicModel ? [anthropicModel] : [],
    },
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createLocalStorageMock(),
    configurable: true,
    writable: true,
  })
  __resetLedgerStoreReadyForTest()
  setStorageOwnerKey(GUEST_OWNER_KEY)
})

describe('AI 配置多配置能力', () => {
  it('应兼容旧单配置结构并自动迁移为单配置列表', () => {
    localStorage.setItem(
      AI_CONFIG_STORAGE_KEY,
      JSON.stringify({
        provider: 'openai',
        baseURL: 'https://api.openai.com/v1',
        token: 'legacy-token',
        providerModels: buildProviderModels({ openai: 'gpt-4o-mini' }),
        updatedAt: '2026-03-03T08:00:00.000Z',
        dirty: true,
      }),
    )

    const config = loadAIConfig()
    expect(config.profiles).toHaveLength(1)
    expect(config.activeProfileId).toBe(config.profiles[0].id)
    expect(config.provider).toBe('openai')
    expect(config.token).toBe('legacy-token')
    expect(config.providerModels.openai.currentModel).toBe('gpt-4o-mini')
    expect(config.dirty).toBe(true)
  })

  it('应支持保存多个配置并使用 activeProfileId 生成激活快照', () => {
    const saved = saveAIConfig({
      activeProfileId: 'profile-b',
      profiles: [
        {
          id: 'profile-a',
          name: '工作账号',
          provider: 'openai',
          baseURL: 'https://api.openai.com/v1',
          token: 'token-a',
          providerModels: buildProviderModels({ openai: 'gpt-4.1-mini' }),
        },
        {
          id: 'profile-b',
          name: '备用账号',
          provider: 'anthropic',
          baseURL: 'https://api.anthropic.com/v1',
          token: 'token-b',
          providerModels: buildProviderModels({ anthropic: 'claude-3-5-haiku-latest' }),
        },
      ],
    })

    expect(saved.profiles).toHaveLength(2)
    expect(saved.activeProfileId).toBe('profile-b')
    expect(saved.provider).toBe('anthropic')
    expect(saved.baseURL).toBe('https://api.anthropic.com/v1')
    expect(saved.token).toBe('token-b')
    expect(saved.providerModels.anthropic.currentModel).toBe('claude-3-5-haiku-latest')

    const loaded = loadAIConfig()
    expect(loaded.profiles).toHaveLength(2)
    expect(loaded.activeProfileId).toBe('profile-b')
    expect(loaded.provider).toBe('anthropic')
    expect(loaded.token).toBe('token-b')
  })

  it('多配置结构应按 owner 作用域隔离', () => {
    setStorageOwnerKey('user-a')
    saveAIConfig({
      activeProfileId: 'user-a-main',
      profiles: [
        {
          id: 'user-a-main',
          name: 'A 主配置',
          provider: 'openai',
          baseURL: 'https://api.openai.com/v1',
          token: 'token-a',
          providerModels: buildProviderModels({ openai: 'gpt-a' }),
        },
      ],
    })

    setStorageOwnerKey('user-b')
    saveAIConfig({
      activeProfileId: 'user-b-main',
      profiles: [
        {
          id: 'user-b-main',
          name: 'B 主配置',
          provider: 'openai',
          baseURL: 'https://api.openai.com/v1',
          token: 'token-b',
          providerModels: buildProviderModels({ openai: 'gpt-b' }),
        },
      ],
    })

    const userBConfig = loadAIConfig()
    expect(userBConfig.token).toBe('token-b')
    expect(userBConfig.profiles.map((item) => item.name)).toEqual(['B 主配置'])

    const userAConfig = loadAIConfig('user-a')
    expect(userAConfig.token).toBe('token-a')
    expect(userAConfig.profiles.map((item) => item.name)).toEqual(['A 主配置'])
  })
})
