import { describe, expect, it } from 'vitest'
import { isIncomingNewerOrEqual } from '../lww.js'

describe('isIncomingNewerOrEqual', () => {
  it('当入站更新时间更晚时应返回 true', () => {
    const result = isIncomingNewerOrEqual('2026-03-04T10:00:01.000Z', '2026-03-04T10:00:00.000Z')
    expect(result).toBe(true)
  })

  it('当入站更新时间相同应返回 true', () => {
    const result = isIncomingNewerOrEqual('2026-03-04T10:00:00.000Z', '2026-03-04T10:00:00.000Z')
    expect(result).toBe(true)
  })

  it('当入站更新时间更早时应返回 false', () => {
    const result = isIncomingNewerOrEqual('2026-03-04T09:59:59.000Z', '2026-03-04T10:00:00.000Z')
    expect(result).toBe(false)
  })
})

