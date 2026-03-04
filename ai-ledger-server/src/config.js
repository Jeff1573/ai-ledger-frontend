import path from 'node:path'

// 服务默认监听端口。
const DEFAULT_PORT = 3000
// 默认会话 Cookie 名称。
const DEFAULT_COOKIE_NAME = 'ai_ledger_session'
// 会话有效期（秒），默认 30 天。
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
// 首次启动自动账号凭据输出文件路径。
const DEFAULT_BOOTSTRAP_CREDENTIALS_FILE = 'bootstrap-credentials.txt'

/**
 * 读取可选文本环境变量，返回去空格后的文本。
 *
 * @param {unknown} value 原始值。
 * @returns {string} 规范化文本；未配置返回空字符串。
 */
function normalizeOptionalText(value) {
  if (typeof value !== 'string') {
    return ''
  }
  return value.trim()
}

/**
 * 读取整数环境变量，非法值回退默认值。
 *
 * @param {string} value 原始环境变量文本。
 * @param {number} fallback 默认值。
 * @returns {number} 有效整数。
 */
function readIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 读取布尔环境变量。
 *
 * @param {string} value 原始环境变量文本。
 * @param {boolean} fallback 默认值。
 * @returns {boolean} 布尔值。
 */
function readBooleanEnv(value, fallback) {
  const normalized = normalizeOptionalText(value).toLowerCase()
  if (!normalized) {
    return fallback
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false
  }
  return fallback
}

const databaseUrl = normalizeOptionalText(process.env.DATABASE_URL)
const sessionSecret = normalizeOptionalText(process.env.SESSION_SECRET)
const cookieName = normalizeOptionalText(process.env.COOKIE_NAME) || DEFAULT_COOKIE_NAME
const nodeEnv = normalizeOptionalText(process.env.NODE_ENV) || 'development'
const bootstrapCredentialsOutputPath = path.resolve(
  process.cwd(),
  normalizeOptionalText(process.env.BOOTSTRAP_CREDENTIALS_FILE) || DEFAULT_BOOTSTRAP_CREDENTIALS_FILE,
)

/**
 * 服务运行配置。
 */
export const serverConfig = {
  port: readIntegerEnv(process.env.PORT || '', DEFAULT_PORT),
  databaseUrl,
  databaseUseSsl: readBooleanEnv(process.env.DATABASE_USE_SSL || '', false),
  sessionSecret,
  cookieName,
  sessionTtlSeconds: readIntegerEnv(
    process.env.SESSION_TTL_SECONDS || '',
    DEFAULT_SESSION_TTL_SECONDS,
  ),
  nodeEnv,
  bootstrapCredentialsOutputPath,
}

