// 云服务 API 基础地址；默认走同域反向代理 `/api`。
const CLOUD_API_BASE_URL =
  typeof import.meta !== 'undefined'
    ? (import.meta.env?.VITE_API_BASE_URL?.trim() || '/api')
    : '/api'

/**
 * 判断云服务 API 是否可用。
 *
 * @returns {boolean} 是否可用。
 */
export function isCloudApiConfigured() {
  return Boolean(CLOUD_API_BASE_URL)
}

/**
 * 返回云服务 API 配置缺失提示文案。
 *
 * @returns {string} 提示文本。
 */
export function getCloudApiConfigHint() {
  if (isCloudApiConfigured()) {
    return ''
  }
  return '未检测到 VITE_API_BASE_URL，当前为本地模式'
}

/**
 * 拼接云服务请求 URL。
 *
 * @param {string} path API 路径（以 `/` 开头）。
 * @returns {string} 完整 URL。
 */
function buildCloudApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${CLOUD_API_BASE_URL}${normalizedPath}`
}

/**
 * 从响应体中提取错误消息。
 *
 * @param {any} payload 响应 JSON。
 * @param {string} fallback 默认错误消息。
 * @returns {string} 错误消息文本。
 */
function extractErrorMessage(payload, fallback) {
  if (payload && typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim()
  }
  if (payload && typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim()
  }
  return fallback
}

/**
 * 统一发送云服务请求。
 *
 * @param {string} path API 路径（以 `/` 开头）。
 * @param {{method?: string, body?: any, headers?: Record<string, string>}} [options={}] 请求选项。
 * @returns {Promise<any>} 解析后的响应 JSON；无响应体时返回 `null`。
 */
export async function cloudApiRequest(path, options = {}) {
  if (!isCloudApiConfigured()) {
    throw new Error('云服务未配置，无法发起请求')
  }

  const method = options.method || 'GET'
  const headers = {
    ...(options.headers || {}),
  }
  let body = options.body

  if (body !== undefined && body !== null && !(body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json'
    body = JSON.stringify(body)
  }

  const response = await fetch(buildCloudApiUrl(path), {
    method,
    credentials: 'include',
    headers,
    body,
  })

  let payload = null
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    payload = await response.json()
  } else if (response.status !== 204) {
    const rawText = await response.text()
    payload = rawText ? { message: rawText } : null
  }

  if (!response.ok) {
    const fallback = `请求失败（${response.status}）`
    throw new Error(extractErrorMessage(payload, fallback))
  }

  return payload
}

