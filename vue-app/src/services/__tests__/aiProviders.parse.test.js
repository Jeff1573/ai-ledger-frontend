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

  it('非法文本应抛出错误', () => {
    expect(() => parseAIResponse('不是 JSON')).toThrowError('AI 返回格式不合法，必须为 JSON 对象')
  })
})
