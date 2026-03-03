/**
 * 归一化类别文本，消除大小写与空白差异，便于稳定匹配。
 *
 * @param {unknown} text 待归一化文本。
 * @returns {string} 归一化后的类别键；无效输入返回空字符串。
 */
function normalizeCategoryText(text) {
  if (typeof text !== 'string') {
    return ''
  }
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

/**
 * 归一化单个类别预设对象，过滤非法项并清洗别名列表。
 *
 * @param {unknown} preset 原始预设对象。
 * @returns {{id: string, name: string, aliases: string[]} | null} 合法预设或 null。
 */
function normalizePreset(preset) {
  if (!preset || typeof preset !== 'object') {
    return null
  }

  const name = typeof preset.name === 'string' ? preset.name.trim() : ''
  if (!name) {
    return null
  }

  return {
    id: typeof preset.id === 'string' ? preset.id.trim() : '',
    name,
    aliases: Array.isArray(preset.aliases)
      ? preset.aliases
          .filter((alias) => typeof alias === 'string')
          .map((alias) => alias.trim())
          .filter(Boolean)
      : [],
  }
}

/**
 * 按“标准名优先、别名其次、AI 原值回退”的顺序做类别归一。
 *
 * @param {unknown} aiCategory AI 返回的类别文本。
 * @param {Array<{id?: string, name?: string, aliases?: string[]}>} presets 预设类别列表。
 * @returns {{matched: boolean, presetId: string, category: string, matchedBy: 'name' | 'alias' | 'fallback' | 'default'}}
 * 类别匹配结果与命中来源。
 */
export function matchCategoryPreset(aiCategory, presets) {
  const normalizedInput = normalizeCategoryText(aiCategory)
  const normalizedPresets = Array.isArray(presets) ? presets.map(normalizePreset).filter(Boolean) : []

  // 分两阶段匹配：先命中标准名，再命中别名，确保结果可预测且便于审计。
  if (normalizedInput) {
    for (const preset of normalizedPresets) {
      if (normalizeCategoryText(preset.name) === normalizedInput) {
        return {
          matched: true,
          presetId: preset.id,
          category: preset.name,
          matchedBy: 'name',
        }
      }
    }

    for (const preset of normalizedPresets) {
      for (const alias of preset.aliases) {
        if (normalizeCategoryText(alias) === normalizedInput) {
          return {
            matched: true,
            presetId: preset.id,
            category: preset.name,
            matchedBy: 'alias',
          }
        }
      }
    }
  }

  if (typeof aiCategory === 'string' && aiCategory.trim()) {
    return {
      matched: false,
      presetId: '',
      category: aiCategory.trim(),
      matchedBy: 'fallback',
    }
  }

  return {
    matched: false,
    presetId: '',
    category: '其他',
    matchedBy: 'default',
  }
}

export { normalizeCategoryText }
