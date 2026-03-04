<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { fetchModelList, testConnectivity } from '../services/aiProviders'
import { DEFAULT_AI_CONFIG, PROVIDER_DEFAULTS, loadAIConfig, saveAIConfig } from '../services/storage'

const $q = useQuasar()
const emit = defineEmits(['config-saved'])
// 默认配置名称前缀，用于新增配置时自动生成“配置 N”。
const PROFILE_NAME_PREFIX = '配置'

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

/**
 * 生成配置 ID。
 *
 * @returns {string} 配置 ID。
 */
function createProfileId() {
  const uuidFactory = globalThis.crypto?.randomUUID
  if (typeof uuidFactory === 'function') {
    return `ai-profile-${uuidFactory.call(globalThis.crypto)}`
  }
  return `ai-profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 创建空白 AI 配置项。
 *
 * @param {string} profileName 配置名称。
 * @returns {{
 *   id: string,
 *   name: string,
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: Record<string, {currentModel: string, models: string[]}>
 * }} 配置项。
 */
function createBlankProfile(profileName) {
  return {
    id: createProfileId(),
    name: profileName,
    provider: DEFAULT_AI_CONFIG.provider,
    baseURL: PROVIDER_DEFAULTS.openai.baseURL,
    token: '',
    providerModels: cloneProviderModels(DEFAULT_AI_CONFIG.providerModels),
  }
}

/**
 * 深拷贝配置项。
 *
 * @param {{
 *   id: string,
 *   name: string,
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: Record<string, {currentModel: string, models: string[]}>
 * }} profile 配置项。
 * @returns {{
 *   id: string,
 *   name: string,
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: Record<string, {currentModel: string, models: string[]}>
 * }} 深拷贝结果。
 */
function cloneProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider === 'anthropic' ? 'anthropic' : 'openai',
    baseURL: profile.baseURL,
    token: profile.token,
    providerModels: cloneProviderModels(profile.providerModels),
  }
}

/**
 * 归一化配置项。
 *
 * @param {any} profile 配置项。
 * @param {number} index 配置索引。
 * @returns {{
 *   id: string,
 *   name: string,
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: Record<string, {currentModel: string, models: string[]}>
 * }} 归一化配置项。
 */
function sanitizeProfile(profile, index) {
  const provider = profile?.provider === 'anthropic' ? 'anthropic' : 'openai'
  const profileName =
    typeof profile?.name === 'string' && profile.name.trim()
      ? profile.name.trim()
      : `${PROFILE_NAME_PREFIX} ${index + 1}`
  const profileId =
    typeof profile?.id === 'string' && profile.id.trim() ? profile.id.trim() : createProfileId()
  return {
    id: profileId,
    name: profileName,
    provider,
    baseURL:
      typeof profile?.baseURL === 'string' && profile.baseURL.trim()
        ? profile.baseURL.trim()
        : PROVIDER_DEFAULTS[provider].baseURL,
    token: typeof profile?.token === 'string' ? profile.token : '',
    providerModels: cloneProviderModels(profile?.providerModels),
  }
}

/**
 * 归一化配置项数组并确保 ID 唯一。
 *
 * @param {any[]} rawProfiles 原始配置项数组。
 * @returns {Array<ReturnType<typeof sanitizeProfile>>} 归一化后的配置项数组。
 */
function sanitizeProfiles(rawProfiles) {
  const normalizedProfiles = []
  const idSet = new Set()
  const sourceList = Array.isArray(rawProfiles) ? rawProfiles : []

  for (let index = 0; index < sourceList.length; index += 1) {
    const profile = sanitizeProfile(sourceList[index], index)
    let profileId = profile.id
    if (idSet.has(profileId)) {
      profileId = createProfileId()
      while (idSet.has(profileId)) {
        profileId = createProfileId()
      }
    }
    idSet.add(profileId)
    normalizedProfiles.push({
      ...profile,
      id: profileId,
    })
  }

  if (normalizedProfiles.length > 0) {
    return normalizedProfiles
  }

  return [createBlankProfile(`${PROFILE_NAME_PREFIX} 1`)]
}

/**
 * 将配置草稿序列化为稳定字符串，用于判断当前配置是否有未保存变更。
 *
 * @param {{
 *   name: string,
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: Record<string, {currentModel: string, models: string[]}>
 * }} profile 配置草稿。
 * @returns {string} 序列化结果。
 */
function serializeProfileDraft(profile) {
  return JSON.stringify({
    name: typeof profile.name === 'string' ? profile.name.trim() : '',
    provider: profile.provider === 'anthropic' ? 'anthropic' : 'openai',
    baseURL: typeof profile.baseURL === 'string' ? profile.baseURL.trim() : '',
    token: typeof profile.token === 'string' ? profile.token.trim() : '',
    providerModels: profile.providerModels,
  })
}

const profiles = ref([])
const activeProfileId = ref('')
const pendingSwitchProfileId = ref('')
const isSwitchDialogVisible = ref(false)

const form = reactive({
  profileName: '',
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

const profileOptions = computed(() =>
  profiles.value.map((profile) => ({
    value: profile.id,
    label: profile.name,
  })),
)

const activeProviderState = computed(() => form.providerModels[form.provider])
const activeModels = computed(() => activeProviderState.value.models)
const activeCurrentModel = computed(() => activeProviderState.value.currentModel)
const canDeleteProfile = computed(() => profiles.value.length > 1)
const activeProfile = computed(() =>
  profiles.value.find((profile) => profile.id === activeProfileId.value) || null,
)
const hasUnsavedChanges = computed(() => {
  if (!activeProfile.value) {
    return false
  }
  return (
    serializeProfileDraft(buildProfileDraftFromForm(activeProfile.value.id)) !==
    serializeProfileDraft(activeProfile.value)
  )
})

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
  applyConfigState(savedConfig)
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
 * 将持久化配置状态回填到页面。
 *
 * @param {{
 *   activeProfileId?: string,
 *   profiles?: any[]
 * }} config 配置状态。
 * @returns {void} 无返回值。
 */
function applyConfigState(config) {
  const normalizedProfiles = sanitizeProfiles(config?.profiles)
  profiles.value = normalizedProfiles.map((profile) => cloneProfile(profile))
  const matchedProfile = profiles.value.find((profile) => profile.id === config?.activeProfileId)
  const nextActiveProfile = matchedProfile || profiles.value[0]
  activeProfileId.value = nextActiveProfile.id
  applyFormProfile(nextActiveProfile)
}

/**
 * 将指定配置项回填到编辑表单。
 *
 * @param {ReturnType<typeof sanitizeProfile>} profile 配置项。
 * @returns {void} 无返回值。
 */
function applyFormProfile(profile) {
  form.profileName = profile.name
  form.provider = profile.provider
  form.baseURL = profile.baseURL
  form.token = profile.token
  form.providerModels = cloneProviderModels(profile.providerModels)
}

/**
 * 生成下一个可用默认配置名称（配置 N）。
 *
 * @returns {string} 配置名称。
 */
function buildNextProfileName() {
  const usedNameSet = new Set(
    profiles.value.map((profile) => profile.name.trim().toLowerCase()).filter(Boolean),
  )
  let index = 1
  while (usedNameSet.has(`${PROFILE_NAME_PREFIX} ${index}`.toLowerCase())) {
    index += 1
  }
  return `${PROFILE_NAME_PREFIX} ${index}`
}

/**
 * 构建用于“未保存变更检测”的表单快照。
 *
 * 该快照仅做轻量归一化（trim + provider 规范化），不做默认值回填，
 * 以确保“清空输入”这类操作仍能被判定为真实改动。
 *
 * @param {string} profileId 配置 ID。
 * @returns {{
 *   id: string,
 *   name: string,
 *   provider: 'openai' | 'anthropic',
 *   baseURL: string,
 *   token: string,
 *   providerModels: Record<string, {currentModel: string, models: string[]}>
 * }} 用于比对的草稿快照。
 */
function buildProfileDraftFromForm(profileId) {
  return {
    id: profileId,
    name: typeof form.profileName === 'string' ? form.profileName.trim() : '',
    provider: form.provider === 'anthropic' ? 'anthropic' : 'openai',
    baseURL: typeof form.baseURL === 'string' ? form.baseURL.trim() : '',
    token: typeof form.token === 'string' ? form.token.trim() : '',
    providerModels: sanitizeProviderModels(form.providerModels),
  }
}

/**
 * 将表单内容映射为配置项。
 *
 * @param {string} profileId 配置 ID。
 * @returns {ReturnType<typeof sanitizeProfile>} 配置项草稿。
 */
function buildProfileFromForm(profileId) {
  return sanitizeProfile(
    buildProfileDraftFromForm(profileId),
    0,
  )
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
  const normalizedProfileName = form.profileName.trim()
  if (!normalizedProfileName) {
    errors.push('请先填写配置名称')
  } else {
    const duplicate = profiles.value.some(
      (profile) =>
        profile.id !== activeProfileId.value &&
        profile.name.trim().toLowerCase() === normalizedProfileName.toLowerCase(),
    )
    if (duplicate) {
      errors.push('配置名称重复，请更换名称')
    }
  }

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
  // 仅基于当前表单构建待保存快照，不在保存前改写内存基线，
  // 以避免 save 失败时“未保存变更”被误判为已保存。
  const draftProfiles = profiles.value.map((profile) =>
    profile.id === activeProfileId.value ? buildProfileFromForm(profile.id) : cloneProfile(profile),
  )
  const normalizedProfiles = sanitizeProfiles(draftProfiles)
  const normalizedActiveProfile =
    normalizedProfiles.find((profile) => profile.id === activeProfileId.value) || normalizedProfiles[0]

  return {
    activeProfileId: normalizedActiveProfile.id,
    profiles: normalizedProfiles.map((profile) => cloneProfile(profile)),
    provider: normalizedActiveProfile.provider,
    baseURL: normalizedActiveProfile.baseURL.trim(),
    token: normalizedActiveProfile.token.trim(),
    providerModels: cloneProviderModels(normalizedActiveProfile.providerModels),
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
 * 请求切换到目标配置；若当前有未保存改动则弹窗确认。
 *
 * @param {string} nextProfileId 目标配置 ID。
 * @returns {void} 无返回值。
 */
function handleProfileSelectChange(nextProfileId) {
  if (!nextProfileId || nextProfileId === activeProfileId.value) {
    return
  }

  if (hasUnsavedChanges.value) {
    pendingSwitchProfileId.value = nextProfileId
    isSwitchDialogVisible.value = true
    return
  }

  switchToProfile(nextProfileId)
}

/**
 * 直接切换到目标配置并回填表单。
 *
 * @param {string} profileId 配置 ID。
 * @returns {void} 无返回值。
 */
function switchToProfile(profileId) {
  const matchedProfile = profiles.value.find((profile) => profile.id === profileId)
  if (!matchedProfile) {
    return
  }

  activeProfileId.value = matchedProfile.id
  applyFormProfile(matchedProfile)
  saveMessage.value = { type: '', text: '' }
}

/**
 * 新增空白配置并切换到该配置。
 *
 * @returns {void} 无返回值。
 */
function handleAddProfile() {
  if (hasUnsavedChanges.value) {
    setFeedback(saveMessage, 'error', '当前配置有未保存修改，请先保存或放弃后再新增')
    return
  }

  const newProfile = createBlankProfile(buildNextProfileName())
  profiles.value = [...profiles.value, newProfile]
  switchToProfile(newProfile.id)
  setFeedback(saveMessage, 'success', `已新增 ${newProfile.name}，请完善并保存`)
}

/**
 * 删除当前配置并切换到剩余配置。
 *
 * @returns {void} 无返回值。
 */
function handleDeleteCurrentProfile() {
  if (!canDeleteProfile.value) {
    setFeedback(saveMessage, 'error', '至少保留一个配置，无法继续删除')
    return
  }
  if (hasUnsavedChanges.value) {
    setFeedback(saveMessage, 'error', '当前配置有未保存修改，请先保存或放弃后再删除')
    return
  }

  const currentProfile = activeProfile.value
  if (!currentProfile) {
    return
  }

  const remainedProfiles = profiles.value.filter((profile) => profile.id !== currentProfile.id)
  profiles.value = remainedProfiles
  switchToProfile(remainedProfiles[0].id)
  setFeedback(saveMessage, 'success', `已删除 ${currentProfile.name}，请点击保存配置生效`)
}

/**
 * 取消切换配置操作。
 *
 * @returns {void} 无返回值。
 */
function handleCancelProfileSwitch() {
  isSwitchDialogVisible.value = false
  pendingSwitchProfileId.value = ''
}

/**
 * 放弃当前修改并切换配置。
 *
 * @returns {void} 无返回值。
 */
function handleDiscardAndSwitchProfile() {
  const nextProfileId = pendingSwitchProfileId.value
  handleCancelProfileSwitch()
  switchToProfile(nextProfileId)
}

/**
 * 先保存当前配置，再切换到目标配置。
 *
 * @returns {void} 无返回值。
 */
function handleSaveAndSwitchProfile() {
  const nextProfileId = pendingSwitchProfileId.value
  const saved = handleSave({ skipSuccessMessage: true })
  if (!saved) {
    return
  }
  handleCancelProfileSwitch()
  switchToProfile(nextProfileId)
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
 * @param {{skipSuccessMessage?: boolean}} [options={}] 保存选项。
 * @returns {boolean} 是否保存成功。
 */
function handleSave(options = {}) {
  const skipSuccessMessage = Boolean(options.skipSuccessMessage)
  const errors = validateRequiredFields(true)
  if (errors.length > 0) {
    setFeedback(saveMessage, 'error', errors[0])
    return false
  }

  try {
    const persisted = saveAIConfig(buildSanitizedConfig())
    applyConfigState(persisted)
    // 配置保存后向父层广播，确保主页状态可实时刷新。
    emit('config-saved', persisted)
    if (!skipSuccessMessage) {
      setFeedback(saveMessage, 'success', '配置已保存')
    }
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : '配置保存失败'
    setFeedback(saveMessage, 'error', message)
    return false
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
        <div class="field-inline">
          <div class="field-label">配置管理</div>
          <div class="row q-gutter-sm">
            <q-btn
              unelevated
              color="secondary"
              no-caps
              icon="add"
              label="新增配置"
              @click="handleAddProfile"
            />
            <q-btn
              flat
              color="negative"
              no-caps
              icon="delete"
              label="删除当前"
              :disable="!canDeleteProfile"
              @click="handleDeleteCurrentProfile"
            />
          </div>
        </div>

        <q-select
          :model-value="activeProfileId"
          :options="profileOptions"
          emit-value
          map-options
          filled
          label="当前配置"
          @update:model-value="handleProfileSelectChange"
        />

        <q-banner
          v-if="hasUnsavedChanges"
          dense
          rounded
          class="bg-orange-1 text-orange-10"
        >
          当前配置有未保存修改，切换前请先保存或选择放弃。
        </q-banner>
      </q-card-section>

      <q-separator />

      <q-card-section class="field-group">
        <q-input
          v-model="form.profileName"
          type="text"
          autocomplete="off"
          label="配置名称"
          placeholder="例如：工作账号、备用网关"
          filled
          stack-label
        />
      </q-card-section>

      <q-separator />

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

    <q-dialog v-model="isSwitchDialogVisible" persistent>
      <q-card class="switch-dialog">
        <q-card-section class="dialog-header">
          <div>
            <p class="text-h6 text-weight-bold">检测到未保存修改</p>
            <p class="text-caption text-grey-7">切换配置前请先选择保存或放弃当前修改。</p>
          </div>
        </q-card-section>

        <q-separator />

        <q-card-actions align="right" class="switch-actions">
          <q-btn flat no-caps color="grey-8" label="取消" @click="handleCancelProfileSwitch" />
          <q-btn
            flat
            no-caps
            color="negative"
            label="放弃并切换"
            @click="handleDiscardAndSwitchProfile"
          />
          <q-btn
            unelevated
            no-caps
            color="primary"
            label="保存并切换"
            @click="handleSaveAndSwitchProfile"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

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

.switch-dialog {
  width: min(480px, 94vw);
  border-radius: 14px;
}

.switch-actions {
  padding: 0.8rem 1rem 1rem;
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
