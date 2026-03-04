import { serverConfig } from '../config.js'

/**
 * 生成统一的会话 Cookie 配置。
 *
 * @returns {{httpOnly: boolean, sameSite: 'lax', secure: boolean, path: string, maxAge: number}} Cookie 配置对象。
 */
function buildSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: serverConfig.nodeEnv === 'production',
    path: '/',
    maxAge: serverConfig.sessionTtlSeconds * 1000,
  }
}

/**
 * 写入会话 Cookie。
 *
 * @param {import('express').Response} res 响应对象。
 * @param {string} token JWT 会话令牌。
 * @returns {void} 无返回值。
 */
export function setSessionCookie(res, token) {
  res.cookie(serverConfig.cookieName, token, buildSessionCookieOptions())
}

/**
 * 清理会话 Cookie。
 *
 * @param {import('express').Response} res 响应对象。
 * @returns {void} 无返回值。
 */
export function clearSessionCookie(res) {
  const options = buildSessionCookieOptions()
  res.clearCookie(serverConfig.cookieName, {
    httpOnly: options.httpOnly,
    sameSite: options.sameSite,
    secure: options.secure,
    path: options.path,
  })
}

