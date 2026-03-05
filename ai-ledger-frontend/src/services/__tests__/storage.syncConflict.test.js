import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLedgerStoreReadyForTest,
  GUEST_OWNER_KEY,
  loadAIConfig,
  loadCategoryPresets,
  saveAIConfig,
  saveCategoryPresets,
  setStorageOwnerKey,
  syncAIConfigNow,
  syncCategoryPresetsForUser,
} from '../storage'
import { clearLedgerDbForTest } from '../ledgerDb'

/**
 * 创建支持 key/length 的 localStorage mock。
 *
 * @returns {{
 *   getItem: (key: string) => string | null,
 *   setItem: (key: string, value: string) => void,
 *   removeItem: (key: string) => void,
 *   clear: () => void,
 *   key: (index: number) => string | null,
 *   readonly length: number
 * }} localStorage mock。
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
    key(index) {
      const keys = [...storage.keys()]
      return keys[index] || null
    },
    get length() {
      return storage.size
    },
  }
}

/**
 * 构造 fetch JSON 响应对象。
 *
 * @param {any} payload JSON 载荷。
 * @param {number} [status=200] 响应状态码。
 * @returns {{ok: boolean, status: number, headers: {get: (name: string) => string}, json: () => Promise<any>, text: () => Promise<string>}}
 * 伪响应对象。
 */
function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : ''
      },
    },
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
  }
}

/**
 * 构造最小可用 AI 配置对象。
 *
 * @param {{baseURL: string, token: string, model: string}} options 配置项。
 * @returns {{
 *   provider: 'openai',
 *   baseURL: string,
 *   token: string,
 *   providerModels: {
 *     openai: {currentModel: string, models: string[]},
 *     anthropic: {currentModel: string, models: string[]}
 *   }
 * }} AI 配置对象。
 */
function buildAIConfigFixture(options) {
  const { baseURL, token, model } = options
  return {
    provider: 'openai',
    baseURL,
    token,
    providerModels: {
      openai: { currentModel: model, models: [model] },
      anthropic: { currentModel: '', models: [] },
    },
  }
}

beforeEach(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createLocalStorageMock(),
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'fetch', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  })
  await clearLedgerDbForTest()
  __resetLedgerStoreReadyForTest()
  setStorageOwnerKey(GUEST_OWNER_KEY)
})

afterEach(async () => {
  await clearLedgerDbForTest()
  __resetLedgerStoreReadyForTest()
  vi.restoreAllMocks()
})

describe('AI 配置登录同步账户隔离', () => {
  it('fullSync 仅应使用 guest 与当前账号配置，不应吸收其他账号最新配置', async () => {
    saveAIConfig(buildAIConfigFixture({
      baseURL: 'https://guest.example.com/v1',
      token: 'guest-token',
      model: 'guest-model',
    }), {
      ownerKey: GUEST_OWNER_KEY,
      updatedAt: '2026-03-05T09:30:00.000Z',
      markDirty: true,
      skipAutoSync: true,
    })
    saveAIConfig(buildAIConfigFixture({
      baseURL: 'https://user-a.example.com/v1',
      token: 'user-a-token',
      model: 'user-a-model',
    }), {
      ownerKey: 'user-a',
      updatedAt: '2026-03-05T09:00:00.000Z',
      markDirty: true,
      skipAutoSync: true,
    })
    saveAIConfig(buildAIConfigFixture({
      baseURL: 'https://user-b.example.com/v1',
      token: 'user-b-token',
      model: 'user-b-model',
    }), {
      ownerKey: 'user-b',
      updatedAt: '2026-03-05T10:00:00.000Z',
      markDirty: true,
      skipAutoSync: true,
    })

    globalThis.fetch.mockImplementation(async (_url, requestOptions = {}) => {
      const method = requestOptions.method || 'GET'
      if (method === 'GET') {
        return createJsonResponse({ item: null })
      }
      if (method === 'PUT') {
        const body = JSON.parse(requestOptions.body)
        return createJsonResponse({
          item: {
            user_id: 'user-a',
            provider: body.provider,
            base_url: body.base_url,
            token: body.token,
            provider_models: body.provider_models,
            created_at: body.created_at,
            updated_at: body.updated_at,
          },
        })
      }
      return createJsonResponse({ message: 'unexpected method' }, 500)
    })

    const result = await syncAIConfigNow('user-a', { fullSync: true })
    const pushPayload = JSON.parse(globalThis.fetch.mock.calls[1][1].body)
    const syncedConfig = loadAIConfig('user-a')

    expect(result.direction).toBe('push')
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(pushPayload.token).toBe('guest-token')
    expect(pushPayload.token).not.toBe('user-b-token')
    expect(syncedConfig.token).toBe('guest-token')
    expect(syncedConfig.dirty).toBe(false)
  })

  it('fullSync 同时间戳平局时应优先当前账号配置', async () => {
    const updatedAt = '2026-03-05T09:30:00.000Z'
    saveAIConfig(buildAIConfigFixture({
      baseURL: 'https://guest.example.com/v1',
      token: 'guest-token',
      model: 'guest-model',
    }), {
      ownerKey: GUEST_OWNER_KEY,
      updatedAt,
      markDirty: true,
      skipAutoSync: true,
    })
    saveAIConfig(buildAIConfigFixture({
      baseURL: 'https://user-a.example.com/v1',
      token: 'user-a-token',
      model: 'user-a-model',
    }), {
      ownerKey: 'user-a',
      updatedAt,
      markDirty: true,
      skipAutoSync: true,
    })

    globalThis.fetch.mockImplementation(async (_url, requestOptions = {}) => {
      const method = requestOptions.method || 'GET'
      if (method === 'GET') {
        return createJsonResponse({ item: null })
      }
      if (method === 'PUT') {
        const body = JSON.parse(requestOptions.body)
        return createJsonResponse({
          item: {
            user_id: 'user-a',
            provider: body.provider,
            base_url: body.base_url,
            token: body.token,
            provider_models: body.provider_models,
            created_at: body.created_at,
            updated_at: body.updated_at,
          },
        })
      }
      return createJsonResponse({ message: 'unexpected method' }, 500)
    })

    const result = await syncAIConfigNow('user-a', { fullSync: true })
    const pushPayload = JSON.parse(globalThis.fetch.mock.calls[1][1].body)
    const syncedConfig = loadAIConfig('user-a')

    expect(result.direction).toBe('push')
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(pushPayload.token).toBe('user-a-token')
    expect(pushPayload.token).not.toBe('guest-token')
    expect(syncedConfig.token).toBe('user-a-token')
    expect(syncedConfig.dirty).toBe(false)
  })

  it('fullSync 应支持将 guest 配置迁移并同步到当前账号', async () => {
    saveAIConfig(buildAIConfigFixture({
      baseURL: 'https://guest.example.com/v1',
      token: 'guest-token',
      model: 'guest-model',
    }), {
      ownerKey: GUEST_OWNER_KEY,
      updatedAt: '2026-03-05T09:30:00.000Z',
      markDirty: true,
      skipAutoSync: true,
    })

    globalThis.fetch.mockImplementation(async (_url, requestOptions = {}) => {
      const method = requestOptions.method || 'GET'
      if (method === 'GET') {
        return createJsonResponse({ item: null })
      }
      if (method === 'PUT') {
        const body = JSON.parse(requestOptions.body)
        return createJsonResponse({
          item: {
            user_id: 'user-a',
            provider: body.provider,
            base_url: body.base_url,
            token: body.token,
            provider_models: body.provider_models,
            created_at: body.created_at,
            updated_at: body.updated_at,
          },
        })
      }
      return createJsonResponse({ message: 'unexpected method' }, 500)
    })

    const result = await syncAIConfigNow('user-a', { fullSync: true })
    const syncedConfig = loadAIConfig('user-a')

    expect(result.direction).toBe('push')
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(syncedConfig.baseURL).toBe('https://guest.example.com/v1')
    expect(syncedConfig.token).toBe('guest-token')
    expect(syncedConfig.providerModels.openai.currentModel).toBe('guest-model')
    expect(syncedConfig.dirty).toBe(false)
  })
})

describe('同步冲突规则（时间相同远端优先）', () => {
  it('AI 配置同时间戳冲突时应回灌远端配置', async () => {
    const updatedAt = '2026-03-05T10:00:00.000Z'
    setStorageOwnerKey('user-a')
    saveAIConfig(
      {
        provider: 'openai',
        baseURL: 'https://local.example.com/v1',
        token: 'local-token',
        providerModels: {
          openai: { currentModel: 'local-model', models: ['local-model'] },
          anthropic: { currentModel: '', models: [] },
        },
      },
      {
        ownerKey: 'user-a',
        updatedAt,
        markDirty: true,
        skipAutoSync: true,
      },
    )

    globalThis.fetch.mockResolvedValueOnce(
      createJsonResponse({
        item: {
          user_id: 'user-a',
          provider: 'openai',
          base_url: 'https://remote.example.com/v1',
          token: 'remote-token',
          provider_models: {
            openai: { currentModel: 'remote-model', models: ['remote-model'] },
            anthropic: { currentModel: '', models: [] },
          },
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      }),
    )

    const result = await syncAIConfigNow('user-a')
    const syncedConfig = loadAIConfig('user-a')

    expect(result.direction).toBe('pull')
    expect(syncedConfig.baseURL).toBe('https://remote.example.com/v1')
    expect(syncedConfig.token).toBe('remote-token')
    expect(syncedConfig.providerModels.openai.currentModel).toBe('remote-model')
    expect(syncedConfig.dirty).toBe(false)
  })

  it('类别预设同时间戳冲突时应回灌远端预设', async () => {
    const updatedAt = '2026-03-05T11:00:00.000Z'
    setStorageOwnerKey('user-b')
    saveCategoryPresets(
      [{ id: 'local-1', name: '本地类', aliases: ['本地'] }],
      {
        ownerKey: 'user-b',
        updatedAt,
        markDirty: true,
        skipAutoSync: true,
      },
    )

    globalThis.fetch.mockResolvedValueOnce(
      createJsonResponse({
        item: {
          user_id: 'user-b',
          category_presets: [{ id: 'remote-1', name: '远端类', aliases: ['远端'] }],
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      }),
    )

    const result = await syncCategoryPresetsForUser('user-b')
    const presets = loadCategoryPresets('user-b')

    expect(result.direction).toBe('pull')
    expect(presets.map((item) => item.name)).toEqual(['远端类'])
  })
})

