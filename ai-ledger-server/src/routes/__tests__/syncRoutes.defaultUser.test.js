import { once } from 'node:events'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../middleware/auth.js', () => ({
  createOptionalAuthMiddleware: () => (req, _res, next) => {
    req.authUser = null
    next()
  },
}))

import { createSyncRouter } from '../syncRoutes.js'

async function startTestServer(app) {
  const server = app.listen(0)
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

describe('/sync 默认用户绑定', () => {
  /** @type {Array<() => Promise<void>>} */
  const closeTasks = []

  afterEach(async () => {
    while (closeTasks.length > 0) {
      const close = closeTasks.pop()
      if (close) {
        await close()
      }
    }
  })

  it('匿名访问应绑定默认用户并返回 200', async () => {
    const queryCalls = []
    const dbPool = {
      async query(sqlText, params = []) {
        const normalizedSql = typeof sqlText === 'string' ? sqlText.replace(/\s+/g, ' ').trim().toLowerCase() : ''
        queryCalls.push({ normalizedSql, params })

        if (normalizedSql.includes('from app_users')) {
          return {
            rows: [
              {
                id: '11111111-1111-1111-1111-111111111111',
                username: 'default_user',
              },
            ],
          }
        }

        if (normalizedSql.includes('from ai_configs')) {
          return {
            rows: [
              {
                user_id: '11111111-1111-1111-1111-111111111111',
                provider: 'openai',
                base_url: 'https://api.openai.com/v1',
                token: 'server-token',
                provider_models: {},
                created_at: '2026-03-05T00:00:00.000Z',
                updated_at: '2026-03-05T00:00:00.000Z',
              },
            ],
          }
        }

        return { rows: [] }
      },
    }

    const app = express()
    app.use(express.json())
    app.use('/api/sync', createSyncRouter(dbPool))
    const runtime = await startTestServer(app)
    closeTasks.push(runtime.close)

    const response = await fetch(`${runtime.baseUrl}/api/sync/ai-config`)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload?.item?.user_id).toBe('11111111-1111-1111-1111-111111111111')
    const aiQuery = queryCalls.find((call) => call.normalizedSql.includes('from ai_configs'))
    expect(aiQuery?.params?.[0]).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('默认用户不存在时应返回 503', async () => {
    const dbPool = {
      async query(sqlText) {
        const normalizedSql = typeof sqlText === 'string' ? sqlText.replace(/\s+/g, ' ').trim().toLowerCase() : ''
        if (normalizedSql.includes('from app_users')) {
          return { rows: [] }
        }
        return { rows: [] }
      },
    }

    const app = express()
    app.use(express.json())
    app.use('/api/sync', createSyncRouter(dbPool))
    const runtime = await startTestServer(app)
    closeTasks.push(runtime.close)

    const response = await fetch(`${runtime.baseUrl}/api/sync/ai-config`)
    const payload = await response.json()

    expect(response.status).toBe(503)
    expect(payload.message).toContain('默认数据用户')
  })

  it('存在多个用户时应返回 503，避免匿名绑定错误账号', async () => {
    const dbPool = {
      async query(sqlText) {
        const normalizedSql = typeof sqlText === 'string' ? sqlText.replace(/\s+/g, ' ').trim().toLowerCase() : ''
        if (normalizedSql.includes('from app_users')) {
          return {
            rows: [
              { id: '11111111-1111-1111-1111-111111111111', username: 'u1' },
              { id: '22222222-2222-2222-2222-222222222222', username: 'u2' },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const app = express()
    app.use(express.json())
    app.use('/api/sync', createSyncRouter(dbPool))
    const runtime = await startTestServer(app)
    closeTasks.push(runtime.close)

    const response = await fetch(`${runtime.baseUrl}/api/sync/ai-config`)
    const payload = await response.json()

    expect(response.status).toBe(503)
    expect(payload.message).toContain('多个数据用户')
  })
})
