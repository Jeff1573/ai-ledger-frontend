import fs from 'node:fs'
import path from 'node:path'
import cookieParser from 'cookie-parser'
import express from 'express'
import { ZodError } from 'zod'
import { serverConfig } from './config.js'
import { createAuthRouter } from './routes/authRoutes.js'
import { createHealthRouter } from './routes/healthRoutes.js'
import { createSyncRouter } from './routes/syncRoutes.js'

/**
 * 构造统一的接口未命中响应体。
 *
 * @param {import('express').Request} req 请求对象。
 * @returns {{message: string}} 响应体。
 */
function buildApiNotFoundPayload(req) {
  return {
    message: `未找到接口：${req.method} ${req.originalUrl}`,
  }
}

/**
 * 解析静态资源目录与入口文件路径。
 *
 * @param {string | undefined} customStaticAssetsDir 自定义目录。
 * @returns {{enabled: boolean, staticAssetsDir: string, indexHtmlPath: string}} 静态资源配置。
 */
function resolveStaticAssets(customStaticAssetsDir) {
  const staticAssetsDir =
    typeof customStaticAssetsDir === 'string' && customStaticAssetsDir.trim()
      ? customStaticAssetsDir.trim()
      : serverConfig.staticAssetsDir
  const indexHtmlPath = path.resolve(staticAssetsDir, 'index.html')
  return {
    enabled: fs.existsSync(indexHtmlPath),
    staticAssetsDir,
    indexHtmlPath,
  }
}

/**
 * 创建 Express 应用实例（支持 API 与前端静态资源同进程托管）。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @param {{staticAssetsDir?: string}} [options={}] 可选运行参数。
 * @returns {import('express').Express} Express 应用。
 */
export function createApp(dbPool, options = {}) {
  const staticAssets = resolveStaticAssets(options.staticAssetsDir)
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

  // API 未命中保持 JSON 404，避免被 SPA fallback 误吞。
  app.use('/api', (req, res) => {
    res.status(404).json(buildApiNotFoundPayload(req))
  })

  if (staticAssets.enabled) {
    app.use(express.static(staticAssets.staticAssetsDir))
    app.get('*', (req, res, next) => {
      // 仅对前端页面路由执行回退，静态资源缺失应继续返回 404。
      if (req.path.startsWith('/api') || req.path.includes('.')) {
        next()
        return
      }
      res.sendFile(staticAssets.indexHtmlPath)
    })
  }

  app.use((req, res) => {
    res.status(404).json(buildApiNotFoundPayload(req))
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
