import { once } from 'node:events'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../middleware/auth.js', () => ({
  createOptionalAuthMiddleware: () => (req, _res, next) => {
    req.authUser = {
      id: '11111111-1111-1111-1111-111111111111',
    }
    next()
  },
  createRequireAuthMiddleware: () => (_req, _res, next) => {
    next()
  },
}))

import { createSyncRouter } from '../syncRoutes.js'

/**
 * 启动测试 HTTP 服务并返回基础地址。
 *
 * @param {import('express').Express} app Express 应用。
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>} 地址与关闭函数。
 */
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

/**
 * 创建带可观测调用状态的数据库连接池 mock。
 *
 * @param {{existingUpdatedAt: string}} options 预置现有账单更新时间。
 * @returns {{
 *   dbPool: {connect: () => Promise<{query: Function, release: Function}>},
 *   state: {updateCalls: number, insertCalls: number}
 * }} 连接池 mock 与观测状态。
 */
function createDbPoolMock(options) {
  const state = {
    updateCalls: 0,
    insertCalls: 0,
  }

  const client = {
    async query(sqlText) {
      const normalizedSql =
        typeof sqlText === 'string' ? sqlText.replace(/\s+/g, ' ').trim().toLowerCase() : ''

      if (normalizedSql === 'begin' || normalizedSql === 'commit' || normalizedSql === 'rollback') {
        return { rows: [] }
      }

      if (normalizedSql.includes('select id, updated_at from ledger_entries')) {
        return {
          rows: [
            {
              id: 'entry-1',
              updated_at: options.existingUpdatedAt,
            },
          ],
        }
      }

      if (normalizedSql.startsWith('insert into ledger_entries')) {
        state.insertCalls += 1
        return { rows: [] }
      }

      if (normalizedSql.startsWith('update ledger_entries')) {
        state.updateCalls += 1
        return { rows: [] }
      }

      return { rows: [] }
    },
    release() {},
  }

  return {
    dbPool: {
      async connect() {
        return client
      },
    },
    state,
  }
}

/**
 * 构造最小合法账单 push 负载。
 *
 * @param {string} updatedAt 入站更新时间。
 * @returns {Record<string, any>} 请求体。
 */
function buildLedgerPushPayload(updatedAt) {
  return {
    entries: [
      {
        id: 'entry-1',
        amount: 50,
        currency: 'CNY',
        occurred_at: '2026-03-05T08:00:00.000Z',
        location: null,
        payment_method: '支付宝',
        merchant: '测试商户',
        category: '餐饮',
        note: null,
        transaction_type: 'expense',
        source_image_name: null,
        ai_provider: 'openai',
        ai_model: 'gpt-test',
        ai_confidence: 0.88,
        is_deleted: false,
        deleted_at: null,
        created_at: '2026-03-05T08:00:00.000Z',
        updated_at: updatedAt,
      },
    ],
  }
}

describe('/sync/ledger/push 冲突处理', () => {
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

  it('当入站 updated_at 与远端相同应保留远端记录', async () => {
    const existingUpdatedAt = '2026-03-05T08:30:00.000Z'
    const { dbPool, state } = createDbPoolMock({
      existingUpdatedAt,
    })
    const app = express()
    app.use(express.json())
    app.use('/api/sync', createSyncRouter(dbPool))
    const runtime = await startTestServer(app)
    closeTasks.push(runtime.close)

    const response = await fetch(`${runtime.baseUrl}/api/sync/ledger/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildLedgerPushPayload(existingUpdatedAt)),
    })
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(state.updateCalls).toBe(0)
    expect(state.insertCalls).toBe(0)
    expect(payload.items[0].updated_at).toBe(existingUpdatedAt)
  })

  it('当入站 updated_at 更晚应覆盖远端记录', async () => {
    const existingUpdatedAt = '2026-03-05T08:30:00.000Z'
    const incomingUpdatedAt = '2026-03-05T09:00:00.000Z'
    const { dbPool, state } = createDbPoolMock({
      existingUpdatedAt,
    })
    const app = express()
    app.use(express.json())
    app.use('/api/sync', createSyncRouter(dbPool))
    const runtime = await startTestServer(app)
    closeTasks.push(runtime.close)

    const response = await fetch(`${runtime.baseUrl}/api/sync/ledger/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildLedgerPushPayload(incomingUpdatedAt)),
    })
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(state.updateCalls).toBe(1)
    expect(payload.items[0].updated_at).toBe(incomingUpdatedAt)
  })
})

