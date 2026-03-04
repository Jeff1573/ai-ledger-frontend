// 需要进入页面时触发远端检查的数据页签。
export const DATA_SYNC_TABS = ['home', 'presets', 'config']
// 同一页签最小同步间隔（毫秒）。
export const TAB_SYNC_MIN_INTERVAL_MS = 15 * 1000

const dataSyncTabSet = new Set(DATA_SYNC_TABS)

/**
 * 判断当前页签是否属于“数据展示页”。
 *
 * @param {string} tab 页签名称。
 * @returns {boolean} 是否需要应用同步策略。
 */
export function isDataSyncTab(tab) {
  return dataSyncTabSet.has(tab)
}

/**
 * 根据页签解析对应的云同步模式。
 *
 * @param {string} tab 页签名称。
 * @returns {'all' | 'category' | 'ai' | null} 同步模式；非数据页返回 null。
 */
export function resolveTabSyncMode(tab) {
  if (tab === 'home') {
    return 'all'
  }
  if (tab === 'presets') {
    return 'category'
  }
  if (tab === 'config') {
    return 'ai'
  }
  return null
}

/**
 * 判断已执行同步模式是否覆盖目标模式。
 *
 * 规则：
 * - `all` 覆盖任意模式。
 * - 同模式视为覆盖。
 * - `ai` 与 `category` 互不覆盖。
 *
 * @param {'all' | 'category' | 'ai' | null | undefined} executedMode 已执行同步模式。
 * @param {'all' | 'category' | 'ai' | null | undefined} targetMode 目标同步模式。
 * @returns {boolean} 是否覆盖。
 */
export function doesSyncModeCover(executedMode, targetMode) {
  if (!executedMode || !targetMode) {
    return false
  }
  if (executedMode === 'all') {
    return true
  }
  return executedMode === targetMode
}

/**
 * 判断当前是否应执行页签同步。
 *
 * @param {number} lastSyncedAtMs 上次成功同步时间戳（毫秒）。
 * @param {{force?: boolean, nowMs?: number, minIntervalMs?: number}} [options={}] 决策参数。
 * @returns {boolean} 是否应执行同步。
 */
export function shouldRunTabSync(lastSyncedAtMs, options = {}) {
  const {
    force = false,
    nowMs = Date.now(),
    minIntervalMs = TAB_SYNC_MIN_INTERVAL_MS,
  } = options

  if (force) {
    return true
  }
  if (!Number.isFinite(lastSyncedAtMs) || lastSyncedAtMs <= 0) {
    return true
  }
  return nowMs - lastSyncedAtMs >= minIntervalMs
}

/**
 * 创建页签同步时间戳的默认值。
 *
 * @returns {{home: number, presets: number, config: number}} 默认时间戳映射。
 */
export function createDefaultTabSyncStamps() {
  return {
    home: 0,
    presets: 0,
    config: 0,
  }
}

/**
 * 根据同步模式更新时间戳映射。
 *
 * @param {'all' | 'category' | 'ai' | null} mode 同步模式。
 * @param {{home: number, presets: number, config: number}} stamps 当前时间戳映射。
 * @param {number} [syncedAtMs=Date.now()] 同步完成时间戳。
 * @returns {{home: number, presets: number, config: number}} 新时间戳映射。
 */
export function buildNextTabSyncStamps(mode, stamps, syncedAtMs = Date.now()) {
  const normalizedSyncedAtMs = Number.isFinite(syncedAtMs) ? syncedAtMs : Date.now()
  const next = {
    home: Number.isFinite(stamps?.home) ? stamps.home : 0,
    presets: Number.isFinite(stamps?.presets) ? stamps.presets : 0,
    config: Number.isFinite(stamps?.config) ? stamps.config : 0,
  }

  if (mode === 'all') {
    next.home = normalizedSyncedAtMs
    next.presets = normalizedSyncedAtMs
    next.config = normalizedSyncedAtMs
    return next
  }
  if (mode === 'category') {
    next.presets = normalizedSyncedAtMs
    return next
  }
  if (mode === 'ai') {
    next.config = normalizedSyncedAtMs
    return next
  }
  return next
}
