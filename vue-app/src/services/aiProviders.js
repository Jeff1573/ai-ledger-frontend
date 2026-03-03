import { ALLOWED_PAYMENT_METHODS, buildTransactionExtractionPrompt } from './promptBuilder'

const REQUEST_TIMEOUT_MS = 10_000
const ANTHROPIC_VERSION = '2023-06-01'
const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const PAYMENT_METHOD_SET = new Set(ALLOWED_PAYMENT_METHODS)

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

function buildChatCompletionsURL(baseURL) {
  return `${normalizeBaseURL(baseURL)}/chat/completions`
}

function readOpenAIText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

function readAnthropicText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : []
  return content
    .map((item) => (item && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function extractFirstJSONObject(rawText) {
  if (typeof rawText !== 'string' || !rawText) {
    return ''
  }

  let startIndex = -1
  let depth = 0
  let inString = false
  let isEscaped = false

  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index]

    if (startIndex === -1) {
      if (char === '{') {
        startIndex = index
        depth = 1
      }
      continue
    }

    if (inString) {
      if (isEscaped) {
        isEscaped = false
        continue
      }
      if (char === '\\') {
        isEscaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return rawText.slice(startIndex, index + 1)
      }
    }
  }

  return ''
}

function parseJSONObjectFromText(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return null
  }

  try {
    return JSON.parse(rawText)
  } catch {
    const jsonChunk = extractFirstJSONObject(rawText)
    if (!jsonChunk) {
      return null
    }
    try {
      return JSON.parse(jsonChunk)
    } catch {
      return null
    }
  }
}

function normalizeNullableString(value) {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized || null
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100) / 100
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.round(parsed * 100) / 100
    }
  }
  return null
}

function normalizeOccurredAt(value) {
  const text = normalizeNullableString(value)
  if (!text) {
    return null
  }
  if (!OCCURRED_AT_PATTERN.test(text)) {
    return null
  }
  return text
}

function normalizePaymentMethod(value) {
  const text = normalizeNullableString(value)
  if (!text) {
    return null
  }
  if (PAYMENT_METHOD_SET.has(text)) {
    return text
  }
  return '其他'
}

function normalizeTransactionType(value) {
  if (value === 'income' || value === 'expense') {
    return value
  }
  return null
}

function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (value < 0 || value > 1) {
    return null
  }
  return Math.round(value * 1000) / 1000
}

function normalizeAIParsedTransaction(raw) {
  return {
    amount: normalizeAmount(raw.amount),
    currency: normalizeNullableString(raw.currency)?.toUpperCase() || null,
    occurredAt: normalizeOccurredAt(raw.occurredAt),
    location: normalizeNullableString(raw.location),
    paymentMethod: normalizePaymentMethod(raw.paymentMethod),
    merchant: normalizeNullableString(raw.merchant),
    category: normalizeNullableString(raw.category),
    note: normalizeNullableString(raw.note),
    transactionType: normalizeTransactionType(raw.transactionType),
    confidence: normalizeConfidence(raw.confidence),
  }
}

function assertImagePayload(imagePayload) {
  const mimeType = typeof imagePayload?.mimeType === 'string' ? imagePayload.mimeType.trim() : ''
  const base64Data = typeof imagePayload?.base64Data === 'string' ? imagePayload.base64Data.trim() : ''
  if (!mimeType || !base64Data) {
    throw new Error('图片数据不完整，请重新上传后再试')
  }
  return {
    mimeType,
    base64Data,
  }
}

function getModelFromConfig(config) {
  return typeof config?.model === 'string' ? config.model.trim() : ''
}

async function analyzeWithOpenAI(config, imagePayload, promptContext) {
  const endpoint = buildChatCompletionsURL(config.baseURL)
  const prompts = buildTransactionExtractionPrompt(promptContext)
  const response = await requestWithTimeout(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders('openai', config.token, true),
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 800,
      response_format: {
        type: 'json_object',
      },
      messages: [
        {
          role: 'system',
          content: prompts.systemPrompt,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompts.userPrompt,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${imagePayload.mimeType};base64,${imagePayload.base64Data}`,
              },
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const message = await parseErrorMessage(response, 'OpenAI 图片识别失败')
    throw new Error(message)
  }

  const payload = await safeReadJSON(response)
  const contentText = readOpenAIText(payload)
  if (!contentText) {
    throw new Error('OpenAI 未返回可解析内容')
  }
  return contentText
}

async function analyzeWithAnthropic(config, imagePayload, promptContext) {
  const endpoint = buildMessagesURL(config.baseURL)
  const prompts = buildTransactionExtractionPrompt(promptContext)
  const response = await requestWithTimeout(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders('anthropic', config.token, true),
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 800,
      system: prompts.systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompts.userPrompt,
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imagePayload.mimeType,
                data: imagePayload.base64Data,
              },
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const message = await parseErrorMessage(response, 'Anthropic 图片识别失败')
    throw new Error(message)
  }

  const payload = await safeReadJSON(response)
  const contentText = readAnthropicText(payload)
  if (!contentText) {
    throw new Error('Anthropic 未返回可解析内容')
  }
  return contentText
}

export function parseAIResponse(rawText) {
  const parsedObject = parseJSONObjectFromText(rawText)
  if (!parsedObject || typeof parsedObject !== 'object' || Array.isArray(parsedObject)) {
    throw new Error('AI 返回格式不合法，必须为 JSON 对象')
  }
  return normalizeAIParsedTransaction(parsedObject)
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
  const endpoint = buildChatCompletionsURL(config.baseURL)
  const response = await requestWithTimeout(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders('openai', config.token, true),
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: 'ping',
        },
      ],
    }),
  })

  if (!response.ok) {
    const message = await parseErrorMessage(response, 'OpenAI 模型连通性测试失败')
    throw new Error(message)
  }

  return `OpenAI 模型 ${config.model} 接口可达`
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
    const message = await parseErrorMessage(response, 'Anthropic 模型连通性测试失败')
    throw new Error(message)
  }

  return `Anthropic 模型 ${config.model} 接口可达`
}

export async function testConnectivity(config) {
  const startedAt = performance.now()
  const modelName = getModelFromConfig(config)

  // 连通性测试必须绑定具体模型，避免出现“接口可达但模型不可用”的误判。
  if (!modelName) {
    return {
      ok: false,
      provider: config.provider,
      latencyMs: 0,
      message: '请先选择待测试模型',
    }
  }

  try {
    const nextConfig = {
      ...config,
      model: modelName,
    }
    const message =
      nextConfig.provider === 'anthropic'
        ? await testAnthropic(nextConfig)
        : await testOpenAI(nextConfig)

    return {
      ok: true,
      provider: nextConfig.provider,
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

export async function analyzeTransactionImage(config, imagePayload, promptContext = {}) {
  const startedAt = performance.now()
  const modelName = getModelFromConfig(config)
  if (!modelName) {
    return {
      ok: false,
      error: '请先在 AI 配置中设置当前使用模型',
      latencyMs: 0,
    }
  }

  try {
    const normalizedImagePayload = assertImagePayload(imagePayload)
    const nextConfig = {
      ...config,
      model: modelName,
    }

    const rawText =
      nextConfig.provider === 'anthropic'
        ? await analyzeWithAnthropic(nextConfig, normalizedImagePayload, promptContext)
        : await analyzeWithOpenAI(nextConfig, normalizedImagePayload, promptContext)

    const data = parseAIResponse(rawText)
    return {
      ok: true,
      data,
      latencyMs: Math.round(performance.now() - startedAt),
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ok: false,
        error: `图片识别超时（>${REQUEST_TIMEOUT_MS / 1000}s）`,
        latencyMs: Math.round(performance.now() - startedAt),
      }
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : '图片识别失败',
      latencyMs: Math.round(performance.now() - startedAt),
    }
  }
}
