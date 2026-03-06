import { describe, expect, it, vi } from 'vitest'
import {
  VIEWPORT_HEIGHT_CSS_VAR,
  bindViewportHeightSync,
  resolveViewportHeight,
  syncViewportHeightVar,
} from '../viewportHeightSync'

describe('viewportHeightSync', () => {
  it('优先使用 visualViewport 高度', () => {
    const fakeWindow = {
      innerHeight: 780,
      visualViewport: {
        height: 612.4,
      },
    }

    expect(resolveViewportHeight(fakeWindow)).toBe('612px')
  })

  it('会将可视视口高度写入根节点 CSS 变量', () => {
    const setProperty = vi.fn()
    const fakeDocument = {
      documentElement: {
        style: {
          setProperty,
        },
      },
    }
    const fakeWindow = {
      innerHeight: 720,
    }

    syncViewportHeightVar(fakeDocument, fakeWindow)

    expect(setProperty).toHaveBeenCalledWith(VIEWPORT_HEIGHT_CSS_VAR, '720px')
  })

  it('绑定后会在视口变化时重新同步，并支持清理监听', () => {
    const setProperty = vi.fn()
    const fakeDocument = {
      documentElement: {
        style: {
          setProperty,
        },
      },
    }
    const windowListeners = new Map()
    const visualViewportListeners = new Map()
    const fakeWindow = {
      innerHeight: 720,
      addEventListener: vi.fn((eventName, listener) => {
        windowListeners.set(eventName, listener)
      }),
      removeEventListener: vi.fn((eventName, listener) => {
        if (windowListeners.get(eventName) === listener) {
          windowListeners.delete(eventName)
        }
      }),
      visualViewport: {
        height: 640,
        addEventListener: vi.fn((eventName, listener) => {
          visualViewportListeners.set(eventName, listener)
        }),
        removeEventListener: vi.fn((eventName, listener) => {
          if (visualViewportListeners.get(eventName) === listener) {
            visualViewportListeners.delete(eventName)
          }
        }),
      },
    }

    const stopSync = bindViewportHeightSync(fakeDocument, fakeWindow)

    expect(setProperty).toHaveBeenLastCalledWith(VIEWPORT_HEIGHT_CSS_VAR, '640px')

    fakeWindow.visualViewport.height = 508
    visualViewportListeners.get('resize')()

    expect(setProperty).toHaveBeenLastCalledWith(VIEWPORT_HEIGHT_CSS_VAR, '508px')

    stopSync()

    expect(windowListeners.size).toBe(0)
    expect(visualViewportListeners.size).toBe(0)
  })
})
