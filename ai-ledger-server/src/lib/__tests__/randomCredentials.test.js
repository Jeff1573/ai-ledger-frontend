import { describe, expect, it } from 'vitest'
import { generateBootstrapCredentials } from '../randomCredentials.js'

describe('generateBootstrapCredentials', () => {
  it('应生成非空账号与密码，且账号带 user_ 前缀', () => {
    const credentials = generateBootstrapCredentials()
    expect(credentials.username.startsWith('user_')).toBe(true)
    expect(credentials.username.length).toBeGreaterThan(5)
    expect(credentials.password.length).toBeGreaterThanOrEqual(20)
  })

  it('连续生成应具有随机性', () => {
    const first = generateBootstrapCredentials()
    const second = generateBootstrapCredentials()
    expect(first.username === second.username && first.password === second.password).toBe(false)
  })
})

