/**
 * 首页收入快捷卡片的默认类别顺序。
 *
 * 说明：
 * - 当前版本固定为参考稿要求的三类收入入口。
 * - 未命中这三类的收入只计入收入总额，不单独展示卡片。
 */
export const DEFAULT_HOME_INCOME_CATEGORY_NAMES = Object.freeze(['工资', '奖金', '兼职'])

/**
 * 归一化类别名称，统一去除首尾空白。
 *
 * @param {unknown} value 原始类别值。
 * @returns {string} 清洗后的类别名称；无效输入返回空字符串。
 */
function normalizeCategoryName(value) {
  if (typeof value !== 'string') {
    return ''
  }
  return value.trim()
}

/**
 * 归一化金额，过滤掉非正数与非法数值。
 *
 * @param {unknown} value 原始金额。
 * @returns {number} 合法金额；无效时返回 0。
 */
function normalizeAmount(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }
  return parsed
}

/**
 * 构建去重后的类别名称数组，并保留首次出现顺序。
 *
 * @param {unknown[]} rawList 原始名称列表。
 * @returns {string[]} 去重后的名称列表。
 */
function buildUniqueNameList(rawList) {
  if (!Array.isArray(rawList)) {
    return []
  }

  const seenNameSet = new Set()
  const uniqueNames = []

  for (const item of rawList) {
    const normalizedName = normalizeCategoryName(item)
    if (!normalizedName || seenNameSet.has(normalizedName)) {
      continue
    }
    seenNameSet.add(normalizedName)
    uniqueNames.push(normalizedName)
  }

  return uniqueNames
}

/**
 * 判断账单是否属于目标自然月。
 *
 * @param {{occurredAt?: string}} entry 账单对象。
 * @param {Date} monthDate 目标月基准日期。
 * @returns {boolean} 是否属于同一自然月。
 */
function isEntryInMonth(entry, monthDate) {
  const occurredAtDate = new Date(entry?.occurredAt)
  if (Number.isNaN(occurredAtDate.getTime())) {
    return false
  }

  return occurredAtDate.getFullYear() === monthDate.getFullYear()
    && occurredAtDate.getMonth() === monthDate.getMonth()
}

/**
 * 构建首页“本月汇总 + 类别卡片”展示数据。
 *
 * 规则：
 * - 仅统计目标自然月内的账单。
 * - 支出卡片按类别预设顺序展示，未命中预设的支出统一归到“其他”。
 * - 收入总额统计全部收入；收入卡片仅展示指定快捷类别。
 *
 * @param {{
 *   entries?: Array<{amount?: number, category?: string, occurredAt?: string, transactionType?: string}>,
 *   categoryPresets?: Array<{name?: string}>,
 *   incomeCategoryNames?: string[],
 *   now?: Date
 * }} [options={}] 汇总选项。
 * @returns {{
 *   monthKey: string,
 *   expenseTotal: number,
 *   incomeTotal: number,
 *   expenseCards: Array<{name: string, amount: number}>,
 *   incomeCards: Array<{name: string, amount: number}>
 * }} 首页展示数据。
 */
export function buildHomeLedgerSummary(options = {}) {
  const {
    entries = [],
    categoryPresets = [],
    incomeCategoryNames = DEFAULT_HOME_INCOME_CATEGORY_NAMES,
    now = new Date(),
  } = options

  const monthDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
  const expenseCategoryNames = buildUniqueNameList(categoryPresets.map((preset) => preset?.name))
  const normalizedIncomeCategoryNames = buildUniqueNameList(incomeCategoryNames)

  if (!expenseCategoryNames.includes('其他')) {
    expenseCategoryNames.push('其他')
  }

  if (expenseCategoryNames.length === 0) {
    expenseCategoryNames.push('其他')
  }

  const expenseTotals = new Map(expenseCategoryNames.map((categoryName) => [categoryName, 0]))
  const incomeTotals = new Map(normalizedIncomeCategoryNames.map((categoryName) => [categoryName, 0]))

  let expenseTotal = 0
  let incomeTotal = 0

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isEntryInMonth(entry, monthDate)) {
      continue
    }

    const normalizedAmount = normalizeAmount(entry?.amount)
    if (normalizedAmount <= 0) {
      continue
    }

    const normalizedCategory = normalizeCategoryName(entry?.category)
    if (entry?.transactionType === 'income') {
      incomeTotal += normalizedAmount
      if (incomeTotals.has(normalizedCategory)) {
        incomeTotals.set(normalizedCategory, incomeTotals.get(normalizedCategory) + normalizedAmount)
      }
      continue
    }

    expenseTotal += normalizedAmount
    if (normalizedCategory && expenseTotals.has(normalizedCategory)) {
      expenseTotals.set(normalizedCategory, expenseTotals.get(normalizedCategory) + normalizedAmount)
      continue
    }

    expenseTotals.set('其他', expenseTotals.get('其他') + normalizedAmount)
  }

  return {
    monthKey: `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`,
    expenseTotal,
    incomeTotal,
    expenseCards: expenseCategoryNames.map((categoryName) => ({
      name: categoryName,
      amount: expenseTotals.get(categoryName) || 0,
    })),
    incomeCards: normalizedIncomeCategoryNames.map((categoryName) => ({
      name: categoryName,
      amount: incomeTotals.get(categoryName) || 0,
    })),
  }
}
