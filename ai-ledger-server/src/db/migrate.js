import fs from 'node:fs/promises'
import path from 'node:path'

// 迁移记录表名。
const MIGRATION_TABLE_NAME = 'schema_migrations'

/**
 * 读取并按名称排序迁移 SQL 文件列表。
 *
 * @param {string} migrationsDir 迁移目录。
 * @returns {Promise<Array<{name: string, fullPath: string}>>} 迁移文件列表。
 */
async function listMigrationFiles(migrationsDir) {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(migrationsDir, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 确保迁移记录表存在。
 *
 * @param {import('pg').PoolClient} client 数据库客户端。
 * @returns {Promise<void>} 无返回值。
 */
async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists ${MIGRATION_TABLE_NAME} (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `)
}

/**
 * 执行尚未应用的 SQL 迁移文件。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @param {{migrationsDir?: string}} [options={}] 可选参数。
 * @returns {Promise<string[]>} 本次实际应用的迁移名列表。
 */
export async function runMigrations(dbPool, options = {}) {
  const migrationsDir =
    options.migrationsDir || path.resolve(process.cwd(), 'src/db/migrations')
  const files = await listMigrationFiles(migrationsDir)
  const appliedNames = []
  const client = await dbPool.connect()

  try {
    await ensureMigrationTable(client)
    const appliedResult = await client.query(`select name from ${MIGRATION_TABLE_NAME}`)
    const appliedNameSet = new Set(appliedResult.rows.map((row) => row.name))

    for (const file of files) {
      if (appliedNameSet.has(file.name)) {
        continue
      }

      const sqlText = await fs.readFile(file.fullPath, 'utf8')
      await client.query('begin')
      try {
        await client.query(sqlText)
        await client.query(
          `insert into ${MIGRATION_TABLE_NAME}(name, applied_at) values ($1, now())`,
          [file.name],
        )
        await client.query('commit')
        appliedNames.push(file.name)
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    }
  } finally {
    client.release()
  }

  return appliedNames
}

