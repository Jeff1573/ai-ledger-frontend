function normalizeCategoryText(text) {
  if (typeof text !== 'string') {
    return ''
  }
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

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
 */
export function matchCategoryPreset(aiCategory, presets) {
  const normalizedInput = normalizeCategoryText(aiCategory)
  const normalizedPresets = Array.isArray(presets) ? presets.map(normalizePreset).filter(Boolean) : []

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
