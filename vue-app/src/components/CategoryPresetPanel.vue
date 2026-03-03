<script setup>
import { reactive, ref } from 'vue'
import { normalizeCategoryText } from '../services/categoryMatcher'
import { loadCategoryPresets, saveCategoryPresets } from '../services/storage'

const categoryPresets = ref(loadCategoryPresets())
const presetMessage = ref({ type: '', text: '' })
const newPresetName = ref('')
const newPresetAliases = ref('')
const aliasDraftMap = reactive({})

function setPresetMessage(type, text) {
  presetMessage.value = { type, text }
}

function parseAliasesText(aliasesText) {
  if (typeof aliasesText !== 'string') {
    return []
  }
  const aliasSet = new Set()
  const aliases = []
  for (const alias of aliasesText.split(/[,\n，]/)) {
    const normalized = alias.trim()
    if (!normalized || aliasSet.has(normalized)) {
      continue
    }
    aliasSet.add(normalized)
    aliases.push(normalized)
  }
  return aliases
}

function createPresetId() {
  const uuidFactory = globalThis.crypto?.randomUUID
  if (typeof uuidFactory === 'function') {
    return `preset-${uuidFactory.call(globalThis.crypto)}`
  }
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function persistPresets(nextPresets, successText) {
  try {
    categoryPresets.value = saveCategoryPresets(nextPresets)
    setPresetMessage('success', successText)
  } catch (error) {
    const message = error instanceof Error ? error.message : '类别预设保存失败'
    setPresetMessage('error', message)
  }
}

function handleAddPreset() {
  const name = newPresetName.value.trim()
  if (!name) {
    setPresetMessage('error', '请先输入类别名称')
    return
  }

  const normalizedName = normalizeCategoryText(name)
  const duplicated = categoryPresets.value.some(
    (preset) => normalizeCategoryText(preset.name) === normalizedName,
  )
  if (duplicated) {
    setPresetMessage('error', '类别已存在，请直接维护该类别别名')
    return
  }

  const aliases = parseAliasesText(newPresetAliases.value)
  const nextPresets = [
    ...categoryPresets.value,
    {
      id: createPresetId(),
      name,
      aliases,
    },
  ]

  persistPresets(nextPresets, `类别 ${name} 已添加`)
  newPresetName.value = ''
  newPresetAliases.value = ''
}

function handleDeletePreset(presetId) {
  const nextPresets = categoryPresets.value.filter((preset) => preset.id !== presetId)
  persistPresets(nextPresets, '类别预设已删除')
}

function handleAddAlias(presetId) {
  const aliasInput = aliasDraftMap[presetId] || ''
  const aliasesToAdd = parseAliasesText(aliasInput)
  if (aliasesToAdd.length === 0) {
    setPresetMessage('error', '请先输入别名')
    return
  }

  const nextPresets = categoryPresets.value.map((preset) => {
    if (preset.id !== presetId) {
      return preset
    }

    // 别名增量写入按集合去重，避免同一类别出现重复别名。
    const aliasSet = new Set(preset.aliases)
    for (const alias of aliasesToAdd) {
      aliasSet.add(alias)
    }
    return {
      ...preset,
      aliases: [...aliasSet],
    }
  })

  persistPresets(nextPresets, '别名已添加')
  aliasDraftMap[presetId] = ''
}

function handleDeleteAlias(presetId, aliasToDelete) {
  const nextPresets = categoryPresets.value.map((preset) => {
    if (preset.id !== presetId) {
      return preset
    }
    return {
      ...preset,
      aliases: preset.aliases.filter((alias) => alias !== aliasToDelete),
    }
  })
  persistPresets(nextPresets, '别名已删除')
}
</script>

<template>
  <section class="preset-shell">
    <div class="hero">
      <p class="hero-tag">AI 记账</p>
      <h1 class="hero-title">类别预设</h1>
      <p class="hero-subtitle">维护标准类别与别名，提升识别后的自动归类准确率</p>
    </div>

    <q-card flat bordered class="section-card">
      <q-card-section class="section-title">类别预设管理</q-card-section>
      <q-separator />
      <q-card-section class="section-body">
        <div class="preset-create-row">
          <q-input v-model="newPresetName" filled label="新增类别" />
          <q-input v-model="newPresetAliases" filled label="别名（逗号分隔）" />
          <q-btn unelevated color="secondary" no-caps label="添加类别" @click="handleAddPreset" />
        </div>

        <q-banner
          v-if="presetMessage.text"
          dense
          rounded
          :class="presetMessage.type === 'error' ? 'bg-negative text-white' : 'bg-positive text-white'"
        >
          {{ presetMessage.text }}
        </q-banner>

        <q-list bordered separator class="rounded-borders bg-white">
          <q-item v-for="preset in categoryPresets" :key="preset.id">
            <q-item-section>
              <div class="preset-name-row">
                <span class="preset-name">{{ preset.name }}</span>
                <q-chip
                  v-for="alias in preset.aliases"
                  :key="`${preset.id}-${alias}`"
                  removable
                  dense
                  color="teal-1"
                  text-color="teal-10"
                  @remove="handleDeleteAlias(preset.id, alias)"
                >
                  {{ alias }}
                </q-chip>
              </div>

              <div class="alias-row">
                <q-input
                  v-model="aliasDraftMap[preset.id]"
                  dense
                  filled
                  label="新增别名（逗号分隔）"
                  @keyup.enter="handleAddAlias(preset.id)"
                />
                <q-btn dense unelevated color="secondary" no-caps label="添加别名" @click="handleAddAlias(preset.id)" />
              </div>
            </q-item-section>

            <q-item-section side>
              <q-btn flat dense color="negative" icon="delete" @click="handleDeletePreset(preset.id)" />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>
    </q-card>
  </section>
</template>

<style scoped>
.preset-shell {
  width: min(100%, 1000px);
  display: grid;
  gap: 1rem;
}

.hero {
  text-align: center;
  display: grid;
  gap: 0.35rem;
}

.hero-tag {
  color: #0e7490;
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}

.hero-title {
  margin: 0;
  font-size: clamp(1.5rem, 2.6vw, 2rem);
  color: #0f172a;
  font-weight: 700;
}

.hero-subtitle {
  margin: 0;
  color: #475569;
  font-size: 0.94rem;
}

.section-card {
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(10px);
}

.section-title {
  font-weight: 700;
  color: #0f172a;
}

.section-body {
  display: grid;
  gap: 0.8rem;
}

.preset-create-row {
  display: grid;
  grid-template-columns: minmax(150px, 0.8fr) 1fr auto;
  gap: 0.55rem;
}

.preset-name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.preset-name {
  font-weight: 700;
  color: #0f172a;
}

.alias-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.45rem;
  margin-top: 0.35rem;
}

@media (max-width: 760px) {
  .preset-create-row {
    grid-template-columns: 1fr;
  }

  .alias-row {
    grid-template-columns: 1fr;
  }
}
</style>
