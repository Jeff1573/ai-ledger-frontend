import { ALLOWED_PAYMENT_METHODS, buildTransactionExtractionPrompt } from './promptBuilder'

// 统一网络超时阈值（毫秒），用于模型列表、连通性和图片识别三类请求。
const REQUEST_TIMEOUT_MS = 10_000
// Anthropic API 版本请求头，按官方要求显式指定。
const ANTHROPIC_VERSION = '2023-06-01'
// 交易时间仅接受固定格式，避免 Date 自动解析带来的时区歧义。
const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
// 支付方式白名单集合，用于 O(1) 判断是否命中允许值。
const PAYMENT_METHOD_SET = new Set(ALLOWED_PAYMENT_METHODS)
const TRANSACTION_FIELD_KEYS = [
  'amount',
  'currency',
  'occurredAt',
  'location',
  'paymentMethod',
  'merchant',
  'category',
  'note',
  'transactionType',
  'confidence',
]

/**
 * 规范化 baseURL，移除末尾多余斜杠。
 *
 * @param {string} baseURL 原始接口地址。
 * @returns {string} 规范化后的接口地址。
 */
function normalizeBaseURL(baseURL) {
  return baseURL.trim().replace(/\/+$/, '')
}

/**
 * 构建 OpenAI 兼容接口请求头。
 *
 * @param {string} token API 访问令牌。
 * @returns {{Authorization: string}} OpenAI 请求头对象。
 */
function buildOpenAIHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  }
}

/**
 * 构建 Anthropic 接口请求头。
 *
 * @param {string} token API 访问令牌。
 * @returns {{'x-api-key': string, 'anthropic-version': string}} Anthropic 请求头对象。
 */
function buildAnthropicHeaders(token) {
  return {
    'x-api-key': token,
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

/**
 * 根据 provider 构建请求头，并按需附加 JSON Content-Type。
 *
 * @param {'openai' | 'anthropic'} provider 服务商标识。
 * @param {string} token API 访问令牌。
 * @param {boolean} [withJSON=false] 是否附加 JSON 请求头。
 * @returns {Record<string, string>} 请求头对象。
 */
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

/**
 * 发送带超时控制的 HTTP 请求。
 *
 * @param {string} url 请求地址。
 * @param {RequestInit} [options={}] fetch 选项。
 * @returns {Promise<Response>} 原始响应对象。
 */
async function requestWithTimeout(url, options = {}) {
  const controller = new AbortController()
  // 用 AbortController 主动中断，避免请求长时间挂起阻塞交互流程。
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

/**
 * 安全读取 JSON 响应，解析失败时返回 null。
 *
 * @param {Response} response HTTP 响应对象。
 * @returns {Promise<any | null>} 解析后的 JSON 或 null。
 */
async function safeReadJSON(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * 从错误响应体中提取可读错误信息。
 *
 * @param {any} payload 响应体 JSON。
 * @returns {string} 错误信息文本；提取失败返回空字符串。
 */
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

/**
 * 解析并格式化错误信息，统一返回“前缀 + 细节”格式。
 *
 * @param {Response} response HTTP 响应对象。
 * @param {string} fallbackPrefix 错误前缀文案。
 * @returns {Promise<string>} 格式化后的错误文本。
 */
async function parseErrorMessage(response, fallbackPrefix) {
  const payload = await safeReadJSON(response)
  const payloadMessage = readErrorMessageFromPayload(payload)
  if (payloadMessage) {
    return `${fallbackPrefix}: ${payloadMessage}`
  }
  return `${fallbackPrefix}: HTTP ${response.status}`
}

/**
 * 归一化模型列表响应，提取并去重模型 ID。
 *
 * @param {any} payload 接口返回 JSON。
 * @returns {string[]} 模型名称数组。
 */
function normalizeModelList(payload) {
  const rawList = Array.isArray(payload?.data) ? payload.data : []
  const names = rawList
    .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
    .filter(Boolean)

  return [...new Set(names)]
}

/**
 * 构建模型列表接口地址。
 *
 * @param {string} baseURL 服务基地址。
 * @returns {string} /models 完整地址。
 */
function buildModelsURL(baseURL) {
  return `${normalizeBaseURL(baseURL)}/models`
}

/**
 * 构建 Anthropic messages 接口地址。
 *
 * @param {string} baseURL 服务基地址。
 * @returns {string} /messages 完整地址。
 */
function buildMessagesURL(baseURL) {
  return `${normalizeBaseURL(baseURL)}/messages`
}

/**
 * 构建 OpenAI chat completions 接口地址。
 *
 * @param {string} baseURL 服务基地址。
 * @returns {string} /chat/completions 完整地址。
 */
function buildChatCompletionsURL(baseURL) {
  return `${normalizeBaseURL(baseURL)}/chat/completions`
}

/**
 * 统计对象命中的交易字段数量。
 *
 * @param {unknown} value 待检查值。
 * @returns {number} 命中字段数量。
 */
function countTransactionFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 0
  }
  return TRANSACTION_FIELD_KEYS.reduce((count, key) => {
    return Object.prototype.hasOwnProperty.call(value, key) ? count + 1 : count
  }, 0)
}

/**
 * 判断对象是否包含交易字段。
 *
 * @param {unknown} value 待检查值。
 * @returns {value is Record<string, any>} 是否为交易对象。
 */
function hasAnyTransactionField(value) {
  return countTransactionFields(value) > 0
}

/**
 * 在两个候选对象中选择交易字段更完整的一个。
 *
 * @param {Record<string, any> | null} current 当前候选对象。
 * @param {Record<string, any> | null} next 新候选对象。
 * @returns {Record<string, any> | null} 更优候选对象。
 */
function pickBetterTransactionCandidate(current, next) {
  if (!next) {
    return current
  }
  if (!current) {
    return next
  }
  return countTransactionFields(next) > countTransactionFields(current) ? next : current
}

/**
 * 在嵌套结构中递归查找交易对象，兼容 message/content/tool_calls 等常见包裹格式。
 *
 * @param {unknown} value 待查找值。
 * @param {number} [depth=0] 递归深度。
 * @returns {Record<string, any> | null} 命中的交易对象。
 */
function findTransactionObject(value, depth = 0) {
  if (depth > 6 || value == null) {
    return null
  }

  if (typeof value === 'string') {
    const parsed = parseJSONObjectFromText(value)
    if (!parsed) {
      return null
    }
    return findTransactionObject(parsed, depth + 1)
  }

  if (Array.isArray(value)) {
    let bestMatch = null
    for (const item of value) {
      const matched = findTransactionObject(item, depth + 1)
      bestMatch = pickBetterTransactionCandidate(bestMatch, matched)
    }
    return bestMatch
  }

  if (typeof value !== 'object') {
    return null
  }

  const objectValue = /** @type {Record<string, any>} */ (value)
  let bestMatch = hasAnyTransactionField(objectValue) ? objectValue : null
  const prioritizedKeys = [
    'json',
    'input',
    'data',
    'result',
    'payload',
    'message',
    'content',
    'arguments',
    'tool_calls',
    'function_call',
  ]

  for (const key of prioritizedKeys) {
    if (!Object.prototype.hasOwnProperty.call(objectValue, key)) {
      continue
    }
    const matched = findTransactionObject(objectValue[key], depth + 1)
    bestMatch = pickBetterTransactionCandidate(bestMatch, matched)
  }

  // 最后兜底扫描对象值，兼容未知网关包裹层。
  for (const nestedValue of Object.values(objectValue)) {
    const matched = findTransactionObject(nestedValue, depth + 1)
    bestMatch = pickBetterTransactionCandidate(bestMatch, matched)
  }

  return bestMatch
}

/**
 * 从内容块数组中抽取文本。
 *
 * @param {unknown[]} blocks 内容块数组。
 * @returns {string} 拼接后的文本；无文本时返回空字符串。
 */
function readTextFromBlocks(blocks) {
  const textParts = []
  for (const item of blocks) {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) {
        textParts.push(text)
      }
      continue
    }

    if (!item || typeof item !== 'object') {
      continue
    }

    const text =
      typeof item.text === 'string'
        ? item.text.trim()
        : typeof item.output_text === 'string'
          ? item.output_text.trim()
          : typeof item.content === 'string'
            ? item.content.trim()
            : ''
    if (text) {
      textParts.push(text)
    }
  }
  return textParts.join('\n').trim()
}

/**
 * 判断模型内容是否可继续解析。
 *
 * @param {unknown} content 模型原始内容。
 * @returns {boolean} 是否具备可解析值。
 */
function hasUsableModelContent(content) {
  if (typeof content === 'string') {
    return Boolean(content.trim())
  }
  return Boolean(content && typeof content === 'object')
}

/**
 * 读取 OpenAI 响应中的内容，兼容字符串、内容块数组与对象包裹结构。
 *
 * @param {any} payload 接口返回 JSON。
 * @returns {unknown} 可交给 parseAIResponse 的原始内容。
 */
function readOpenAIContent(payload) {
  const message = payload?.choices?.[0]?.message
  if (!message || typeof message !== 'object') {
    return ''
  }

  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content.trim()
  }

  if (Array.isArray(message.content)) {
    const text = readTextFromBlocks(message.content)
    if (text) {
      return text
    }
  }

  const toolCallArguments = message?.tool_calls?.[0]?.function?.arguments
  if (typeof toolCallArguments === 'string' && toolCallArguments.trim()) {
    return toolCallArguments.trim()
  }

  const matchedObject = findTransactionObject(message.content)
  if (matchedObject) {
    return matchedObject
  }

  return ''
}

/**
 * 读取 Anthropic 响应中的内容，兼容文本块与结构化块。
 *
 * @param {any} payload 接口返回 JSON。
 * @returns {unknown} 可交给 parseAIResponse 的原始内容。
 */
function readAnthropicContent(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : []
  const text = readTextFromBlocks(content)
  if (text) {
    return text
  }

  const matchedObject = findTransactionObject(content)
  if (matchedObject) {
    return matchedObject
  }

  return ''
}

/**
 * 从混合文本中提取第一个完整 JSON 对象片段。
 *
 * @param {string} rawText 模型原始文本。
 * @returns {string} 提取出的 JSON 字符串；提取失败返回空字符串。
 */
function extractFirstJSONObject(rawText) {
  if (typeof rawText !== 'string' || !rawText) {
    return ''
  }

  // 通过轻量状态机抽取首个完整 JSON 对象：
  // - depth 追踪花括号层级
  // - inString/isEscaped 处理字符串内的转义与括号字符
  // 这样可兼容“前后包裹说明文字”的模型输出。
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

/**
 * 将模型原始文本解析为 JSON 对象，兼容“纯 JSON”与“包裹文本+JSON”两种格式。
 *
 * @param {string} rawText 模型原始文本。
 * @returns {Record<string, any> | null} 解析得到的对象；失败返回 null。
 */
function parseJSONObjectFromText(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return null
  }

  try {
    return JSON.parse(rawText)
  } catch {
    // 主体解析失败时再尝试抽取首个 JSON 片段，兼容非纯 JSON 文本响应。
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

/**
 * 归一化可空字符串字段。
 *
 * @param {unknown} value 原始字段值。
 * @returns {string | null} 去空白后的字符串；无效值返回 null。
 */
function normalizeNullableString(value) {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized || null
}

/**
 * 归一化金额字段，支持数字或可解析数字字符串。
 *
 * @param {unknown} value 原始金额。
 * @returns {number | null} 最多两位小数的金额；无效值返回 null。
 */
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

/**
 * 归一化交易时间字段，仅接受固定格式时间文本。
 *
 * @param {unknown} value 原始时间值。
 * @returns {string | null} 合法时间字符串；无效值返回 null。
 */
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

/**
 * 归一化支付方式字段。
 *
 * @param {unknown} value 原始支付方式。
 * @returns {string | null} 命中白名单返回原值，未命中返回“其他”，无效值返回 null。
 */
function normalizePaymentMethod(value) {
  const text = normalizeNullableString(value)
  if (!text) {
    return null
  }
  if (PAYMENT_METHOD_SET.has(text)) {
    return text
  }
  // 未命中枚举时统一归为“其他”，避免存储层出现无限扩散的新值。
  return '其他'
}

/**
 * 归一化交易类型字段。
 *
 * @param {unknown} value 原始交易类型。
 * @returns {'income' | 'expense' | null} 合法交易类型或 null。
 */
function normalizeTransactionType(value) {
  if (value === 'income' || value === 'expense') {
    return value
  }
  return null
}

/**
 * 归一化置信度字段。
 *
 * @param {unknown} value 原始置信度。
 * @returns {number | null} 保留三位小数的置信度；无效值返回 null。
 */
function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (value < 0 || value > 1) {
    return null
  }
  // 保留 3 位小数即可覆盖展示与排序需求，避免浮点噪声。
  return Math.round(value * 1000) / 1000
}

/**
 * 将 AI 解析对象统一映射到交易实体结构。
 *
 * @param {Record<string, any>} raw AI 原始对象。
 * @returns {{
 *   amount: number | null,
 *   currency: string | null,
 *   occurredAt: string | null,
 *   location: string | null,
 *   paymentMethod: string | null,
 *   merchant: string | null,
 *   category: string | null,
 *   note: string | null,
 *   transactionType: 'income' | 'expense' | null,
 *   confidence: number | null
 * }} 归一化交易对象。
 */
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

/**
 * 校验并提取图片载荷中的关键字段。
 *
 * @param {{mimeType?: string, base64Data?: string}} imagePayload 图片载荷。
 * @returns {{mimeType: string, base64Data: string}} 规范化后的图片数据。
 * @throws {Error} 当载荷缺失关键字段时抛出。
 */
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

/**
 * 从配置中安全提取模型名。
 *
 * @param {{model?: string}} config AI 配置。
 * @returns {string} 去空白后的模型名；缺失时返回空字符串。
 */
function getModelFromConfig(config) {
  return typeof config?.model === 'string' ? config.model.trim() : ''
}

/**
 * 调用 OpenAI 兼容接口进行图片识别。
 *
 * @param {{baseURL: string, token: string, model: string}} config OpenAI 配置。
 * @param {{mimeType: string, base64Data: string}} imagePayload 图片载荷。
 * @param {{categoryNames?: string[]}} promptContext 提示词上下文。
 * @returns {Promise<unknown>} 模型返回原始内容。
 * @throws {Error} 当接口失败或无可解析内容时抛出。
 */
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
      // 要求服务端直接输出 JSON 对象，降低文本后处理失败概率。
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
  const modelContent = readOpenAIContent(payload)
  if (!hasUsableModelContent(modelContent)) {
    throw new Error('OpenAI 未返回可解析内容')
  }
  return modelContent
}

/**
 * 调用 Anthropic 接口进行图片识别。
 *
 * @param {{baseURL: string, token: string, model: string}} config Anthropic 配置。
 * @param {{mimeType: string, base64Data: string}} imagePayload 图片载荷。
 * @param {{categoryNames?: string[]}} promptContext 提示词上下文。
 * @returns {Promise<unknown>} 模型返回原始内容。
 * @throws {Error} 当接口失败或无可解析内容时抛出。
 */
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
            // Anthropic 视觉输入使用 image/source/base64 结构，与 OpenAI 的 image_url 不同。
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
  const modelContent = readAnthropicContent(payload)
  if (!hasUsableModelContent(modelContent)) {
    throw new Error('Anthropic 未返回可解析内容')
  }
  return modelContent
}

/**
 * 解析并归一化 AI 返回的交易 JSON。
 *
 * @param {unknown} rawInput 模型原始响应（支持字符串、对象或包裹结构）。
 * @returns {{
 *   amount: number | null,
 *   currency: string | null,
 *   occurredAt: string | null,
 *   location: string | null,
 *   paymentMethod: string | null,
 *   merchant: string | null,
 *   category: string | null,
 *   note: string | null,
 *   transactionType: 'expense' | 'income' | null,
 *   confidence: number | null
 * }} 归一化后的交易对象。
 * @throws {Error} 当响应无法解析为 JSON 对象时抛出。
 */
export function parseAIResponse(rawInput) {
  const parsedObject =
    typeof rawInput === 'string'
      ? parseJSONObjectFromText(rawInput)
      : findTransactionObject(rawInput)
  if (!parsedObject || typeof parsedObject !== 'object' || Array.isArray(parsedObject)) {
    throw new Error('AI 返回格式不合法，必须为 JSON 对象')
  }
  return normalizeAIParsedTransaction(parsedObject)
}

/**
 * 拉取指定 Provider 的模型列表。
 *
 * @param {{provider: 'openai' | 'anthropic', baseURL: string, token: string}} config 模型拉取配置。
 * @returns {Promise<{ok: true, models: string[]} | {ok: false, models: string[], error: string}>}
 * 包含模型结果或错误信息。
 */
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
    // Anthropic 某些代理端点不返回 /models 数据，前端需提示用户手动输入模型名。
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

/**
 * 使用最小请求体测试 OpenAI 模型可达性。
 *
 * @param {{baseURL: string, token: string, model: string}} config 连通性配置。
 * @returns {Promise<string>} 测试成功文案。
 * @throws {Error} 当接口返回失败状态时抛出。
 */
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

/**
 * 使用最小请求体测试 Anthropic 模型可达性。
 *
 * @param {{baseURL: string, token: string, model: string}} config 连通性配置。
 * @returns {Promise<string>} 测试成功文案。
 * @throws {Error} 当接口返回失败状态时抛出。
 */
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

/**
 * 测试当前 Provider + 模型的基础连通性，并返回耗时。
 *
 * @param {{provider: 'openai' | 'anthropic', baseURL: string, token: string, model?: string}} config 连通性配置。
 * @returns {Promise<{ok: boolean, provider: 'openai' | 'anthropic', latencyMs: number, message: string}>}
 * 连通性结果。
 */
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

/**
 * 调用多模态模型识别交易图片，并返回归一化交易数据。
 *
 * @param {{provider: 'openai' | 'anthropic', baseURL: string, token: string, model?: string}} config AI 配置。
 * @param {{mimeType?: string, base64Data?: string}} imagePayload 图片载荷。
 * @param {{categoryNames?: string[]}} [promptContext={}] 提示词上下文。
 * @returns {Promise<
 *   | {ok: true, data: ReturnType<typeof parseAIResponse>, latencyMs: number}
 *   | {ok: false, error: string, latencyMs: number}
 * >} 识别结果。
 */
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

    const rawContent =
      nextConfig.provider === 'anthropic'
        ? await analyzeWithAnthropic(nextConfig, normalizedImagePayload, promptContext)
        : await analyzeWithOpenAI(nextConfig, normalizedImagePayload, promptContext)

    const data = parseAIResponse(rawContent)
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
