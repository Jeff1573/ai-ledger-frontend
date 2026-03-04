import { describe, expect, it } from 'vitest'
import {
  TAB_SYNC_MIN_INTERVAL_MS,
  buildNextTabSyncStamps,
  createDefaultTabSyncStamps,
  doesSyncModeCover,
  isDataSyncTab,
  resolveTabSyncMode,
  shouldRunTabSync,
} from '../tabSyncPolicy'

describe('tabSyncPolicy', () => {
  it('应正确识别需要应用同步策略的数据页签', () => {
    expect(isDataSyncTab('home')).toBe(true)
    expect(isDataSyncTab('presets')).toBe(true)
    expect(isDataSyncTab('config')).toBe(true)
    expect(isDataSyncTab('auth')).toBe(false)
  })

  it('应根据页签返回对应同步模式', () => {
    expect(resolveTabSyncMode('home')).toBe('all')
    expect(resolveTabSyncMode('presets')).toBe('category')
    expect(resolveTabSyncMode('config')).toBe('ai')
    expect(resolveTabSyncMode('auth')).toBe(null)
  })

  it('首次进入或超出节流窗口应允许同步', () => {
    const nowMs = 1_800_000_000_000
    expect(shouldRunTabSync(0, { nowMs })).toBe(true)
    expect(shouldRunTabSync(nowMs - TAB_SYNC_MIN_INTERVAL_MS, { nowMs })).toBe(true)
    expect(shouldRunTabSync(nowMs - TAB_SYNC_MIN_INTERVAL_MS + 1, { nowMs })).toBe(false)
  })

  it('force=true 时应无条件允许同步', () => {
    const nowMs = 1_800_000_000_000
    expect(
      shouldRunTabSync(nowMs - TAB_SYNC_MIN_INTERVAL_MS + 1, {
        nowMs,
        force: true,
      }),
    ).toBe(true)
  })

  it('all 模式应同时更新全部数据页签时间戳', () => {
    const nowMs = 1_800_000_000_000
    const next = buildNextTabSyncStamps('all', createDefaultTabSyncStamps(), nowMs)
    expect(next).toEqual({
      home: nowMs,
      presets: nowMs,
      config: nowMs,
    })
  })

  it('category 与 ai 模式应仅更新对应页签时间戳', () => {
    const nowMs = 1_800_000_000_000
    const base = {
      home: 1,
      presets: 2,
      config: 3,
    }

    expect(buildNextTabSyncStamps('category', base, nowMs)).toEqual({
      home: 1,
      presets: nowMs,
      config: 3,
    })
    expect(buildNextTabSyncStamps('ai', base, nowMs)).toEqual({
      home: 1,
      presets: 2,
      config: nowMs,
    })
  })

  it('应正确判断同步模式覆盖关系', () => {
    expect(doesSyncModeCover('all', 'all')).toBe(true)
    expect(doesSyncModeCover('all', 'ai')).toBe(true)
    expect(doesSyncModeCover('all', 'category')).toBe(true)
    expect(doesSyncModeCover('ai', 'ai')).toBe(true)
    expect(doesSyncModeCover('category', 'category')).toBe(true)
    expect(doesSyncModeCover('ai', 'category')).toBe(false)
    expect(doesSyncModeCover('category', 'ai')).toBe(false)
    expect(doesSyncModeCover(null, 'ai')).toBe(false)
  })
})
