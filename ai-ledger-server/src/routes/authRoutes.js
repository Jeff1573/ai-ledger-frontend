import argon2 from 'argon2'
import { Router } from 'express'
import { z } from 'zod'
import { clearSessionCookie, setSessionCookie } from '../auth/cookie.js'
import { signSessionToken } from '../auth/sessionToken.js'
import {
  createOptionalAuthMiddleware,
  createRequireAuthMiddleware,
} from '../middleware/auth.js'

// 账号登录请求体校验。
const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入账号'),
  password: z.string().min(1, '请输入密码'),
})

// 改密请求体校验。
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码至少 8 位'),
})

/**
 * 将账号名规范化为小写文本。
 *
 * @param {string} username 原始账号名。
 * @returns {string} 规范化账号名。
 */
function normalizeUsername(username) {
  return username.trim().toLowerCase()
}

/**
 * 构造前端可用的用户对象。
 *
 * @param {{id: string, username: string}} user 用户信息。
 * @returns {{id: string, username: string}} 前端用户对象。
 */
function toPublicAuthUser(user) {
  return {
    id: user.id,
    username: user.username,
  }
}

/**
 * 创建认证路由。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @returns {import('express').Router} 路由实例。
 */
export function createAuthRouter(dbPool) {
  const router = Router()
  const optionalAuth = createOptionalAuthMiddleware(dbPool)
  const requireAuth = createRequireAuthMiddleware()

  router.use(optionalAuth)

  router.get('/session', (req, res) => {
    if (!req.authUser) {
      res.json({
        authenticated: false,
        user: null,
      })
      return
    }
    res.json({
      authenticated: true,
      user: toPublicAuthUser(req.authUser),
    })
  })

  router.post('/login', async (req, res, next) => {
    try {
      const payload = loginSchema.parse(req.body || {})
      const username = normalizeUsername(payload.username)

      const queryResult = await dbPool.query(
        `
        select id, username, password_hash, password_version
        from app_users
        where username = $1
        `,
        [username],
      )

      if (queryResult.rowCount === 0) {
        res.status(401).json({ message: '账号或密码错误' })
        return
      }

      const dbUser = queryResult.rows[0]
      const isPasswordValid = await argon2.verify(dbUser.password_hash, payload.password)
      if (!isPasswordValid) {
        res.status(401).json({ message: '账号或密码错误' })
        return
      }

      const sessionToken = await signSessionToken({
        id: dbUser.id,
        username: dbUser.username,
        passwordVersion: Number(dbUser.password_version),
      })
      setSessionCookie(res, sessionToken)
      res.json({
        user: toPublicAuthUser(dbUser),
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/logout', (_req, res) => {
    clearSessionCookie(res)
    res.json({ success: true })
  })

  router.post('/change-password', requireAuth, async (req, res, next) => {
    try {
      const payload = changePasswordSchema.parse(req.body || {})
      if (payload.currentPassword === payload.newPassword) {
        res.status(400).json({ message: '新密码不能与当前密码相同' })
        return
      }

      const currentUserId = req.authUser.id
      const userResult = await dbPool.query(
        `
        select id, username, password_hash, password_version
        from app_users
        where id = $1
        `,
        [currentUserId],
      )
      if (userResult.rowCount === 0) {
        res.status(401).json({ message: '会话已失效，请重新登录' })
        return
      }

      const dbUser = userResult.rows[0]
      const isCurrentPasswordValid = await argon2.verify(
        dbUser.password_hash,
        payload.currentPassword,
      )
      if (!isCurrentPasswordValid) {
        res.status(400).json({ message: '当前密码错误' })
        return
      }

      const nextPasswordHash = await argon2.hash(payload.newPassword)
      const updatedResult = await dbPool.query(
        `
        update app_users
        set
          password_hash = $1,
          password_version = password_version + 1,
          updated_at = now()
        where id = $2
        returning id, username, password_version
        `,
        [nextPasswordHash, currentUserId],
      )
      const updatedUser = updatedResult.rows[0]

      // 改密成功后立即签发新会话，旧会话因密码版本号不匹配会自动失效。
      const sessionToken = await signSessionToken({
        id: updatedUser.id,
        username: updatedUser.username,
        passwordVersion: Number(updatedUser.password_version),
      })
      setSessionCookie(res, sessionToken)

      res.json({
        success: true,
        user: toPublicAuthUser(updatedUser),
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}

