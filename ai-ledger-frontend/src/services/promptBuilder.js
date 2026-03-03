// 统一支付方式枚举，前后端都以该集合约束取值，避免自由文本导致统计口径不一致。
const ALLOWED_PAYMENT_METHODS = ['现金', '微信', '支付宝', '银行卡', '信用卡', 'Apple Pay', '其他']
// 提示词版本号，用于后续提示词策略升级时做兼容追踪。
const PROMPT_VERSION = 'v1.0.0'

/**
 * 构建交易图片结构化提取提示词。
 *
 * 设计目标：
 * - 固定输出 JSON 结构，降低后续解析波动。
 * - 引导模型优先匹配业务预设类别，未命中时允许回退。
 *
 * @param {Object} [context={}] 提示词上下文。
 * @param {string[]} [context.categoryNames] 可选类别名称列表，用于引导模型做语义贴近匹配。
 * @returns {{
 *   version: string,
 *   allowedPaymentMethods: string[],
 *   systemPrompt: string,
 *   userPrompt: string
 * }} 可直接用于调用多家模型接口的提示词对象。
 */
export function buildTransactionExtractionPrompt(context = {}) {
  // 仅接收非空字符串类别，避免把无效项拼进提示词干扰模型判断。
  const categoryNames = Array.isArray(context.categoryNames)
    ? context.categoryNames
        .filter((name) => typeof name === 'string')
        .map((name) => name.trim())
        .filter(Boolean)
    : []

  // 缺省文案显式声明“未提供预设类别”，避免模型误以为存在隐藏类别集合。
  const categoryText = categoryNames.length > 0 ? categoryNames.join('、') : '未提供预设类别'

  const systemPrompt = `
你是交易票据结构化提取助手。
任务仅限从图片中提取交易信息。
禁止闲聊、禁止解释、禁止 Markdown。
输出必须是一个 JSON 对象，且只输出 JSON。
`.trim()

  // 用固定字段和规则约束输出，降低模型生成自由度，避免后续解析不稳定。
  const userPrompt = `
请从上传的交易截图或小票图片中提取字段，返回 JSON：
{
  "amount": number | null,
  "currency": string | null,
  "occurredAt": "YYYY-MM-DD HH:mm:ss" | null,
  "location": string | null,
  "paymentMethod": string | null,
  "merchant": string | null,
  "category": string | null,
  "note": string | null,
  "transactionType": "expense" | "income" | null,
  "confidence": number | null
}

严格规则：
1. amount 必须是数字，不要货币符号；无法判断时返回 null。
2. occurredAt 格式必须为 YYYY-MM-DD HH:mm:ss；无法判断时返回 null。
3. paymentMethod 仅允许：${ALLOWED_PAYMENT_METHODS.join(' / ')}；无法判断时返回 "其他" 或 null。
4. confidence 取值范围必须在 0 到 1；无法判断时返回 null。
5. category 优先从以下预设类别语义中选择最贴近项：${categoryText}。
6. 若图片无法识别某字段，必须返回 null，不得编造。
7. 只返回一个 JSON 对象，不要包含额外文本。
`.trim()

  return {
    version: PROMPT_VERSION,
    allowedPaymentMethods: [...ALLOWED_PAYMENT_METHODS],
    systemPrompt,
    userPrompt,
  }
}

export { ALLOWED_PAYMENT_METHODS, PROMPT_VERSION }
