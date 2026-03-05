import { computed } from 'vue'

// QSelect 弹层统一偏移，确保菜单与输入框边界保持稳定间距。
const SELECT_POPUP_MENU_OFFSET = Object.freeze([0, 4])
// 统一限制下拉弹层高度，避免在小窗口内撑满遮罩层。
const SELECT_POPUP_CONTENT_STYLE = Object.freeze({ maxHeight: '280px' })

/**
 * 为 QSelect 生成统一弹层定位策略。
 *
 * 规则：
 * - 桌面端强制使用 menu，避免弹窗场景下误切到 dialog 导致定位偏移。
 * - 移动端使用 dialog，维持原生可用性。
 *
 * @param {{screen?: {gt?: {sm?: boolean}}}} quasar Quasar 实例（`useQuasar()` 返回值）。
 * @returns {{
 *   behavior: import('vue').ComputedRef<'menu' | 'dialog'>,
 *   menuAnchor: 'bottom left',
 *   menuSelf: 'top left',
 *   menuOffset: readonly number[],
 *   popupContentStyle: Readonly<{maxHeight: string}>
 * }} 统一下拉弹层策略对象。
 */
export function useSelectPopupPolicy(quasar) {
  const behavior = computed(() => (quasar?.screen?.gt?.sm ? 'menu' : 'dialog'))

  return {
    behavior,
    menuAnchor: 'bottom left',
    menuSelf: 'top left',
    menuOffset: SELECT_POPUP_MENU_OFFSET,
    popupContentStyle: SELECT_POPUP_CONTENT_STYLE,
  }
}

