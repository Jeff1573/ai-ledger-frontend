import { describe, expect, it } from 'vitest'
import {
  buildHomeLedgerSummary,
  DEFAULT_HOME_INCOME_CATEGORY_NAMES,
  mergeHomeLedgerEntry,
} from '../homeLedgerSummary'

/**
 * 构建固定本地时间的 ISO 文本，避免测试依赖当前时间。
 *
 * @param {number} year 年份。
 * @param {number} month 月份（从 1 开始）。
 * @param {number} day 日期。
 * @returns {string} ISO 时间文本。
 */
function createLocalIso(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0).toISOString()
}

describe('buildHomeLedgerSummary', () => {
  it('应只统计目标自然月内的账单', () => {
    const result = buildHomeLedgerSummary({
      now: new Date(2026, 2, 6, 9, 0, 0),
      categoryPresets: [{ name: '餐饮' }, { name: '交通' }],
      entries: [
        { amount: 18, category: '餐饮', occurredAt: createLocalIso(2026, 3, 2), transactionType: 'expense' },
        { amount: 66, category: '交通', occurredAt: createLocalIso(2026, 2, 28), transactionType: 'expense' },
        { amount: 8000, category: '工资', occurredAt: createLocalIso(2026, 4, 1), transactionType: 'income' },
      ],
    })

    expect(result.expenseTotal).toBe(18)
    expect(result.incomeTotal).toBe(0)
    expect(result.monthKey).toBe('2026-03')
  })

  it('应按预设聚合支出，并将未知类别归并到其他', () => {
    const result = buildHomeLedgerSummary({
      now: new Date(2026, 2, 6, 9, 0, 0),
      categoryPresets: [{ name: '餐饮' }, { name: '交通' }, { name: '其他' }],
      entries: [
        { amount: 32, category: '餐饮', occurredAt: createLocalIso(2026, 3, 3), transactionType: 'expense' },
        { amount: 15.8, category: '宠物', occurredAt: createLocalIso(2026, 3, 4), transactionType: 'expense' },
        { amount: 9, category: '交通', occurredAt: createLocalIso(2026, 3, 5), transactionType: 'expense' },
      ],
    })

    expect(result.expenseTotal).toBe(56.8)
    expect(result.expenseCards).toEqual([
      { name: '餐饮', amount: 32 },
      { name: '交通', amount: 9 },
      { name: '其他', amount: 15.8 },
    ])
  })

  it('应统计全部收入总额，但收入卡片仅展示三类快捷入口', () => {
    const result = buildHomeLedgerSummary({
      now: new Date(2026, 2, 6, 9, 0, 0),
      incomeCategoryNames: DEFAULT_HOME_INCOME_CATEGORY_NAMES,
      categoryPresets: [{ name: '餐饮' }],
      entries: [
        { amount: 8000, category: '工资', occurredAt: createLocalIso(2026, 3, 1), transactionType: 'income' },
        { amount: 1200, category: '奖金', occurredAt: createLocalIso(2026, 3, 2), transactionType: 'income' },
        { amount: 300, category: '兼职', occurredAt: createLocalIso(2026, 3, 3), transactionType: 'income' },
        { amount: 88, category: '红包', occurredAt: createLocalIso(2026, 3, 4), transactionType: 'income' },
      ],
    })

    expect(result.incomeTotal).toBe(9588)
    expect(result.incomeCards).toEqual([
      { name: '工资', amount: 8000 },
      { name: '奖金', amount: 1200 },
      { name: '兼职', amount: 300 },
    ])
  })

  it('空账单时应返回 0 金额和默认卡片结构', () => {
    const result = buildHomeLedgerSummary({
      now: new Date(2026, 2, 6, 9, 0, 0),
      categoryPresets: [{ name: '餐饮' }, { name: '交通' }],
      entries: [],
    })

    expect(result.expenseTotal).toBe(0)
    expect(result.incomeTotal).toBe(0)
    expect(result.expenseCards).toEqual([
      { name: '餐饮', amount: 0 },
      { name: '交通', amount: 0 },
      { name: '其他', amount: 0 },
    ])
    expect(result.incomeCards).toEqual([
      { name: '工资', amount: 0 },
      { name: '奖金', amount: 0 },
      { name: '兼职', amount: 0 },
    ])
  })
})

describe('mergeHomeLedgerEntry', () => {
  it('应在新增账单后按发生时间倒序返回列表', () => {
    const result = mergeHomeLedgerEntry(
      [
        { id: 'ledger-1', occurredAt: createLocalIso(2026, 3, 2), amount: 18 },
        { id: 'ledger-2', occurredAt: createLocalIso(2026, 3, 1), amount: 9 },
      ],
      { id: 'ledger-3', occurredAt: createLocalIso(2026, 3, 3), amount: 81 },
    )

    expect(result.map((entry) => entry.id)).toEqual(['ledger-3', 'ledger-1', 'ledger-2'])
  })

  it('应在相同 id 合并时覆盖旧账单，避免重复累计', () => {
    const result = mergeHomeLedgerEntry(
      [
        { id: 'ledger-1', occurredAt: createLocalIso(2026, 3, 1), amount: 18 },
        { id: 'ledger-2', occurredAt: createLocalIso(2026, 3, 2), amount: 9 },
      ],
      { id: 'ledger-1', occurredAt: createLocalIso(2026, 3, 4), amount: 28 },
    )

    expect(result).toHaveLength(2)
    expect(result.map((entry) => entry.id)).toEqual(['ledger-1', 'ledger-2'])
    expect(result[0].amount).toBe(28)
  })

  it('空列表时应直接返回仅包含新增账单的新数组', () => {
    const result = mergeHomeLedgerEntry([], {
      id: 'ledger-1',
      occurredAt: createLocalIso(2026, 3, 6),
      amount: 66,
    })

    expect(result).toEqual([
      { id: 'ledger-1', occurredAt: createLocalIso(2026, 3, 6), amount: 66 },
    ])
  })
})
