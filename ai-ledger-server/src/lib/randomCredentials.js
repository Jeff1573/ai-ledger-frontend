import { randomInt } from 'node:crypto'

// 默认账号名前缀。
const USERNAME_PREFIX = 'user_'
// 默认账号名随机部分长度。
const USERNAME_RANDOM_LENGTH = 8
// 默认密码长度。
const PASSWORD_LENGTH = 20
// 去除容易混淆字符后的账号字符集。
const USERNAME_CHARSET = 'abcdefghjkmnpqrstuvwxyz23456789'
// 默认密码字符集（含大小写、数字、常用符号）。
const PASSWORD_CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*'

/**
 * 生成固定长度随机字符串。
 *
 * @param {string} charset 字符集合。
 * @param {number} length 长度。
 * @returns {string} 随机字符串。
 */
function randomString(charset, length) {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    const randomIndex = randomInt(0, charset.length)
    value += charset[randomIndex]
  }
  return value
}

/**
 * 生成默认账号名。
 *
 * @returns {string} 账号名。
 */
export function generateDefaultUsername() {
  return `${USERNAME_PREFIX}${randomString(USERNAME_CHARSET, USERNAME_RANDOM_LENGTH)}`
}

/**
 * 生成默认密码。
 *
 * @returns {string} 密码明文。
 */
export function generateDefaultPassword() {
  return randomString(PASSWORD_CHARSET, PASSWORD_LENGTH)
}

/**
 * 生成一组默认登录凭据。
 *
 * @returns {{username: string, password: string}} 默认账号密码。
 */
export function generateBootstrapCredentials() {
  return {
    username: generateDefaultUsername(),
    password: generateDefaultPassword(),
  }
}

