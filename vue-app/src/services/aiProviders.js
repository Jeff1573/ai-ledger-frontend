const REQUEST_TIMEOUT_MS = 10_000
const ANTHROPIC_VERSION = '2023-06-01'

function normalizeBaseURL(baseURL) {
  return baseURL.trim().replace(/\/+$/, '')
}

function buildOpenAIHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  }
}

function buildAnthropicHeaders(token) {
  return {
    'x-api-key': token,
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

function buildRequestHeaders(provider, token, withJSON = false) {
  const baseHeaders = provider === 'anthropic' ? buildAnthropicHeaders(token) : buildOpenAIHeaders(token)
  if (!withJSON) {
    return baseHeaders
  }

  return {
    ...baseHeaders,
    'Content-Type': 'application/json',
  }
}

async function requestWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeout)
  }
}

async function safeReadJSON(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function readErrorMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const errorNode = payload.error
  if (typeof errorNode === 'string') {
    return errorNode
  }
  if (errorNode && typeof errorNode === 'object' && typeof errorNode.message === 'string') {
    return errorNode.message
  }
  if (typeof payload.message === 'string') {
    return payload.message
  }

  return ''
}

async function parseErrorMessage(response, fallbackPrefix) {
  const payload = await safeReadJSON(response)
  const payloadMessage = readErrorMessageFromPayload(payload)
  if (payloadMessage) {
    return `${fallbackPrefix}: ${payloadMessage}`
  }
  return `${fallbackPrefix}: HTTP ${response.status}`
}

function normalizeModelList(payload) {
  const rawList = Array.isArray(payload?.data) ? payload.data : []
  const names = rawList
    .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
    .filter(Boolean)

  return [...new Set(names)]
}

function buildModelsURL(baseURL) {
  return `${normalizeBaseURL(baseURL)}/models`
}

function buildMessagesURL(baseURL) {
  return `${normalizeBaseURL(baseURL)}/messages`
}

export async function fetchModelList(config) {
  const { provider, baseURL, token } = config
  const endpoint = buildModelsURL(baseURL)

  try {
    const response = await requestWithTimeout(endpoint, {
      method: 'GET',
      headers: buildRequestHeaders(provider, token),
    })

    if (!response.ok) {
      const message = await parseErrorMessage(response, '模型列表获取失败')
      return {
        ok: false,
        models: [],
        error: message,
      }
    }

    const payload = await safeReadJSON(response)
    const models = normalizeModelList(payload)
    if (models.length === 0 && provider === 'anthropic') {
      return {
        ok: false,
        models: [],
        error: '当前 Anthropic 端点未返回可用模型，请手动输入模型名称',
      }
    }

    return {
      ok: true,
      models,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ok: false,
        models: [],
        error: `模型列表获取超时（>${REQUEST_TIMEOUT_MS / 1000}s）`,
      }
    }

    return {
      ok: false,
      models: [],
      error: '模型列表获取失败，请检查 baseURL 和网络连接',
    }
  }
}

async function testOpenAI(config) {
  const endpoint = buildModelsURL(config.baseURL)
  const response = await requestWithTimeout(endpoint, {
    method: 'GET',
    headers: buildRequestHeaders('openai', config.token),
  })

  if (!response.ok) {
    const message = await parseErrorMessage(response, 'OpenAI 连通性测试失败')
    throw new Error(message)
  }

  return 'OpenAI 接口可达'
}

async function testAnthropic(config) {
  const endpoint = buildMessagesURL(config.baseURL)
  const response = await requestWithTimeout(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders('anthropic', config.token, true),
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: 'ping',
        },
      ],
    }),
  })

  if (!response.ok) {
    const message = await parseErrorMessage(response, 'Anthropic 连通性测试失败')
    throw new Error(message)
  }

  return 'Anthropic 接口可达'
}

export async function testConnectivity(config) {
  const startedAt = performance.now()

  try {
    const message =
      config.provider === 'anthropic' ? await testAnthropic(config) : await testOpenAI(config)

    return {
      ok: true,
      provider: config.provider,
      latencyMs: Math.round(performance.now() - startedAt),
      message,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ok: false,
        provider: config.provider,
        latencyMs: Math.round(performance.now() - startedAt),
        message: `连通性测试超时（>${REQUEST_TIMEOUT_MS / 1000}s）`,
      }
    }

    return {
      ok: false,
      provider: config.provider,
      latencyMs: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : '连通性测试失败',
    }
  }
}

