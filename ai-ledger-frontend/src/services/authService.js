import { cloudApiRequest, isCloudApiConfigured } from './cloudApiClient'

// 认证状态变更订阅器集合。
const authListeners = new Set()

let authReadyPromise = null
let currentUser = null

/**
 * @typedef {{id: string, username: string}} AuthUser
 */

/**
 * 广播认证状态变化，通知所有订阅者。
 *
 * @returns {void} 无返回值。
 */
function emitAuthChanged() {
  for (const listener of authListeners) {
    listener(currentUser)
  }
}

/**
 * 规范化账号名文本。
 *
 * @param {unknown} username 原始账号名。
 * @returns {string} 规范化账号名。
 */
function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : ''
}

/**
 * 规范化密码文本。
 *
 * @param {unknown} password 原始密码。
 * @returns {string} 规范化密码。
 */
function normalizePassword(password) {
  return typeof password === 'string' ? password.trim() : ''
}

/**
 * 将服务端用户对象映射为前端用户对象。
 *
 * @param {any} user 服务端返回用户对象。
 * @returns {AuthUser | null} 规范化用户。
 */
function normalizeAuthUser(user) {
  if (!user || typeof user !== 'object') {
    return null
  }

  const id = typeof user.id === 'string' ? user.id.trim() : ''
  const username = typeof user.username === 'string' ? user.username.trim() : ''
  if (!id || !username) {
    return null
  }
  return {
    id,
    username,
  }
}

/**
 * 初始化认证模块（只执行一次）。
 *
 * @returns {Promise<void>} 无返回值。
 */
export async function ensureAuthReady() {
  if (authReadyPromise) {
    return authReadyPromise
  }

  authReadyPromise = (async () => {
    try {
      if (!isCloudApiConfigured()) {
        currentUser = null
        emitAuthChanged()
        return
      }

      const session = await cloudApiRequest('/auth/session')
      if (session?.authenticated) {
        currentUser = normalizeAuthUser(session.user)
      } else {
        currentUser = null
      }
      emitAuthChanged()
    } catch (error) {
      // 初始化失败时允许后续重试，避免网络瞬断导致认证模块永久不可用。
      authReadyPromise = null
      throw error
    }
  })()

  return authReadyPromise
}

/**
 * 获取当前登录用户。
 *
 * @returns {AuthUser | null} 当前用户。
 */
export function getCurrentUser() {
  return currentUser
}

/**
 * 是否已登录。
 *
 * @returns {boolean} 登录状态。
 */
export function isAuthenticated() {
  return Boolean(currentUser?.id)
}

/**
 * 订阅认证状态变化。
 *
 * @param {(user: AuthUser | null) => void} listener 订阅回调。
 * @returns {() => void} 取消订阅函数。
 */
export function subscribeAuthChanges(listener) {
  if (typeof listener !== 'function') {
    return () => {}
  }
  authListeners.add(listener)
  listener(getCurrentUser())
  return () => {
    authListeners.delete(listener)
  }
}

/**
 * 账号密码登录。
 *
 * @param {string} username 账号名。
 * @param {string} password 密码。
 * @returns {Promise<void>} 无返回值。
 */
export async function signInWithPassword(username, password) {
  if (!isCloudApiConfigured()) {
    throw new Error('云服务未配置，无法登录')
  }

  const normalizedUsername = normalizeUsername(username)
  const normalizedPassword = normalizePassword(password)

  if (!normalizedUsername) {
    throw new Error('请输入账号')
  }
  if (!normalizedPassword) {
    throw new Error('请输入密码')
  }

  const result = await cloudApiRequest('/auth/login', {
    method: 'POST',
    body: {
      username: normalizedUsername,
      password: normalizedPassword,
    },
  })
  const user = normalizeAuthUser(result?.user)
  if (!user) {
    throw new Error('登录响应异常，请稍后重试')
  }

  currentUser = user
  emitAuthChanged()
}

/**
 * 修改当前账号密码。
 *
 * @param {string} currentPassword 当前密码。
 * @param {string} newPassword 新密码。
 * @returns {Promise<void>} 无返回值。
 */
export async function changePassword(currentPassword, newPassword) {
  if (!isCloudApiConfigured()) {
    throw new Error('云服务未配置，无法修改密码')
  }
  if (!currentUser?.id) {
    throw new Error('当前未登录')
  }

  const normalizedCurrentPassword = normalizePassword(currentPassword)
  const normalizedNewPassword = normalizePassword(newPassword)

  if (!normalizedCurrentPassword) {
    throw new Error('请输入当前密码')
  }
  if (!normalizedNewPassword) {
    throw new Error('请输入新密码')
  }
  if (normalizedNewPassword.length < 8) {
    throw new Error('新密码至少 8 位')
  }

  const result = await cloudApiRequest('/auth/change-password', {
    method: 'POST',
    body: {
      currentPassword: normalizedCurrentPassword,
      newPassword: normalizedNewPassword,
    },
  })
  const nextUser = normalizeAuthUser(result?.user)
  if (nextUser) {
    currentUser = nextUser
  }
  emitAuthChanged()
}

/**
 * 退出登录。
 *
 * @returns {Promise<void>} 无返回值。
 */
export async function signOut() {
  if (isCloudApiConfigured()) {
    await cloudApiRequest('/auth/logout', {
      method: 'POST',
    })
  }

  currentUser = null
  emitAuthChanged()
}
