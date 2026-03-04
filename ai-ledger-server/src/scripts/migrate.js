import 'dotenv/config'
import { runMigrations } from '../db/migrate.js'
import { dbPool } from '../db/pool.js'

/**
 * 手动执行数据库迁移脚本。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function main() {
  const applied = await runMigrations(dbPool)
  if (applied.length === 0) {
    console.log('[DB] 无待执行迁移。')
    return
  }
  console.log('[DB] 已执行迁移：', applied.join(', '))
}

main()
  .then(async () => {
    await dbPool.end()
  })
  .catch(async (error) => {
    console.error('[DB] 迁移执行失败：', error)
    await dbPool.end()
    process.exit(1)
  })

