import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLedgerStoreReadyForTest,
  loadCategoryPresets,
  saveCategoryPresets,
  syncCategoryPresetsForUser,
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

describe('类别预设（服务端单一数据源）', () => {
  it('saveCategoryPresets 应以服务端回写结果为准', async () => {
    globalThis.fetch.mockImplementation(async (_url, requestOptions = {}) => {
      const method = requestOptions.method || 'GET'
      if (method !== 'PUT') {
        return createJsonResponse({ item: null })
      }

      const body = JSON.parse(requestOptions.body)
      return createJsonResponse({
        item: {
          user_id: '11111111-1111-1111-1111-111111111111',
          category_presets: body.category_presets,
          created_at: '2026-03-05T10:00:00.000Z',
          updated_at: '2026-03-05T10:00:00.000Z',
        },
      })
    })

    const saved = await saveCategoryPresets([
      { id: 'cat-custom', name: '自定义', aliases: ['别名1', '别名2'] },
    ])
    const loaded = loadCategoryPresets()

    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('自定义')
    expect(loaded[0].name).toBe('自定义')
  })

  it('syncCategoryPresetsForUser 应回灌服务端预设', async () => {
    globalThis.fetch.mockImplementation(async (_url, requestOptions = {}) => {
      const method = requestOptions.method || 'GET'
      if (method === 'GET') {
        return createJsonResponse({
          item: {
            user_id: '11111111-1111-1111-1111-111111111111',
            category_presets: [
              { id: 'cat-remote', name: '远端类别', aliases: ['远端别名'] },
            ],
            created_at: '2026-03-05T09:00:00.000Z',
            updated_at: '2026-03-05T09:00:00.000Z',
          },
        })
      }
      return createJsonResponse({ item: null })
    })

    const result = await syncCategoryPresetsForUser('any-user')
    const loaded = loadCategoryPresets()

    expect(result.direction).toBe('pull')
    expect(loaded).toHaveLength(1)
    expect(loaded[0].name).toBe('远端类别')
  })
})
