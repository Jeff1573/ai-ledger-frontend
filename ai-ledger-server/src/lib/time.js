/**
 * 将任意输入标准化为 ISO 时间文本；非法输入回退到当前时间。
 *
 * @param {unknown} value 原始输入。
 * @returns {string} ISO 时间文本。
 */
export function toISOTextOrNow(value) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString()
  }
  return parsed.toISOString()
}

/**
 * 将时间输入转换为毫秒时间戳，非法输入回退 0。
 *
 * @param {unknown} value 原始时间输入。
 * @returns {number} 时间戳（毫秒）。
 */
export function toTimestampMs(value) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

