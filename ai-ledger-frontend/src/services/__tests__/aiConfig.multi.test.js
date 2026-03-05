import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLedgerStoreReadyForTest,
  loadAIConfig,
  saveAIConfig,
  syncAIConfigNow,
} from '../storage'

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

beforeEach(() => {
  Object.defineProperty(globalThis, 'fetch', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  })
  __resetLedgerStoreReadyForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AI 配置（服务端单一数据源）', () => {
  it('保存多配置后应以服务端回写结果更新本地内存态', async () => {
    const serverUpdatedAt = '2026-03-05T10:00:00.000Z'

    globalThis.fetch.mockImplementation(async (_url, requestOptions = {}) => {
      const method = requestOptions.method || 'GET'
      if (method !== 'PUT') {
        return createJsonResponse({ item: null })
      }

      const body = JSON.parse(requestOptions.body)
      return createJsonResponse({
        item: {
          user_id: '11111111-1111-1111-1111-111111111111',
          provider: body.provider,
          base_url: body.base_url,
          token: body.token,
          provider_models: body.provider_models,
          created_at: body.created_at,
          updated_at: serverUpdatedAt,
        },
      })
    })

    const saved = await saveAIConfig({
      activeProfileId: 'profile-2',
      profiles: [
        {
          id: 'profile-1',
          name: '工作账号',
          provider: 'openai',
          baseURL: 'https://work.example.com/v1',
          token: 'work-token',
          providerModels: {
            openai: { currentModel: 'gpt-4o', models: ['gpt-4o'] },
            anthropic: { currentModel: '', models: [] },
          },
        },
        {
          id: 'profile-2',
          name: '备用账号',
          provider: 'anthropic',
          baseURL: 'https://anthropic.example.com/v1',
          token: 'anthropic-token',
          providerModels: {
            openai: { currentModel: '', models: [] },
            anthropic: { currentModel: 'claude-3-7-sonnet', models: ['claude-3-7-sonnet'] },
          },
        },
      ],
    })

    const loaded = loadAIConfig()

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(saved.activeProfileId).toBe('profile-2')
    expect(saved.provider).toBe('anthropic')
    expect(saved.updatedAt).toBe(serverUpdatedAt)
    expect(loaded.activeProfileId).toBe('profile-2')
    expect(loaded.provider).toBe('anthropic')
  })

  it('syncAIConfigNow 应直接回灌服务端配置', async () => {
    globalThis.fetch.mockImplementation(async (_url, requestOptions = {}) => {
      const method = requestOptions.method || 'GET'
      if (method === 'GET') {
        return createJsonResponse({
          item: {
            user_id: '11111111-1111-1111-1111-111111111111',
            provider: 'openai',
            base_url: 'https://remote.example.com/v1',
            token: 'remote-token',
            provider_models: {
              openai: { currentModel: 'remote-model', models: ['remote-model'] },
              anthropic: { currentModel: '', models: [] },
            },
            created_at: '2026-03-05T09:00:00.000Z',
            updated_at: '2026-03-05T09:00:00.000Z',
          },
        })
      }
      return createJsonResponse({ item: null })
    })

    const result = await syncAIConfigNow('any-user')
    const loaded = loadAIConfig()

    expect(result.direction).toBe('pull')
    expect(loaded.baseURL).toBe('https://remote.example.com/v1')
    expect(loaded.token).toBe('remote-token')
    expect(loaded.providerModels.openai.currentModel).toBe('remote-model')
  })
})
