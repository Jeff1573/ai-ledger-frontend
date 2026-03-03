<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { fetchModelList, testConnectivity } from '../services/aiProviders'
import { DEFAULT_AI_CONFIG, PROVIDER_DEFAULTS, loadAIConfig, saveAIConfig } from '../services/storage'

const $q = useQuasar()
const emit = defineEmits(['config-saved'])

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
]

const PROVIDER_IDS = PROVIDER_OPTIONS.map((item) => item.value)

/**
 * 去重并清洗模型名列表。
 *
 * @param {unknown} rawList 原始模型列表。
 * @returns {string[]} 清洗后的模型名数组。
 */
function dedupeModelList(rawList) {
  if (!Array.isArray(rawList)) {
    return []
  }

  const modelSet = new Set()
  const models = []
  for (const item of rawList) {
    if (typeof item !== 'string') {
      continue
    }
    const modelName = item.trim()
    if (!modelName || modelSet.has(modelName)) {
      continue
    }
    modelSet.add(modelName)
    models.push(modelName)
  }

  return models
}

/**
 * 深拷贝并归一化各 Provider 的模型状态。
 *
 * @param {Record<string, {currentModel?: string, models?: string[]}>} [providerModels=DEFAULT_AI_CONFIG.providerModels]
 * 原始 providerModels。
 * @returns {Record<string, {currentModel: string, models: string[]}>} 归一化后的 providerModels。
 */
function cloneProviderModels(providerModels = DEFAULT_AI_CONFIG.providerModels) {
  const nextProviderModels = {}
  for (const providerId of PROVIDER_IDS) {
    const currentState = providerModels?.[providerId] || { currentModel: '', models: [] }
    nextProviderModels[providerId] = {
      currentModel:
        typeof currentState.currentModel === 'string' ? currentState.currentModel.trim() : '',
      models: dedupeModelList(currentState.models),
    }
  }
  return nextProviderModels
}

const form = reactive({
  provider: DEFAULT_AI_CONFIG.provider,
  baseURL: DEFAULT_AI_CONFIG.baseURL,
  token: DEFAULT_AI_CONFIG.token,
  providerModels: cloneProviderModels(DEFAULT_AI_CONFIG.providerModels),
})

const manualModelInput = ref('')
const fetchedModels = ref([])
const expandedGroups = ref({})
const isTokenVisible = ref(false)
const isFetchingModels = ref(false)
const testingModelName = ref('')
const isModelDialogVisible = ref(false)
const modelMessage = ref({ type: '', text: '' })
const dialogMessage = ref({ type: '', text: '' })
const saveMessage = ref({ type: '', text: '' })

const activeProviderState = computed(() => form.providerModels[form.provider])
const activeModels = computed(() => activeProviderState.value.models)
const activeCurrentModel = computed(() => activeProviderState.value.currentModel)

// 统一反馈样式映射，避免模板层重复写分支。
const FEEDBACK_CLASS_MAP = {
  success: 'bg-positive text-white',
  error: 'bg-negative text-white',
}

// 根据模型命名前缀进行分组，提升弹窗中大列表的可读性。
const groupedFetchedModels = computed(() => {
  const groupMap = new Map()
  for (const modelName of fetchedModels.value) {
    const groupName = deriveGroupName(modelName)
    if (!groupMap.has(groupName)) {
      groupMap.set(groupName, [])
    }
    groupMap.get(groupName).push(modelName)
  }

  return Array.from(groupMap.entries()).map(([groupName, models]) => ({
    groupName,
    models,
  }))
})

const isFormValid = computed(() => validateRequiredFields(true).length === 0)

onMounted(() => {
  const savedConfig = loadAIConfig()
  applyFormConfig(savedConfig)
})

watch(
  () => groupedFetchedModels.value,
  (groups) => {
    const nextExpanded = {}
    for (const group of groups) {
      nextExpanded[group.groupName] = expandedGroups.value[group.groupName] ?? true
    }
    expandedGroups.value = nextExpanded
  },
  { immediate: true },
)

watch(
  () => form.provider,
  (nextProvider, previousProvider) => {
    const previousDefault = PROVIDER_DEFAULTS[previousProvider]?.baseURL
    if (!form.baseURL || form.baseURL === previousDefault) {
      form.baseURL = PROVIDER_DEFAULTS[nextProvider].baseURL
    }

    // Provider 切换后重置模型获取状态，避免展示旧 Provider 的结果。
    fetchedModels.value = []
    expandedGroups.value = {}
    isModelDialogVisible.value = false
    manualModelInput.value = ''
    modelMessage.value = { type: '', text: '' }
    dialogMessage.value = { type: '', text: '' }
    testingModelName.value = ''
  },
)

/**
 * 将持久化配置回填到表单状态。
 *
 * @param {{provider: string, baseURL: string, token: string, providerModels: object}} config 配置对象。
 * @returns {void} 无返回值。
 */
function applyFormConfig(config) {
  // 统一走该入口回填表单，避免局部赋值导致 providerModels 状态不一致。
  form.provider = config.provider
  form.baseURL = config.baseURL
  form.token = config.token
  form.providerModels = cloneProviderModels(config.providerModels)
}

/**
 * 统一设置反馈消息对象。
 *
 * @param {{value: {type: string, text: string}}} targetRef 目标消息引用。
 * @param {string} type 消息类型。
 * @param {string} text 消息文本。
 * @returns {void} 无返回值。
 */
function setFeedback(targetRef, type, text) {
  targetRef.value = { type, text }
}

/**
 * 校验并规范化 URL。
 *
 * @param {string} urlText URL 文本。
 * @returns {URL} 解析后的 URL 对象。
 * @throws {Error} 协议不合法时抛出异常。
 */
function normalizeURL(urlText) {
  const parsed = new URL(urlText)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('baseURL 仅支持 http 或 https 协议')
  }
  return parsed
}

/**
 * 校验当前表单必填项。
 *
 * @param {boolean} requireModel 是否要求必须选中模型。
 * @returns {string[]} 错误消息列表；空数组表示校验通过。
 */
function validateRequiredFields(requireModel) {
  const errors = []
  if (!form.baseURL.trim()) {
    errors.push('请先填写 baseURL')
  } else {
    try {
      normalizeURL(form.baseURL.trim())
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'baseURL 格式不正确')
    }
  }

  if (!form.token.trim()) {
    errors.push('请先填写 token')
  }

  if (requireModel && !activeCurrentModel.value.trim()) {
    errors.push('请先添加并设置当前使用模型')
  }

  return errors
}

/**
 * 清洗 providerModels，保证 currentModel 与 models 一致。
 *
 * @param {Record<string, {currentModel?: string, models?: string[]}>} providerModels 原始 providerModels。
 * @returns {Record<string, {currentModel: string, models: string[]}>} 清洗后的 providerModels。
 */
function sanitizeProviderModels(providerModels) {
  const nextProviderModels = {}

  // 保存前统一清洗，确保 currentModel 与模型列表状态一致。
  for (const providerId of PROVIDER_IDS) {
    const providerState = providerModels[providerId] || { currentModel: '', models: [] }
    const models = dedupeModelList(providerState.models)
    let currentModel =
      typeof providerState.currentModel === 'string' ? providerState.currentModel.trim() : ''

    if (!currentModel && models.length > 0) {
      currentModel = models[0]
    }
    if (currentModel && !models.includes(currentModel)) {
      currentModel = models[0] || ''
    }

    nextProviderModels[providerId] = {
      currentModel,
      models,
    }
  }

  return nextProviderModels
}

/**
 * 生成可持久化的配置对象。
 *
 * @returns {{provider: string, baseURL: string, token: string, providerModels: object}} 配置对象。
 */
function buildSanitizedConfig() {
  return {
    provider: form.provider,
    baseURL: form.baseURL.trim(),
    token: form.token.trim(),
    providerModels: sanitizeProviderModels(form.providerModels),
  }
}

/**
 * 构建连通性测试与模型拉取所需配置。
 *
 * @param {string} [modelName=activeCurrentModel.value.trim()] 模型名称。
 * @returns {{provider: string, baseURL: string, token: string, model: string}} 连通性配置。
 */
function buildConnectivityConfig(modelName = activeCurrentModel.value.trim()) {
  return {
    provider: form.provider,
    baseURL: form.baseURL.trim(),
    token: form.token.trim(),
    model: modelName,
  }
}

/**
 * 根据模型名推导分组名。
 *
 * @param {string} modelName 模型名称。
 * @returns {string} 分组名称。
 */
function deriveGroupName(modelName) {
  // 以“前两段前缀”分组，兼顾可读性与不同模型家族的聚合效果。
  const parts = modelName
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`
  }
  return parts[0] || modelName
}

/**
 * 向当前 Provider 模型列表添加模型，并按需设置为当前模型。
 *
 * @param {string} modelName 模型名称。
 * @param {{setAsCurrent?: boolean}} [options={}] 添加选项。
 * @returns {{added: boolean, existed: boolean, modelName: string}} 添加结果。
 */
function addModelToActive(modelName, { setAsCurrent = false } = {}) {
  const normalizedName = typeof modelName === 'string' ? modelName.trim() : ''
  if (!normalizedName) {
    return { added: false, existed: false, modelName: '' }
  }

  const providerState = activeProviderState.value
  const existed = providerState.models.includes(normalizedName)
  if (!existed) {
    providerState.models.push(normalizedName)
  }

  if (setAsCurrent || !providerState.currentModel) {
    providerState.currentModel = normalizedName
  }

  return {
    added: !existed,
    existed,
    modelName: normalizedName,
  }
}

/**
 * 从当前 Provider 模型列表删除指定模型。
 *
 * @param {string} modelName 模型名称。
 * @returns {{removed: boolean, removedCurrent: boolean, nextCurrent: string}} 删除结果。
 */
function removeModelFromActive(modelName) {
  const providerState = activeProviderState.value
  const index = providerState.models.indexOf(modelName)
  if (index === -1) {
    return {
      removed: false,
      removedCurrent: false,
      nextCurrent: providerState.currentModel,
    }
  }

  const removedCurrent = providerState.currentModel === modelName
  providerState.models.splice(index, 1)

  if (removedCurrent) {
    providerState.currentModel = providerState.models[0] || ''
  }
  if (!providerState.models.length) {
    providerState.currentModel = ''
  }

  return {
    removed: true,
    removedCurrent,
    nextCurrent: providerState.currentModel,
  }
}

/**
 * 判断模型是否已在当前 Provider 列表中。
 *
 * @param {string} modelName 模型名称。
 * @returns {boolean} 是否已选中。
 */
function isModelSelected(modelName) {
  return activeModels.value.includes(modelName)
}

/**
 * 判断分组内模型是否已全部选中。
 *
 * @param {string[]} groupModels 分组模型列表。
 * @returns {boolean} 是否全部选中。
 */
function areAllGroupModelsSelected(groupModels) {
  if (!groupModels.length) {
    return false
  }
  return groupModels.every((modelName) => isModelSelected(modelName))
}

/**
 * 更新分组展开状态。
 *
 * @param {string} groupName 分组名。
 * @param {boolean} isExpanded 是否展开。
 * @returns {void} 无返回值。
 */
function updateGroupExpand(groupName, isExpanded) {
  expandedGroups.value[groupName] = isExpanded
}

/**
 * 关闭模型选择弹窗。
 *
 * @returns {void} 无返回值。
 */
function closeModelDialog() {
  isModelDialogVisible.value = false
}

/**
 * 解析反馈类型对应的样式类名。
 *
 * @param {string} type 反馈类型。
 * @returns {string} 对应样式类名。
 */
function resolveFeedbackClass(type) {
  return FEEDBACK_CLASS_MAP[type] || 'bg-grey-2 text-grey-8'
}

/**
 * 拉取当前 Provider 的模型列表并更新弹窗数据。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleFetchModels() {
  const errors = validateRequiredFields(false)
  if (errors.length > 0) {
    setFeedback(modelMessage, 'error', errors[0])
    return
  }

  isFetchingModels.value = true
  setFeedback(modelMessage, '', '')
  setFeedback(dialogMessage, '', '')

  const result = await fetchModelList(buildConnectivityConfig())
  if (!result.ok) {
    setFeedback(modelMessage, 'error', result.error || '模型列表获取失败')
    isFetchingModels.value = false
    return
  }

  fetchedModels.value = result.models
  // 拉取成功即打开选择弹窗，减少用户在“已获取但未展示”状态下的困惑。
  isModelDialogVisible.value = true

  if (result.models.length > 0) {
    setFeedback(dialogMessage, 'success', `模型列表获取成功，共 ${result.models.length} 个`)
    setFeedback(modelMessage, 'success', `模型列表获取成功，共 ${result.models.length} 个`)
  } else {
    setFeedback(dialogMessage, 'error', '未获取到可用模型，请手动添加')
    setFeedback(modelMessage, 'error', '未获取到可用模型，请手动添加')
  }

  isFetchingModels.value = false
}

/**
 * 处理手动添加模型动作。
 *
 * @returns {void} 无返回值。
 */
function handleManualAddModel() {
  const result = addModelToActive(manualModelInput.value, { setAsCurrent: true })
  if (!result.modelName) {
    setFeedback(modelMessage, 'error', '请先输入模型名称')
    return
  }

  manualModelInput.value = ''
  if (result.added) {
    setFeedback(modelMessage, 'success', `模型 ${result.modelName} 已添加并设为当前使用`)
    return
  }

  setFeedback(modelMessage, 'success', `模型 ${result.modelName} 已存在，已切换为当前使用`)
}

/**
 * 将指定模型设为当前使用模型。
 *
 * @param {string} modelName 模型名称。
 * @returns {void} 无返回值。
 */
function handleUseModel(modelName) {
  if (!isModelSelected(modelName)) {
    return
  }

  activeProviderState.value.currentModel = modelName
  setFeedback(modelMessage, 'success', `当前使用模型已切换为 ${modelName}`)
}

/**
 * 删除指定模型并更新提示信息。
 *
 * @param {string} modelName 模型名称。
 * @returns {void} 无返回值。
 */
function handleDeleteModel(modelName) {
  const result = removeModelFromActive(modelName)
  if (!result.removed) {
    return
  }

  if (result.nextCurrent) {
    setFeedback(modelMessage, 'success', `模型 ${modelName} 已删除，当前使用 ${result.nextCurrent}`)
    return
  }

  setFeedback(modelMessage, 'success', `模型 ${modelName} 已删除，当前无可用模型`)
}

/**
 * 在弹窗中切换单个模型的选中状态。
 *
 * @param {string} modelName 模型名称。
 * @returns {void} 无返回值。
 */
function toggleModelFromDialog(modelName) {
  if (isModelSelected(modelName)) {
    const result = removeModelFromActive(modelName)
    if (!result.removed) {
      return
    }

    if (result.nextCurrent) {
      setFeedback(dialogMessage, 'success', `已取消 ${modelName}，当前使用 ${result.nextCurrent}`)
      return
    }

    setFeedback(dialogMessage, 'success', `已取消 ${modelName}，当前无可用模型`)
    return
  }

  const result = addModelToActive(modelName, { setAsCurrent: false })
  if (result.added) {
    setFeedback(dialogMessage, 'success', `已添加 ${result.modelName}`)
    return
  }

  setFeedback(dialogMessage, 'success', `${result.modelName} 已在模型列表中`)
}

/**
 * 批量切换分组模型的选中状态。
 *
 * @param {string[]} groupModels 分组模型列表。
 * @returns {void} 无返回值。
 */
function toggleGroupModels(groupModels) {
  if (!groupModels.length) {
    return
  }

  // 分组操作遵循“全选则全删，否则全加”，保证一次点击行为稳定可预期。
  if (areAllGroupModelsSelected(groupModels)) {
    let removedCount = 0
    for (const modelName of groupModels) {
      const result = removeModelFromActive(modelName)
      if (result.removed) {
        removedCount += 1
      }
    }

    if (activeCurrentModel.value) {
      setFeedback(
        dialogMessage,
        'success',
        `已取消 ${removedCount} 个模型，当前使用 ${activeCurrentModel.value}`,
      )
      return
    }

    setFeedback(dialogMessage, 'success', `已取消 ${removedCount} 个模型，当前无可用模型`)
    return
  }

  let addedCount = 0
  for (const modelName of groupModels) {
    const result = addModelToActive(modelName, { setAsCurrent: false })
    if (result.added) {
      addedCount += 1
    }
  }

  if (addedCount === 0) {
    setFeedback(dialogMessage, 'success', '该分组模型已全部在模型列表中')
    return
  }

  setFeedback(dialogMessage, 'success', `已添加 ${addedCount} 个模型`)
}

/**
 * 校验并保存配置到本地存储。
 *
 * @returns {void} 无返回值。
 */
function handleSave() {
  const errors = validateRequiredFields(true)
  if (errors.length > 0) {
    setFeedback(saveMessage, 'error', errors[0])
    return
  }

  try {
    const persisted = saveAIConfig(buildSanitizedConfig())
    applyFormConfig(persisted)
    // 配置保存后向父层广播，确保主页状态可实时刷新。
    emit('config-saved', persisted)
    setFeedback(saveMessage, 'success', '配置已保存到本地浏览器')
  } catch (error) {
    const message = error instanceof Error ? error.message : '配置保存失败'
    setFeedback(saveMessage, 'error', message)
  }
}

/**
 * 统一展示模型连通性测试结果的顶部通知。
 *
 * @param {{ok: boolean, message: string, latencyMs: number}} result 测试结果。
 * @param {string} modelName 模型名称。
 * @returns {void} 无返回值。
 */
function showModelTestTopTip(result, modelName) {
  // 统一通过顶部提示展示模型测试结果，避免挤占配置卡片的纵向空间。
  $q.notify({
    position: 'top',
    timeout: 2200,
    progress: true,
    color: result.ok ? 'positive' : 'negative',
    textColor: 'white',
    icon: result.ok ? 'check_circle' : 'warning',
    message: `${result.ok ? '测试成功' : '测试失败'}：${modelName}`,
    caption: `${result.message} · 耗时 ${result.latencyMs}ms`,
  })
}

/**
 * 判断指定模型当前是否处于测试中。
 *
 * @param {string} modelName 模型名称。
 * @returns {boolean} 是否测试中。
 */
function isModelTesting(modelName) {
  return testingModelName.value === modelName
}

/**
 * 执行单模型连通性测试。
 *
 * @param {string} modelName 模型名称。
 * @returns {Promise<void>} 无返回值。
 */
async function handleTestModelConnectivity(modelName) {
  const normalizedModel = typeof modelName === 'string' ? modelName.trim() : ''
  if (!normalizedModel) {
    return
  }

  const errors = validateRequiredFields(false)
  if (errors.length > 0) {
    showModelTestTopTip(
      {
        ok: false,
        message: errors[0],
        latencyMs: 0,
      },
      normalizedModel,
    )
    return
  }

  // 同一时刻只允许一个模型测试，避免重复点击造成并发请求堆叠。
  testingModelName.value = normalizedModel
  try {
    const result = await testConnectivity(buildConnectivityConfig(normalizedModel))
    showModelTestTopTip(result, normalizedModel)
  } finally {
    testingModelName.value = ''
  }
}
</script>

<template>
  <section class="config-shell">
    <div class="hero">
      <p class="hero-tag">AI 记账</p>
      <h1 class="hero-title">AI 服务配置</h1>
      <p class="hero-subtitle">配置可用的 AI Provider、模型和连通性测试</p>
    </div>

    <q-card class="config-card" flat bordered>
      <q-card-section class="field-group">
        <div class="field-label">服务商</div>
        <q-btn-toggle
          v-model="form.provider"
          :options="PROVIDER_OPTIONS"
          toggle-color="primary"
          unelevated
          no-caps
          class="provider-toggle"
        />
      </q-card-section>

      <q-separator />

      <q-card-section class="field-group">
        <q-input
          v-model="form.baseURL"
          type="url"
          label="Base URL"
          autocomplete="off"
          placeholder="https://api.openai.com/v1"
          filled
          stack-label
        />
      </q-card-section>

      <q-separator />

      <q-card-section class="field-group">
        <q-input
          v-model="form.token"
          :type="isTokenVisible ? 'text' : 'password'"
          label="Token"
          autocomplete="off"
          placeholder="请输入 API Token"
          filled
          stack-label
        >
          <template #append>
            <q-btn
              flat
              dense
              no-caps
              size="sm"
              :label="isTokenVisible ? '隐藏' : '显示'"
              @click="isTokenVisible = !isTokenVisible"
            />
          </template>
        </q-input>
      </q-card-section>

      <q-separator />

      <q-card-section class="field-group">
        <div class="field-inline">
          <div class="field-label">模型</div>
          <q-btn
            unelevated
            color="primary"
            icon="sync"
            :loading="isFetchingModels"
            :label="isFetchingModels ? '获取中...' : '获取模型列表'"
            @click="handleFetchModels"
          />
        </div>

        <div class="manual-row">
          <q-input
            v-model="manualModelInput"
            class="manual-input"
            type="text"
            autocomplete="off"
            placeholder="输入模型后点击“添加并使用”，例如：gemini-3-flash"
            filled
            @keyup.enter="handleManualAddModel"
          />
          <q-btn unelevated color="secondary" no-caps label="添加并使用" @click="handleManualAddModel" />
        </div>

        <q-list v-if="activeModels.length > 0" bordered separator class="rounded-borders bg-white">
          <q-item v-for="modelName in activeModels" :key="modelName">
            <q-item-section>
              <div class="row items-center q-gutter-sm model-row-wrap">
                <span class="model-name">{{ modelName }}</span>
                <q-chip
                  v-if="modelName === activeCurrentModel"
                  dense
                  size="sm"
                  color="info"
                  text-color="white"
                  label="当前使用"
                />
              </div>
            </q-item-section>

            <q-item-section side>
              <div class="row q-gutter-xs no-wrap">
                <q-btn
                  dense
                  outline
                  color="secondary"
                  label="测试"
                  :loading="isModelTesting(modelName)"
                  :disable="Boolean(testingModelName) && !isModelTesting(modelName)"
                  @click="handleTestModelConnectivity(modelName)"
                />
                <q-btn
                  dense
                  unelevated
                  color="secondary"
                  label="使用"
                  :disable="modelName === activeCurrentModel"
                  @click="handleUseModel(modelName)"
                />
                <q-btn
                  dense
                  unelevated
                  color="negative"
                  label="删除"
                  @click="handleDeleteModel(modelName)"
                />
              </div>
            </q-item-section>
          </q-item>
        </q-list>

        <q-banner v-else rounded class="bg-grey-2 text-grey-8">
          暂无已添加模型，请手动添加或从弹窗中选择。
        </q-banner>

        <q-banner
          v-if="modelMessage.text"
          dense
          rounded
          class="feedback-banner"
          :class="resolveFeedbackClass(modelMessage.type)"
        >
          {{ modelMessage.text }}
        </q-banner>
      </q-card-section>

      <q-separator />

      <q-card-actions class="action-row">
        <q-btn
          unelevated
          color="primary"
          no-caps
          label="保存配置"
          :disable="!isFormValid"
          @click="handleSave"
        />
      </q-card-actions>

      <q-card-section class="field-group">
        <q-banner
          v-if="saveMessage.text"
          dense
          rounded
          class="feedback-banner"
          :class="resolveFeedbackClass(saveMessage.type)"
        >
          {{ saveMessage.text }}
        </q-banner>
      </q-card-section>
    </q-card>

    <q-dialog v-model="isModelDialogVisible">
      <q-card class="model-dialog">
        <q-card-section class="dialog-header">
          <div>
            <p class="text-h6 text-weight-bold">可用模型列表</p>
            <p class="text-caption text-grey-7">点击 + 添加，点击 - 取消，变更会立即同步到模型列表。</p>
          </div>
          <q-btn flat round dense icon="close" @click="closeModelDialog" />
        </q-card-section>

        <q-separator />

        <q-card-section class="dialog-body">
          <q-banner
            v-if="dialogMessage.text"
            dense
            rounded
            class="feedback-banner"
            :class="resolveFeedbackClass(dialogMessage.type)"
          >
            {{ dialogMessage.text }}
          </q-banner>

          <q-banner v-if="groupedFetchedModels.length === 0" rounded class="bg-grey-2 text-grey-8">
            未获取到可用模型，请手动添加。
          </q-banner>

          <q-list v-else bordered separator class="rounded-borders bg-white">
            <q-expansion-item
              v-for="group in groupedFetchedModels"
              :key="group.groupName"
              expand-separator
              :model-value="expandedGroups[group.groupName]"
              @update:model-value="(value) => updateGroupExpand(group.groupName, value)"
            >
              <template #header>
                <q-item-section>
                  <div class="row items-center q-gutter-sm no-wrap">
                    <span class="text-subtitle2 text-weight-bold">{{ group.groupName }}</span>
                    <q-badge color="info" text-color="white" :label="group.models.length" />
                  </div>
                </q-item-section>

                <q-item-section side>
                  <q-btn
                    flat
                    round
                    dense
                    :icon="areAllGroupModelsSelected(group.models) ? 'remove' : 'add'"
                    @click.stop="toggleGroupModels(group.models)"
                  />
                </q-item-section>
              </template>

              <q-list dense>
                <q-item v-for="modelName in group.models" :key="modelName">
                  <q-item-section>
                    <div class="row items-center q-gutter-sm model-row-wrap">
                      <span class="model-name">{{ modelName }}</span>
                      <q-chip
                        v-if="modelName === activeCurrentModel"
                        dense
                        size="sm"
                        color="info"
                        text-color="white"
                        label="当前使用"
                      />
                    </div>
                  </q-item-section>

                  <q-item-section side>
                    <q-btn
                      flat
                      round
                      dense
                      :icon="isModelSelected(modelName) ? 'remove' : 'add'"
                      @click="toggleModelFromDialog(modelName)"
                    />
                  </q-item-section>
                </q-item>
              </q-list>
            </q-expansion-item>
          </q-list>
        </q-card-section>
      </q-card>
    </q-dialog>
  </section>
</template>

<style scoped>
.config-shell {
  width: min(100%, 900px);
  display: grid;
  gap: 1rem;
}

.hero {
  text-align: center;
  display: grid;
  gap: 0.4rem;
}

.hero-tag {
  color: #0e7490;
  font-size: 0.82rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
}

.hero-title {
  font-size: clamp(1.45rem, 2.5vw, 1.9rem);
  color: #0f172a;
  font-weight: 700;
}

.hero-subtitle {
  color: #475569;
  font-size: 0.95rem;
}

.config-card {
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(12px);
  border-radius: 22px;
  box-shadow:
    0 18px 35px -30px rgba(2, 132, 199, 0.45),
    0 22px 40px -36px rgba(15, 23, 42, 0.95);
}

.field-group {
  display: grid;
  gap: 0.75rem;
}

.field-label {
  font-size: 0.92rem;
  color: #334155;
  font-weight: 600;
}

.field-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.provider-toggle {
  width: fit-content;
}

.manual-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.55rem;
}

.manual-input {
  min-width: 0;
}

.model-row-wrap {
  min-width: 0;
  flex-wrap: wrap;
}

.model-name {
  color: #0f172a;
  font-size: 0.92rem;
  font-weight: 600;
  word-break: break-all;
}

.feedback-banner p + p {
  margin-top: 0.2rem;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  padding-top: 0.95rem;
  padding-left: 1rem;
  padding-right: 1rem;
}

.model-dialog {
  width: min(920px, 96vw);
  max-height: 86vh;
  border-radius: 16px;
}

.dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
}

.dialog-body {
  display: grid;
  gap: 0.75rem;
  max-height: min(64vh, 580px);
  overflow: auto;
}

@media (max-width: 768px) {
  .config-card {
    border-radius: 18px;
  }

  .field-inline {
    flex-direction: column;
    align-items: flex-start;
  }

  .manual-row {
    grid-template-columns: 1fr;
  }

  .action-row {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .action-row .q-btn {
    width: 100%;
  }

  .model-dialog {
    width: min(96vw, 920px);
    max-height: 90vh;
  }
}
</style>
