import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetLedgerStoreReadyForTest,
  appendLedgerEntry,
  ensureLedgerStoreReady,
  listAllLedgerEntries,
  listLedgerEntriesByDate,
  listRecentLedgerEntries,
} from '../storage'
import { clearLedgerDbForTest, getAppMetaRecord } from '../ledgerDb'

// localStorage 历史账单键名（用于迁移测试夹具）。
const LEGACY_LEDGER_STORAGE_KEY = 'ai_accounting_ledger_entries_v1'
// 迁移完成标记键名。
const LEDGER_MIGRATION_META_KEY = 'ledger_migrated_from_localstorage_v1'

/**
 * 创建最小 localStorage mock，满足迁移测试读写需求。
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
 * 构造测试账单对象，减少重复字段拼接。
 *
 * @param {object} overrides 需要覆盖的字段。
 * @returns {object} 可入账测试对象。
 */
function buildEntry(overrides = {}) {
  return {
    amount: 10,
    currency: 'CNY',
    occurredAt: new Date(2026, 2, 3, 12, 0, 0).toISOString(),
    location: '',
    paymentMethod: '支付宝',
    merchant: '测试商户',
    category: '餐饮',
    note: '',
    transactionType: 'expense',
    sourceImageName: '',
    aiProvider: 'openai',
    aiModel: 'gpt-test',
    aiConfidence: 0.9,
    createdAt: new Date(2026, 2, 3, 12, 1, 0).toISOString(),
    ...overrides,
  }
}

beforeEach(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createLocalStorageMock(),
    configurable: true,
    writable: true,
  })
  await clearLedgerDbForTest()
  __resetLedgerStoreReadyForTest()
})

afterEach(async () => {
  await clearLedgerDbForTest()
  __resetLedgerStoreReadyForTest()
})

describe('ledger 数据层', () => {
  it('首次初始化应迁移 localStorage 账单并写入迁移标记', async () => {
    const legacyEntries = [
      {
        id: 'legacy-1',
        amount: '18.5',
        currency: 'cny',
        occurredAt: new Date(2026, 2, 1, 9, 30, 0).toISOString(),
        category: '餐饮',
        transactionType: 'expense',
      },
    ]
    localStorage.setItem(LEGACY_LEDGER_STORAGE_KEY, JSON.stringify(legacyEntries))

    await ensureLedgerStoreReady()

    const allEntries = await listAllLedgerEntries()
    const migrationMeta = await getAppMetaRecord(LEDGER_MIGRATION_META_KEY)
    expect(allEntries).toHaveLength(1)
    expect(allEntries[0].id).toBe('legacy-1')
    expect(allEntries[0].currency).toBe('CNY')
    expect(Boolean(migrationMeta?.value)).toBe(true)
    expect(localStorage.getItem(LEGACY_LEDGER_STORAGE_KEY)).not.toBeNull()
  })

  it('二次初始化不应重复迁移（幂等）', async () => {
    localStorage.setItem(
      LEGACY_LEDGER_STORAGE_KEY,
      JSON.stringify([buildEntry({ id: 'legacy-only', amount: 12 })]),
    )
    await ensureLedgerStoreReady()
    expect((await listAllLedgerEntries()).map((entry) => entry.id)).toEqual(['legacy-only'])

    // 模拟页面刷新后再次初始化，但此时本地备份内容已变化。
    localStorage.setItem(
      LEGACY_LEDGER_STORAGE_KEY,
      JSON.stringify([
        buildEntry({ id: 'legacy-only', amount: 12 }),
        buildEntry({ id: 'legacy-new', amount: 99 }),
      ]),
    )
    __resetLedgerStoreReadyForTest()
    await ensureLedgerStoreReady()

    const allIds = (await listAllLedgerEntries()).map((entry) => entry.id)
    expect(allIds).toEqual(['legacy-only'])
  })

  it('最近账单应仅返回最近 30 条并按时间倒序', async () => {
    for (let index = 0; index < 40; index += 1) {
      const occurredAt = new Date(2026, 2, 1, 0, index, 0).toISOString()
      await appendLedgerEntry(buildEntry({ amount: index + 1, occurredAt }))
    }

    const recentEntries = await listRecentLedgerEntries(30)
    expect(recentEntries).toHaveLength(30)
    expect(recentEntries[0].amount).toBe(40)
    expect(recentEntries[29].amount).toBe(11)
    expect(new Date(recentEntries[0].occurredAt).getTime()).toBeGreaterThan(
      new Date(recentEntries[29].occurredAt).getTime(),
    )
  })

  it('月账单按本地日查询应正确处理跨天边界', async () => {
    await appendLedgerEntry(buildEntry({ id: 'd-1', occurredAt: new Date(2026, 2, 3, 0, 0, 0, 0).toISOString() }))
    await appendLedgerEntry(
      buildEntry({ id: 'd-2', occurredAt: new Date(2026, 2, 3, 23, 59, 59, 999).toISOString() }),
    )
    await appendLedgerEntry(buildEntry({ id: 'd-3', occurredAt: new Date(2026, 2, 4, 0, 0, 0, 0).toISOString() }))

    const sameDayEntries = await listLedgerEntriesByDate('2026-03-03')
    const sameDayIds = sameDayEntries.map((entry) => entry.id)
    expect(sameDayIds).toEqual(['d-2', 'd-1'])
  })

  it('全部账单应返回全量并按时间倒序', async () => {
    await appendLedgerEntry(buildEntry({ id: 'all-1', occurredAt: new Date(2026, 2, 1, 10, 0, 0).toISOString() }))
    await appendLedgerEntry(buildEntry({ id: 'all-2', occurredAt: new Date(2026, 2, 2, 10, 0, 0).toISOString() }))
    await appendLedgerEntry(buildEntry({ id: 'all-3', occurredAt: new Date(2026, 2, 3, 10, 0, 0).toISOString() }))

    const allEntries = await listAllLedgerEntries()
    expect(allEntries.map((entry) => entry.id)).toEqual(['all-3', 'all-2', 'all-1'])
  })

  it('追加账单后应可被查询接口读取', async () => {
    const inserted = await appendLedgerEntry(buildEntry({ id: 'append-1', amount: 66.6 }))
    const allEntries = await listAllLedgerEntries()

    expect(inserted.id).toBe('append-1')
    expect(allEntries).toHaveLength(1)
    expect(allEntries[0].amount).toBe(66.6)
  })
})
