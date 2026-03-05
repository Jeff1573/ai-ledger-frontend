import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

// 测试用前端入口内容，用于校验 SPA 回退是否命中 index.html。
const TEST_INDEX_HTML = '<!doctype html><html><body><h1>AI Ledger Test App</h1></body></html>'

/**
 * 创建测试用静态资源目录，并写入 index.html。
 *
 * @returns {Promise<{staticDir: string, cleanup: () => Promise<void>}>} 目录信息与清理函数。
 */
async function createStaticAssetsFixture() {
  const staticDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ledger-static-'))
  await fs.writeFile(path.join(staticDir, 'index.html'), TEST_INDEX_HTML, 'utf8')
  return {
    staticDir,
    cleanup: async () => {
      await fs.rm(staticDir, { recursive: true, force: true })
    },
  }
}

/**
 * 启动测试 HTTP 服务并返回基础地址。
 *
 * @param {import('express').Express} app Express 应用。
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>} 可访问地址与关闭函数。
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

describe('createApp 静态托管与路由分流', () => {
  let baseUrl = ''
  let closeServer = async () => {}
  let cleanupStaticAssets = async () => {}

  beforeAll(async () => {
    const fixture = await createStaticAssetsFixture()
    cleanupStaticAssets = fixture.cleanup
    const dbPool = {
      query: async () => ({ rows: [{ ok: 1 }] }),
    }
    const app = createApp(dbPool, {
      staticAssetsDir: fixture.staticDir,
    })
    const runtime = await startTestServer(app)
    baseUrl = runtime.baseUrl
    closeServer = runtime.close
  })

  afterAll(async () => {
    await closeServer()
    await cleanupStaticAssets()
  })

  it('GET /api/health 应返回 200 JSON', async () => {
    const response = await fetch(`${baseUrl}/api/health`)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.status).toBe('ok')
    expect(typeof payload.timestamp).toBe('string')
  })

  it('GET /api/not-exists 应返回 JSON 404', async () => {
    const response = await fetch(`${baseUrl}/api/not-exists`)
    const payload = await response.json()

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(payload.message).toContain('未找到接口')
  })

  it('GET / 应回退到 index.html', async () => {
    const response = await fetch(`${baseUrl}/`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('AI Ledger Test App')
  })

  it('GET /ledger/monthly 应回退到 index.html', async () => {
    const response = await fetch(`${baseUrl}/ledger/monthly`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('AI Ledger Test App')
  })

  it('POST /not-exists 应保持 JSON 404', async () => {
    const response = await fetch(`${baseUrl}/not-exists`, {
      method: 'POST',
    })
    const payload = await response.json()

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(payload.message).toContain('未找到接口')
  })
})
