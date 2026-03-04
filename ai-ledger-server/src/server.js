import 'dotenv/config'
import { createApp } from './app.js'
import { serverConfig } from './config.js'
import { ensureBootstrapUser } from './db/bootstrapUser.js'
import { runMigrations } from './db/migrate.js'
import { dbPool } from './db/pool.js'

/**
 * 启动 HTTP 服务。
 *
 * @returns {Promise<import('http').Server>} HTTP Server 实例。
 */
async function startServer() {
  const appliedMigrations = await runMigrations(dbPool)
  if (appliedMigrations.length > 0) {
    console.log('[DB] 已应用迁移：', appliedMigrations.join(', '))
  }

  const bootstrapUser = await ensureBootstrapUser(
    dbPool,
    serverConfig.bootstrapCredentialsOutputPath,
  )
  if (bootstrapUser) {
    console.log('[Bootstrap] 检测到空库，已生成默认账号：')
    console.log(`  用户名: ${bootstrapUser.username}`)
    console.log(`  密码: ${bootstrapUser.password}`)
    console.log(`  凭据文件: ${serverConfig.bootstrapCredentialsOutputPath}`)
  }

  const app = createApp(dbPool)
  const server = app.listen(serverConfig.port, () => {
    console.log(`[Server] AI 记账服务已启动：http://localhost:${serverConfig.port}`)
  })
  return server
}

/**
 * 优雅关闭服务，释放数据库连接。
 *
 * @param {import('http').Server} server HTTP Server 实例。
 * @returns {Promise<void>} 无返回值。
 */
async function shutdown(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
  await dbPool.end()
}

let runningServer = null

startServer()
  .then((server) => {
    runningServer = server
  })
  .catch(async (error) => {
    console.error('[Server] 启动失败：', error)
    await dbPool.end()
    process.exit(1)
  })

process.on('SIGINT', async () => {
  if (!runningServer) {
    process.exit(0)
    return
  }
  try {
    await shutdown(runningServer)
    process.exit(0)
  } catch (error) {
    console.error('[Server] 关闭失败：', error)
    process.exit(1)
  }
})

process.on('SIGTERM', async () => {
  if (!runningServer) {
    process.exit(0)
    return
  }
  try {
    await shutdown(runningServer)
    process.exit(0)
  } catch (error) {
    console.error('[Server] 关闭失败：', error)
    process.exit(1)
  }
})

