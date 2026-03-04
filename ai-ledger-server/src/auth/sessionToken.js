import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { serverConfig } from '../config.js'

// JWT 算法固定为 HS256。
const SESSION_JWT_ALGORITHM = 'HS256'

let runtimeSessionSecret = serverConfig.sessionSecret

if (!runtimeSessionSecret) {
  runtimeSessionSecret = randomBytes(32).toString('hex')
  // 开发环境兜底：未配置 SESSION_SECRET 时自动生成临时密钥（重启后会话失效）。
  console.warn(
    '[Auth] 未配置 SESSION_SECRET，已启用临时密钥（服务重启后会话将失效）。',
  )
}

const sessionSecretKey = new TextEncoder().encode(runtimeSessionSecret)

/**
 * 签发会话令牌。
 *
 * @param {{id: string, username: string, passwordVersion: number}} user 登录用户信息。
 * @returns {Promise<string>} JWT 字符串。
 */
export async function signSessionToken(user) {
  return new SignJWT({
    username: user.username,
    pv: user.passwordVersion,
  })
    .setProtectedHeader({ alg: SESSION_JWT_ALGORITHM })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${serverConfig.sessionTtlSeconds}s`)
    .sign(sessionSecretKey)
}

/**
 * 校验会话令牌。
 *
 * @param {string} token JWT 字符串。
 * @returns {Promise<{id: string, username: string, passwordVersion: number} | null>} 解析后的会话主体。
 */
export async function verifySessionToken(token) {
  if (!token || typeof token !== 'string') {
    return null
  }

  try {
    const verified = await jwtVerify(token, sessionSecretKey, {
      algorithms: [SESSION_JWT_ALGORITHM],
    })
    const payload = verified.payload
    const userId = payload.sub || ''
    const username = typeof payload.username === 'string' ? payload.username : ''
    const passwordVersion = Number(payload.pv)
    if (!userId || !username || !Number.isInteger(passwordVersion) || passwordVersion <= 0) {
      return null
    }
    return {
      id: userId,
      username,
      passwordVersion,
    }
  } catch {
    return null
  }
}

