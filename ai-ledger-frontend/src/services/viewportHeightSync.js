/**
 * 统一记录可视视口高度的 CSS 变量名，供页面与弹窗共享。
 */
export const VIEWPORT_HEIGHT_CSS_VAR = '--app-viewport-height'

/**
 * 解析当前浏览器可用的视口高度，优先使用 `visualViewport` 适配软键盘场景。
 *
 * @param {{innerHeight?: number, visualViewport?: {height?: number} | null} | undefined} win 窗口对象。
 * @returns {string} 像素高度文本；无法解析时返回空字符串。
 */
export function resolveViewportHeight(win = globalThis.window) {
  const rawHeight = win?.visualViewport?.height ?? win?.innerHeight
  if (!Number.isFinite(rawHeight) || rawHeight <= 0) {
    return ''
  }
  return `${Math.round(rawHeight)}px`
}

/**
 * 将当前可视视口高度同步到根节点 CSS 变量。
 *
 * @param {{documentElement?: {style?: {setProperty?: (name: string, value: string) => void}}} | undefined} doc 文档对象。
 * @param {{innerHeight?: number, visualViewport?: {height?: number} | null} | undefined} win 窗口对象。
 * @returns {void} 无返回值。
 */
export function syncViewportHeightVar(doc = globalThis.document, win = globalThis.window) {
  const viewportHeight = resolveViewportHeight(win)
  if (!viewportHeight || !doc?.documentElement?.style?.setProperty) {
    return
  }
  doc.documentElement.style.setProperty(VIEWPORT_HEIGHT_CSS_VAR, viewportHeight)
}

/**
 * 绑定视口高度同步监听，处理窗口缩放、旋转与软键盘弹出。
 *
 * @param {{documentElement?: {style?: {setProperty?: (name: string, value: string) => void}}} | undefined} doc 文档对象。
 * @param {{
 *   innerHeight?: number,
 *   visualViewport?: {
 *     height?: number,
 *     addEventListener?: (eventName: string, listener: () => void) => void,
 *     removeEventListener?: (eventName: string, listener: () => void) => void
 *   } | null,
 *   addEventListener?: (eventName: string, listener: () => void) => void,
 *   removeEventListener?: (eventName: string, listener: () => void) => void
 * } | undefined} win 窗口对象。
 * @returns {() => void} 解除监听函数。
 */
export function bindViewportHeightSync(doc = globalThis.document, win = globalThis.window) {
  if (!doc?.documentElement || !win) {
    return () => {}
  }

  const syncViewportHeight = () => {
    syncViewportHeightVar(doc, win)
  }
  const visualViewport = win.visualViewport

  syncViewportHeight()
  win.addEventListener?.('resize', syncViewportHeight)
  win.addEventListener?.('orientationchange', syncViewportHeight)
  visualViewport?.addEventListener?.('resize', syncViewportHeight)

  return () => {
    win.removeEventListener?.('resize', syncViewportHeight)
    win.removeEventListener?.('orientationchange', syncViewportHeight)
    visualViewport?.removeEventListener?.('resize', syncViewportHeight)
  }
}
