import { toTimestampMs } from './time.js'

/**
 * 判断入站版本是否可覆盖现有版本（LWW：更新时间更晚或相等即可覆盖）。
 *
 * @param {unknown} incomingUpdatedAt 入站更新时间。
 * @param {unknown} existingUpdatedAt 现有更新时间。
 * @returns {boolean} 是否允许覆盖。
 */
export function isIncomingNewerOrEqual(incomingUpdatedAt, existingUpdatedAt) {
  return toTimestampMs(incomingUpdatedAt) >= toTimestampMs(existingUpdatedAt)
}

/**
 * 判断入站版本是否严格晚于现有版本（LWW：仅更新时间更晚才覆盖）。
 *
 * @param {unknown} incomingUpdatedAt 入站更新时间。
 * @param {unknown} existingUpdatedAt 现有更新时间。
 * @returns {boolean} 是否允许覆盖。
 */
export function isIncomingStrictlyNewer(incomingUpdatedAt, existingUpdatedAt) {
  return toTimestampMs(incomingUpdatedAt) > toTimestampMs(existingUpdatedAt)
}
