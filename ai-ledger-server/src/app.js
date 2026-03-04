import cookieParser from 'cookie-parser'
import express from 'express'
import { ZodError } from 'zod'
import { createAuthRouter } from './routes/authRoutes.js'
import { createHealthRouter } from './routes/healthRoutes.js'
import { createSyncRouter } from './routes/syncRoutes.js'

/**
 * 创建 Express 应用实例。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @returns {import('express').Express} Express 应用。
 */
export function createApp(dbPool) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(
    express.json({
      limit: '2mb',
    }),
  )
  app.use(cookieParser())

  app.use('/api/health', createHealthRouter(dbPool))
  app.use('/api/auth', createAuthRouter(dbPool))
  app.use('/api/sync', createSyncRouter(dbPool))

  app.use((req, res) => {
    res.status(404).json({
      message: `未找到接口：${req.method} ${req.originalUrl}`,
    })
  })

  app.use((error, _req, res, _next) => {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0]
      res.status(400).json({
        message: firstIssue?.message || '请求参数不合法',
      })
      return
    }

    const message = error instanceof Error ? error.message : '服务器内部错误'
    res.status(500).json({
      message,
    })
  })

  return app
}

