import pg from 'pg'
import { serverConfig } from '../config.js'

const { Pool } = pg

if (!serverConfig.databaseUrl) {
  throw new Error('缺少 DATABASE_URL，服务无法连接 PostgreSQL')
}

/**
 * PostgreSQL 连接池单例。
 */
export const dbPool = new Pool({
  connectionString: serverConfig.databaseUrl,
  ssl: serverConfig.databaseUseSsl
    ? {
        rejectUnauthorized: false,
      }
    : undefined,
})

