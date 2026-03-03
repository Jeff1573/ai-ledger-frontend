import { describe, expect, it } from 'vitest'
import { matchCategoryPreset } from '../categoryMatcher'

const PRESETS = [
  {
    id: 'cat-catering',
    name: '餐饮',
    aliases: ['吃饭', '外卖'],
  },
  {
    id: 'cat-transport',
    name: '交通',
    aliases: ['打车', '地铁'],
  },
]

describe('matchCategoryPreset', () => {
  it('应命中标准类别名称', () => {
    const result = matchCategoryPreset('餐饮', PRESETS)
    expect(result.matched).toBe(true)
    expect(result.category).toBe('餐饮')
    expect(result.matchedBy).toBe('name')
  })

  it('应通过别名命中标准类别', () => {
    const result = matchCategoryPreset('打车', PRESETS)
    expect(result.matched).toBe(true)
    expect(result.category).toBe('交通')
    expect(result.matchedBy).toBe('alias')
  })

  it('未命中预设时应回退到 AI 原类别', () => {
    // 未匹配预设时应保留 AI 原始类别，便于用户后续手动归档。
    const result = matchCategoryPreset('宠物', PRESETS)
    expect(result.matched).toBe(false)
    expect(result.category).toBe('宠物')
    expect(result.matchedBy).toBe('fallback')
  })
})
