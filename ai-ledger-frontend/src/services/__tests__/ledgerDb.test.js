import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLedgerStoreReadyForTest,
  appendLedgerEntry,
  deleteLedgerEntry,
  ensureLedgerStoreReady,
  listAllLedgerEntries,
  listLedgerEntriesByDate,
  listRecentLedgerEntries,
  restoreLedgerEntry,
  updateLedgerEntry,
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

function compareLedgerRowsByCursor(a, b) {
  if (a.updated_at === b.updated_at) {
    return String(a.id).localeCompare(String(b.id))
  }
  return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
}

function createLedgerRow({ id, amount, occurredAt, updatedAt, isDeleted = false }) {
  return {
    id,
    amount,
    currency: 'CNY',
    occurred_at: occurredAt,
    location: '',
    payment_method: '支付宝',
    merchant: '测试商户',
    category: '餐饮',
    note: '',
    transaction_type: 'expense',
    source_image_name: '',
    ai_provider: 'openai',
    ai_model: 'gpt-test',
    ai_confidence: 0.9,
    is_deleted: isDeleted,
    deleted_at: isDeleted ? updatedAt : null,
    created_at: occurredAt,
    updated_at: updatedAt,
  }
}

function createServerLedgerMock(initialRows = []) {
  const ledgerMap = new Map(initialRows.map((row) => [row.id, { ...row }]))

  return async (_url, requestOptions = {}) => {
    const method = requestOptions.method || 'GET'
    const parsedUrl = new URL(String(_url), 'http://127.0.0.1')

    if (parsedUrl.pathname.endsWith('/sync/ledger/pull')) {
      const limitText = parsedUrl.searchParams.get('limit') || '1000'
      const limit = Number.parseInt(limitText, 10)
      const updatedAfter = parsedUrl.searchParams.get('updatedAfter') || ''
      const cursorId = parsedUrl.searchParams.get('cursorId') || ''

      const rows = [...ledgerMap.values()].sort(compareLedgerRowsByCursor)
      const filtered = updatedAfter
        ? rows.filter((row) => row.updated_at > updatedAfter || (row.updated_at === updatedAfter && row.id > cursorId))
        : rows

      return createJsonResponse({
        items: filtered.slice(0, limit),
      })
    }

    if (parsedUrl.pathname.endsWith('/sync/ledger/push')) {
      const payload = requestOptions.body ? JSON.parse(requestOptions.body) : { entries: [] }
      const entries = Array.isArray(payload.entries) ? payload.entries : []
      const items = []

      for (const entry of entries) {
        const existing = ledgerMap.get(entry.id)
        if (!existing || new Date(entry.updated_at).getTime() > new Date(existing.updated_at).getTime()) {
          ledgerMap.set(entry.id, {
            ...entry,
          })
        }
        const persisted = ledgerMap.get(entry.id)
        items.push({
          id: persisted.id,
          updated_at: persisted.updated_at,
        })
      }

      return createJsonResponse({
        items,
        pushedCount: entries.length,
      })
    }

    if (parsedUrl.pathname.endsWith('/sync/ai-config')) {
      return createJsonResponse({ item: null })
    }

    if (parsedUrl.pathname.endsWith('/sync/category-presets')) {
      return createJsonResponse({ item: null })
    }

    return createJsonResponse({ message: 'unexpected request' }, 500)
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

describe('ledger 数据层（服务端单一数据源）', () => {
  it('listAllLedgerEntries 应支持分页拉取超过 1000 条', async () => {
    const initialRows = []
    for (let index = 0; index < 1001; index += 1) {
      const occurredAt = new Date(2026, 2, 1, 0, 0, index).toISOString()
      const updatedAt = new Date(2026, 2, 1, 0, 0, index).toISOString()
      initialRows.push(createLedgerRow({
        id: `entry-${String(index).padStart(4, '0')}`,
        amount: index + 1,
        occurredAt,
        updatedAt,
      }))
    }

    globalThis.fetch.mockImplementation(createServerLedgerMock(initialRows))

    await ensureLedgerStoreReady()
    const allEntries = await listAllLedgerEntries()

    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(allEntries).toHaveLength(1001)
    expect(allEntries[0].id).toBe('entry-1000')
    expect(allEntries[1000].id).toBe('entry-0000')
  })

  it('append/update/delete/restore 应全部落在服务端并可回读', async () => {
    globalThis.fetch.mockImplementation(createServerLedgerMock([]))

    const inserted = await appendLedgerEntry({
      id: 'entry-1',
      amount: 66.6,
      currency: 'CNY',
      occurredAt: new Date(2026, 2, 5, 10, 0, 0).toISOString(),
      category: '餐饮',
      transactionType: 'expense',
      aiProvider: 'openai',
      aiModel: 'gpt-test',
    })

    expect(inserted.id).toBe('entry-1')
    expect((await listAllLedgerEntries())).toHaveLength(1)

    const updated = await updateLedgerEntry({
      id: 'entry-1',
      amount: 88.8,
      category: '购物',
      transactionType: 'expense',
    })

    expect(updated.amount).toBe(88.8)
    expect(updated.category).toBe('购物')

    await deleteLedgerEntry('entry-1')
    expect(await listAllLedgerEntries()).toEqual([])

    await restoreLedgerEntry('entry-1')
    const restoredEntries = await listAllLedgerEntries()
    expect(restoredEntries).toHaveLength(1)
    expect(restoredEntries[0].id).toBe('entry-1')
  })

  it('listLedgerEntriesByDate 与 listRecentLedgerEntries 应正确过滤', async () => {
    const rows = [
      createLedgerRow({
        id: 'd-1',
        amount: 10,
        occurredAt: new Date(2026, 2, 3, 12, 0, 0).toISOString(),
        updatedAt: new Date(2026, 2, 3, 12, 0, 1).toISOString(),
      }),
      createLedgerRow({
        id: 'd-2',
        amount: 20,
        occurredAt: new Date(2026, 2, 3, 18, 0, 0).toISOString(),
        updatedAt: new Date(2026, 2, 3, 18, 0, 1).toISOString(),
      }),
      createLedgerRow({
        id: 'd-3',
        amount: 30,
        occurredAt: new Date(2026, 2, 4, 8, 0, 0).toISOString(),
        updatedAt: new Date(2026, 2, 4, 8, 0, 1).toISOString(),
      }),
    ]

    globalThis.fetch.mockImplementation(createServerLedgerMock(rows))

    const dailyEntries = await listLedgerEntriesByDate('2026-03-03')
    const recentEntries = await listRecentLedgerEntries(2)

    expect(dailyEntries.map((entry) => entry.id)).toEqual(['d-2', 'd-1'])
    expect(recentEntries).toHaveLength(2)
  })
})
