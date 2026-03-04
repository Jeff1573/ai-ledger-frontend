import { serverConfig } from '../config.js'
import { clearSessionCookie } from '../auth/cookie.js'
import { verifySessionToken } from '../auth/sessionToken.js'

/**
 * 解析请求中的登录用户信息。
 *
 * @param {import('express').Request} req 请求对象。
 * @param {import('express').Response} res 响应对象。
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @returns {Promise<{id: string, username: string, passwordVersion: number} | null>} 用户信息。
 */
async function resolveAuthUser(req, res, dbPool) {
  const token = req.cookies?.[serverConfig.cookieName]
  if (!token) {
    return null
  }

  const tokenUser = await verifySessionToken(token)
  if (!tokenUser) {
    clearSessionCookie(res)
    return null
  }

  const result = await dbPool.query(
    `
    select id, username, password_version
    from app_users
    where id = $1
    `,
    [tokenUser.id],
  )

  if (result.rowCount === 0) {
    clearSessionCookie(res)
    return null
  }

  const dbUser = result.rows[0]
  if (Number(dbUser.password_version) !== tokenUser.passwordVersion) {
    // 密码版本不一致时强制失效旧会话。
    clearSessionCookie(res)
    return null
  }

  return {
    id: dbUser.id,
    username: dbUser.username,
    passwordVersion: Number(dbUser.password_version),
  }
}

/**
 * 创建“可选登录态”中间件。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @returns {import('express').RequestHandler} 中间件函数。
 */
export function createOptionalAuthMiddleware(dbPool) {
  return async (req, res, next) => {
    try {
      req.authUser = await resolveAuthUser(req, res, dbPool)
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * 创建“必须登录”中间件。
 *
 * @returns {import('express').RequestHandler} 中间件函数。
 */
export function createRequireAuthMiddleware() {
  return (req, res, next) => {
    if (!req.authUser) {
      res.status(401).json({
        message: '未登录或会话已过期',
      })
      return
    }
    next()
  }
}

