import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GUEST_OWNER_KEY,
  __resetLedgerStoreReadyForTest,
  appendLedgerEntry,
  deleteLedgerEntry,
  ensureLedgerStoreReady,
  loadAIConfig,
  loadCategoryPresets,
  listAllLedgerEntries,
  listLedgerEntriesByDate,
  listRecentLedgerEntries,
  restoreLedgerEntry,
  saveAIConfig,
  saveCategoryPresets,
  setStorageOwnerKey,
  updateLedgerEntry,
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
  setStorageOwnerKey(GUEST_OWNER_KEY)
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

  it('编辑账单应按同一 ID 覆盖且不新增记录', async () => {
    await appendLedgerEntry(
      buildEntry({
        id: 'edit-1',
        amount: 66.6,
        category: '餐饮',
        occurredAt: new Date(2026, 2, 3, 10, 0, 0).toISOString(),
      }),
    )

    const updated = await updateLedgerEntry({
      id: 'edit-1',
      amount: 188.8,
      currency: 'usd',
      occurredAt: new Date(2026, 2, 4, 15, 30, 0).toISOString(),
      paymentMethod: '微信',
      merchant: '更新商户',
      category: '购物',
      note: '编辑后备注',
      transactionType: 'income',
    })

    const allEntries = await listAllLedgerEntries()
    expect(allEntries).toHaveLength(1)
    expect(allEntries[0].id).toBe('edit-1')
    expect(allEntries[0].amount).toBe(188.8)
    expect(allEntries[0].currency).toBe('USD')
    expect(allEntries[0].category).toBe('购物')
    expect(allEntries[0].transactionType).toBe('income')
    expect(updated.id).toBe('edit-1')
  })

  it('编辑账单应保留 createdAt 并刷新 updatedAt', async () => {
    const inserted = await appendLedgerEntry(
      buildEntry({
        id: 'edit-time-1',
        createdAt: new Date(2026, 2, 1, 8, 0, 0).toISOString(),
      }),
    )

    const updated = await updateLedgerEntry({
      id: 'edit-time-1',
      amount: 77,
      category: '交通',
    })

    expect(updated.createdAt).toBe(inserted.createdAt)
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(inserted.updatedAt).getTime(),
    )
  })

  it('软删除账单后，查询接口不应返回该记录', async () => {
    await appendLedgerEntry(
      buildEntry({
        id: 'delete-hide-1',
        occurredAt: new Date(2026, 2, 3, 10, 0, 0).toISOString(),
      }),
    )

    const deleted = await deleteLedgerEntry('delete-hide-1')
    expect(deleted.isDeleted).toBe(true)
    expect(Boolean(deleted.deletedAt)).toBe(true)

    const allEntries = await listAllLedgerEntries()
    const recentEntries = await listRecentLedgerEntries(30)
    const dailyEntries = await listLedgerEntriesByDate('2026-03-03')
    expect(allEntries).toEqual([])
    expect(recentEntries).toEqual([])
    expect(dailyEntries).toEqual([])
  })

  it('撤销删除后，账单应恢复可见', async () => {
    await appendLedgerEntry(
      buildEntry({
        id: 'restore-1',
        amount: 52,
      }),
    )
    await deleteLedgerEntry('restore-1')

    const restored = await restoreLedgerEntry('restore-1')
    expect(restored.isDeleted).toBe(false)
    expect(restored.deletedAt).toBe('')

    const allEntries = await listAllLedgerEntries()
    expect(allEntries).toHaveLength(1)
    expect(allEntries[0].id).toBe('restore-1')
  })

  it('已删除账单不应允许直接编辑', async () => {
    await appendLedgerEntry(
      buildEntry({
        id: 'delete-edit-1',
        amount: 66,
      }),
    )
    await deleteLedgerEntry('delete-edit-1')

    await expect(
      updateLedgerEntry({
        id: 'delete-edit-1',
        amount: 99,
      }),
    ).rejects.toThrow('账单已删除，请先撤销删除后再编辑')
  })

  it('删除与恢复应遵循 owner 隔离', async () => {
    setStorageOwnerKey('user-a')
    await appendLedgerEntry(buildEntry({ id: 'owner-delete-1', amount: 80 }))

    setStorageOwnerKey('user-b')
    await expect(deleteLedgerEntry('owner-delete-1')).rejects.toThrow('未找到可删除的账单记录')

    setStorageOwnerKey('user-a')
    await deleteLedgerEntry('owner-delete-1')
    const userAEmptyEntries = await listAllLedgerEntries()
    expect(userAEmptyEntries).toEqual([])

    await restoreLedgerEntry('owner-delete-1')
    const userARecoveredEntries = await listAllLedgerEntries()
    expect(userARecoveredEntries.map((entry) => entry.id)).toEqual(['owner-delete-1'])
  })

  it('append 时切换 owner 不应污染原调用 owner 的账单', async () => {
    setStorageOwnerKey('user-a')
    const appendPromise = appendLedgerEntry(buildEntry({ id: 'race-1', amount: 88 }))
    setStorageOwnerKey('user-b')
    await appendPromise

    const userBEntries = await listAllLedgerEntries()
    expect(userBEntries.map((entry) => entry.id)).toEqual([])

    setStorageOwnerKey('user-a')
    const userAEntries = await listAllLedgerEntries()
    expect(userAEntries.map((entry) => entry.id)).toEqual(['race-1'])
  })

  it('不同 owner 的账单查询应相互隔离', async () => {
    setStorageOwnerKey('user-a')
    await appendLedgerEntry(buildEntry({ id: 'a-1', amount: 12 }))

    setStorageOwnerKey('user-b')
    await appendLedgerEntry(buildEntry({ id: 'b-1', amount: 23 }))

    setStorageOwnerKey('user-a')
    const userAEntries = await listAllLedgerEntries()
    expect(userAEntries.map((entry) => entry.id)).toEqual(['a-1'])

    setStorageOwnerKey('user-b')
    const userBEntries = await listAllLedgerEntries()
    expect(userBEntries.map((entry) => entry.id)).toEqual(['b-1'])
  })

  it('ownerScope=all 时应返回全部 owner 的可见账单', async () => {
    setStorageOwnerKey('user-a')
    await appendLedgerEntry(
      buildEntry({
        id: 'all-scope-a',
        amount: 12,
        occurredAt: new Date(2026, 2, 3, 9, 0, 0).toISOString(),
      }),
    )

    setStorageOwnerKey('user-b')
    await appendLedgerEntry(
      buildEntry({
        id: 'all-scope-b',
        amount: 23,
        occurredAt: new Date(2026, 2, 3, 10, 0, 0).toISOString(),
      }),
    )

    setStorageOwnerKey(GUEST_OWNER_KEY)
    await appendLedgerEntry(
      buildEntry({
        id: 'all-scope-guest',
        amount: 34,
        occurredAt: new Date(2026, 2, 3, 11, 0, 0).toISOString(),
      }),
    )

    const guestScopedEntries = await listAllLedgerEntries()
    expect(guestScopedEntries.map((entry) => entry.id)).toEqual(['all-scope-guest'])

    const allScopedEntries = await listAllLedgerEntries({ ownerScope: 'all' })
    expect(allScopedEntries.map((entry) => entry.id)).toEqual([
      'all-scope-guest',
      'all-scope-b',
      'all-scope-a',
    ])
  })

  it('编辑账单时不同 owner 应保持隔离', async () => {
    setStorageOwnerKey('user-a')
    await appendLedgerEntry(buildEntry({ id: 'owner-edit-1', amount: 31 }))

    setStorageOwnerKey('user-b')
    await expect(
      updateLedgerEntry({
        id: 'owner-edit-1',
        amount: 999,
      }),
    ).rejects.toThrow('未找到可编辑的账单记录')

    setStorageOwnerKey('user-a')
    const userAEntries = await listAllLedgerEntries()
    expect(userAEntries).toHaveLength(1)
    expect(userAEntries[0].amount).toBe(31)
  })

  it('未登录时可通过 ownerKey 选项编辑与删除历史 owner 账单', async () => {
    setStorageOwnerKey('user-a')
    await appendLedgerEntry(buildEntry({ id: 'cross-owner-1', amount: 45 }))

    setStorageOwnerKey(GUEST_OWNER_KEY)
    await updateLedgerEntry(
      {
        id: 'cross-owner-1',
        amount: 99,
        category: '购物',
      },
      {
        ownerKey: 'user-a',
        skipAutoSync: true,
      },
    )

    let allEntries = await listAllLedgerEntries({ ownerScope: 'all' })
    expect(allEntries.find((entry) => entry.id === 'cross-owner-1')?.amount).toBe(99)

    await deleteLedgerEntry('cross-owner-1', {
      ownerKey: 'user-a',
      skipAutoSync: true,
    })
    allEntries = await listAllLedgerEntries({ ownerScope: 'all' })
    expect(allEntries.some((entry) => entry.id === 'cross-owner-1')).toBe(false)

    await restoreLedgerEntry('cross-owner-1', {
      ownerKey: 'user-a',
      skipAutoSync: true,
    })
    allEntries = await listAllLedgerEntries({ ownerScope: 'all' })
    expect(allEntries.some((entry) => entry.id === 'cross-owner-1')).toBe(true)
  })

  it('AI 配置应按 owner 作用域存储且保存后标记 dirty', () => {
    setStorageOwnerKey('user-a')
    const savedA = saveAIConfig({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      token: 'token-a',
      providerModels: {
        openai: { currentModel: 'gpt-a', models: ['gpt-a'] },
        anthropic: { currentModel: '', models: [] },
      },
    })
    expect(savedA.dirty).toBe(true)
    expect(Boolean(savedA.updatedAt)).toBe(true)

    setStorageOwnerKey('user-b')
    const configB = loadAIConfig()
    expect(configB.token).toBe('')

    saveAIConfig({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      token: 'token-b',
      providerModels: {
        openai: { currentModel: 'gpt-b', models: ['gpt-b'] },
        anthropic: { currentModel: '', models: [] },
      },
    })

    setStorageOwnerKey('user-a')
    const configA = loadAIConfig()
    expect(configA.token).toBe('token-a')
  })

  it('AI 配置支持显式 owner 作用域读写', () => {
    setStorageOwnerKey('user-a')
    saveAIConfig({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      token: 'token-a',
      providerModels: {
        openai: { currentModel: 'gpt-a', models: ['gpt-a'] },
        anthropic: { currentModel: '', models: [] },
      },
    })

    setStorageOwnerKey('user-b')
    saveAIConfig({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      token: 'token-b',
      providerModels: {
        openai: { currentModel: 'gpt-b', models: ['gpt-b'] },
        anthropic: { currentModel: '', models: [] },
      },
    })

    const userAConfigBefore = loadAIConfig('user-a')
    expect(userAConfigBefore.token).toBe('token-a')

    saveAIConfig(
      {
        provider: 'openai',
        baseURL: 'https://api.openai.com/v1',
        token: 'token-a-updated',
        providerModels: {
          openai: { currentModel: 'gpt-a', models: ['gpt-a'] },
          anthropic: { currentModel: '', models: [] },
        },
      },
      { ownerKey: 'user-a' },
    )

    const userAConfigAfter = loadAIConfig('user-a')
    const userBConfig = loadAIConfig()
    expect(userAConfigAfter.token).toBe('token-a-updated')
    expect(userBConfig.token).toBe('token-b')
  })

  it('类别预设应按 owner 作用域隔离', () => {
    setStorageOwnerKey('user-a')
    saveCategoryPresets([{ id: 'a', name: 'A类', aliases: ['a1'] }])

    setStorageOwnerKey('user-b')
    const userBPresets = loadCategoryPresets()
    expect(userBPresets.some((item) => item.name === 'A类')).toBe(false)
  })

  it('类别预设支持显式 owner 作用域读写', () => {
    setStorageOwnerKey('user-a')
    saveCategoryPresets([{ id: 'a', name: 'A类', aliases: ['a1'] }])

    setStorageOwnerKey('user-b')
    saveCategoryPresets([{ id: 'b', name: 'B类', aliases: ['b1'] }])

    const userAPresetsBefore = loadCategoryPresets('user-a')
    expect(userAPresetsBefore.map((item) => item.name)).toEqual(['A类'])

    saveCategoryPresets([{ id: 'a', name: 'A新类', aliases: ['a2'] }], {
      ownerKey: 'user-a',
    })

    const userAPresetsAfter = loadCategoryPresets('user-a')
    const userBPresets = loadCategoryPresets()
    expect(userAPresetsAfter.map((item) => item.name)).toEqual(['A新类'])
    expect(userBPresets.map((item) => item.name)).toEqual(['B类'])
  })
})
