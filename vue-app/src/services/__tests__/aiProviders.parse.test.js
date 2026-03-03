import { describe, expect, it } from 'vitest'
import { parseAIResponse } from '../aiProviders'

describe('parseAIResponse', () => {
  it('应解析合法 JSON 文本', () => {
    const result = parseAIResponse(`{
      "amount": 35.2,
      "currency": "cny",
      "occurredAt": "2026-03-01 12:20:33",
      "location": "上海",
      "paymentMethod": "支付宝",
      "merchant": "便利店",
      "category": "餐饮",
      "note": "午餐",
      "transactionType": "expense",
      "confidence": 0.91
    }`)

    expect(result.amount).toBe(35.2)
    expect(result.currency).toBe('CNY')
    expect(result.transactionType).toBe('expense')
    expect(result.confidence).toBe(0.91)
  })

  it('应能从包裹文本中提取首个 JSON 对象', () => {
    // 模拟真实模型输出：JSON 前后混有说明文字。
    const result = parseAIResponse(`识别结果如下：
    {
      "amount": "88.8",
      "currency": "USD",
      "occurredAt": "2026-02-10 09:22:11",
      "location": "杭州",
      "paymentMethod": "银行卡",
      "merchant": "超市",
      "category": "购物",
      "note": null,
      "transactionType": "expense",
      "confidence": 0.8
    }
    请查收`)

    expect(result.amount).toBe(88.8)
    expect(result.currency).toBe('USD')
    expect(result.paymentMethod).toBe('银行卡')
    expect(result.note).toBeNull()
  })

  it('应支持直接解析对象输入', () => {
    const result = parseAIResponse({
      amount: '128.6',
      currency: 'cny',
      occurredAt: '2026-02-10 09:22:11',
      location: '广州',
      paymentMethod: '微信',
      merchant: '便利店',
      category: '餐饮',
      note: '早餐',
      transactionType: 'expense',
      confidence: 0.95,
    })

    expect(result.amount).toBe(128.6)
    expect(result.currency).toBe('CNY')
    expect(result.category).toBe('餐饮')
  })

  it('应支持从包裹结构中提取交易对象', () => {
    const result = parseAIResponse({
      choices: [
        {
          message: {
            content: {
              data: {
                amount: 20,
                currency: 'CNY',
                occurredAt: '2026-02-10 09:22:11',
                location: null,
                paymentMethod: '支付宝',
                merchant: '咖啡店',
                category: '餐饮',
                note: null,
                transactionType: 'expense',
                confidence: 0.88,
              },
            },
          },
        },
      ],
    })

    expect(result.amount).toBe(20)
    expect(result.paymentMethod).toBe('支付宝')
    expect(result.confidence).toBe(0.88)
  })

  it('应优先提取字段更完整的嵌套交易对象', () => {
    const result = parseAIResponse({
      confidence: 0.9,
      data: {
        amount: 66.5,
        currency: 'cny',
        occurredAt: '2026-02-10 09:22:11',
        location: '深圳',
        paymentMethod: '微信',
        merchant: '快餐店',
        category: '餐饮',
        note: '午饭',
        transactionType: 'expense',
        confidence: 0.86,
      },
    })

    expect(result.amount).toBe(66.5)
    expect(result.currency).toBe('CNY')
    expect(result.category).toBe('餐饮')
    expect(result.confidence).toBe(0.86)
  })

  it('非法文本应抛出错误', () => {
    // 约束 parseAIResponse 的失败语义，避免上层拿到静默 null。
    expect(() => parseAIResponse('不是 JSON')).toThrowError('AI 返回格式不合法，必须为 JSON 对象')
  })
})
