import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import argon2 from 'argon2'
import { generateBootstrapCredentials } from '../lib/randomCredentials.js'

/**
 * 将首次生成的默认账号密码写入本地文件。
 *
 * @param {string} filePath 输出路径。
 * @param {{username: string, password: string}} credentials 账号密码。
 * @returns {Promise<void>} 无返回值。
 */
async function writeBootstrapCredentialsFile(filePath, credentials) {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const content = [
    '# AI 记账默认账号（首次启动自动生成）',
    `generated_at=${new Date().toISOString()}`,
    `username=${credentials.username}`,
    `password=${credentials.password}`,
    '',
  ].join('\n')

  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error) || !String(error.message).includes('EEXIST')) {
      throw error
    }
    // 文件已存在时不覆盖，避免多次启动覆盖用户已保存的首次凭据。
  }
}

/**
 * 若数据库无用户则自动创建默认账号，并输出凭据。
 *
 * @param {import('pg').Pool} dbPool 连接池。
 * @param {string} outputFilePath 凭据输出路径。
 * @returns {Promise<{id: string, username: string, password: string} | null>} 新建账号信息；已存在用户时返回 null。
 */
export async function ensureBootstrapUser(dbPool, outputFilePath) {
  const client = await dbPool.connect()
  try {
    await client.query('begin')
    const countResult = await client.query('select count(*)::int as count from app_users')
    const userCount = countResult.rows[0]?.count || 0
    if (userCount > 0) {
      await client.query('commit')
      return null
    }

    const credentials = generateBootstrapCredentials()
    const nextUserId = randomUUID()
    const passwordHash = await argon2.hash(credentials.password)
    const nowISO = new Date().toISOString()

    await client.query(
      `
      insert into app_users(
        id,
        username,
        password_hash,
        password_version,
        created_at,
        updated_at
      ) values($1, $2, $3, 1, $4, $4)
      `,
      [nextUserId, credentials.username, passwordHash, nowISO],
    )

    await client.query('commit')
    await writeBootstrapCredentialsFile(outputFilePath, credentials)

    return {
      id: nextUserId,
      username: credentials.username,
      password: credentials.password,
    }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

