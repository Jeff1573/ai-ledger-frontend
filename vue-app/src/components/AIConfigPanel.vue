<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { fetchModelList, testConnectivity } from '../services/aiProviders'
import { DEFAULT_AI_CONFIG, PROVIDER_DEFAULTS, loadAIConfig, saveAIConfig } from '../services/storage'

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
]

const form = reactive({ ...DEFAULT_AI_CONFIG })
const modelOptions = ref([])
const isTokenVisible = ref(false)
const isFetchingModels = ref(false)
const isTesting = ref(false)
const modelMessage = ref({ type: '', text: '' })
const saveMessage = ref({ type: '', text: '' })
const testResult = ref(null)

const isFormValid = computed(() => validateRequiredFields(true).length === 0)

onMounted(() => {
  const savedConfig = loadAIConfig()
  Object.assign(form, savedConfig)
})

watch(
  () => form.provider,
  (nextProvider, previousProvider) => {
    const previousDefault = PROVIDER_DEFAULTS[previousProvider]?.baseURL
    if (!form.baseURL || form.baseURL === previousDefault) {
      form.baseURL = PROVIDER_DEFAULTS[nextProvider].baseURL
    }

    // Provider 切换后，模型列表可能失效，保留手动输入能力以避免阻塞用户流程。
    form.modelSource = 'manual'
    modelOptions.value = []
    modelMessage.value = { type: '', text: '' }
    testResult.value = null
  },
)

function setFeedback(targetRef, type, text) {
  targetRef.value = { type, text }
}

function normalizeURL(urlText) {
  const parsed = new URL(urlText)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('baseURL 仅支持 http 或 https 协议')
  }
  return parsed
}

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

  if (requireModel && !form.model.trim()) {
    errors.push('请先填写模型名称')
  }

  return errors
}

function buildSanitizedConfig() {
  // 统一在请求前做裁剪，避免校验通过但鉴权因空白字符失败。
  return {
    ...form,
    baseURL: form.baseURL.trim(),
    token: form.token.trim(),
    model: form.model.trim(),
  }
}

async function handleFetchModels() {
  const errors = validateRequiredFields(false)
  if (errors.length > 0) {
    setFeedback(modelMessage, 'error', errors[0])
    return
  }

  isFetchingModels.value = true
  setFeedback(modelMessage, '', '')

  const result = await fetchModelList(buildSanitizedConfig())
  if (!result.ok) {
    setFeedback(modelMessage, 'error', result.error || '模型列表获取失败')
    isFetchingModels.value = false
    return
  }

  modelOptions.value = result.models
  form.modelSource = 'list'

  if (!modelOptions.value.includes(form.model)) {
    form.model = modelOptions.value[0] || ''
  }

  setFeedback(modelMessage, 'success', `模型列表获取成功，共 ${modelOptions.value.length} 个`)
  isFetchingModels.value = false
}

function switchModelSource(source) {
  if (source === 'list' && modelOptions.value.length === 0) {
    return
  }
  form.modelSource = source

  if (source === 'list' && !modelOptions.value.includes(form.model)) {
    form.model = modelOptions.value[0] || ''
  }
}

function handleSave() {
  const errors = validateRequiredFields(true)
  if (errors.length > 0) {
    setFeedback(saveMessage, 'error', errors[0])
    return
  }

  try {
    const persisted = saveAIConfig(buildSanitizedConfig())
    Object.assign(form, persisted)
    setFeedback(saveMessage, 'success', '配置已保存到本地浏览器')
  } catch (error) {
    const message = error instanceof Error ? error.message : '配置保存失败'
    setFeedback(saveMessage, 'error', message)
  }
}

async function handleTestConnectivity() {
  const errors = validateRequiredFields(true)
  if (errors.length > 0) {
    testResult.value = {
      ok: false,
      message: errors[0],
      latencyMs: 0,
      provider: form.provider,
    }
    return
  }

  isTesting.value = true
  testResult.value = null

  testResult.value = await testConnectivity(buildSanitizedConfig())

  isTesting.value = false
}
</script>

<template>
  <section class="config-shell">
    <div class="hero">
      <p class="hero-tag">AI 记账</p>
      <h1>AI 服务配置</h1>
      <p class="hero-subtitle">配置可用的 AI Provider、模型和连通性测试</p>
    </div>

    <article class="config-card">
      <div class="field-group">
        <label class="field-label">服务商</label>
        <div class="segmented">
          <button
            v-for="item in PROVIDER_OPTIONS"
            :key="item.value"
            type="button"
            class="segmented-btn"
            :class="{ active: form.provider === item.value }"
            @click="form.provider = item.value"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <div class="field-group">
        <label class="field-label" for="base-url">Base URL</label>
        <input
          id="base-url"
          v-model="form.baseURL"
          class="field-control"
          type="url"
          autocomplete="off"
          placeholder="https://api.openai.com/v1"
        />
      </div>

      <div class="field-group">
        <label class="field-label" for="api-token">Token</label>
        <div class="token-wrapper">
          <input
            id="api-token"
            v-model="form.token"
            class="field-control token-input"
            :type="isTokenVisible ? 'text' : 'password'"
            autocomplete="off"
            placeholder="请输入 API Token"
          />
          <button type="button" class="ghost-btn token-toggle" @click="isTokenVisible = !isTokenVisible">
            {{ isTokenVisible ? '隐藏' : '显示' }}
          </button>
        </div>
      </div>

      <div class="field-group">
        <div class="field-inline">
          <label class="field-label" for="model-name">模型</label>
          <button
            type="button"
            class="ghost-btn"
            :disabled="isFetchingModels"
            @click="handleFetchModels"
          >
            {{ isFetchingModels ? '获取中...' : '获取模型列表' }}
          </button>
        </div>

        <div class="segmented model-source">
          <button
            type="button"
            class="segmented-btn"
            :class="{ active: form.modelSource === 'manual' }"
            @click="switchModelSource('manual')"
          >
            手动输入
          </button>
          <button
            type="button"
            class="segmented-btn"
            :class="{ active: form.modelSource === 'list' }"
            :disabled="modelOptions.length === 0"
            @click="switchModelSource('list')"
          >
            模型列表
          </button>
        </div>

        <input
          v-if="form.modelSource === 'manual'"
          id="model-name"
          v-model="form.model"
          class="field-control"
          type="text"
          autocomplete="off"
          placeholder="例如：gpt-4.1-mini / claude-3-5-sonnet-latest"
        />
        <select
          v-else
          id="model-name"
          v-model="form.model"
          class="field-control"
        >
          <option v-for="modelName in modelOptions" :key="modelName" :value="modelName">
            {{ modelName }}
          </option>
        </select>

        <p
          v-if="modelMessage.text"
          class="feedback-text"
          :class="{ success: modelMessage.type === 'success', error: modelMessage.type === 'error' }"
        >
          {{ modelMessage.text }}
        </p>
      </div>

      <div class="action-row">
        <button type="button" class="primary-btn" :disabled="!isFormValid" @click="handleSave">
          保存配置
        </button>
        <button type="button" class="secondary-btn" :disabled="isTesting" @click="handleTestConnectivity">
          {{ isTesting ? '测试中...' : '接口连通性测试' }}
        </button>
      </div>

      <p
        v-if="saveMessage.text"
        class="feedback-text"
        :class="{ success: saveMessage.type === 'success', error: saveMessage.type === 'error' }"
      >
        {{ saveMessage.text }}
      </p>

      <div v-if="testResult" class="test-panel" :class="{ ok: testResult.ok, fail: !testResult.ok }">
        <p class="test-title">{{ testResult.ok ? '连通性测试成功' : '连通性测试失败' }}</p>
        <p class="test-message">{{ testResult.message }}</p>
        <p class="test-meta">
          Provider: {{ testResult.provider }} · 耗时: {{ testResult.latencyMs }}ms
        </p>
      </div>
    </article>
  </section>
</template>

<style scoped>
.config-shell {
  width: min(100%, 900px);
  display: grid;
  gap: 1rem;
}

.hero {
  display: grid;
  gap: 0.35rem;
  text-align: center;
}

.hero-tag {
  color: #0e7490;
  font-size: 0.82rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
}

h1 {
  font-size: clamp(1.45rem, 2.5vw, 1.9rem);
  color: #0f172a;
  font-weight: 700;
}

.hero-subtitle {
  color: #475569;
  font-size: 0.95rem;
}

.config-card {
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 22px;
  padding: 1.25rem;
  box-shadow:
    0 18px 35px -30px rgba(2, 132, 199, 0.45),
    0 22px 40px -36px rgba(15, 23, 42, 0.95);
  display: grid;
  gap: 1rem;
}

.field-group {
  display: grid;
  gap: 0.55rem;
}

.field-label {
  font-size: 0.9rem;
  color: #334155;
  font-weight: 600;
}

.field-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.field-control {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  padding: 0.72rem 0.8rem;
  font-size: 0.95rem;
  color: #0f172a;
  background: #ffffff;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.field-control:focus {
  outline: none;
  border-color: #0891b2;
  box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.22);
}

.token-wrapper {
  position: relative;
}

.token-input {
  padding-right: 4.6rem;
}

.token-toggle {
  position: absolute;
  top: 50%;
  right: 0.4rem;
  transform: translateY(-50%);
}

.segmented {
  display: inline-flex;
  width: fit-content;
  background: #f1f5f9;
  border-radius: 999px;
  padding: 3px;
}

.segmented-btn {
  border: 0;
  background: transparent;
  color: #475569;
  border-radius: 999px;
  padding: 0.45rem 0.95rem;
  font-size: 0.87rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.segmented-btn.active {
  background: #ffffff;
  color: #0f172a;
  box-shadow: 0 3px 8px -6px rgba(15, 23, 42, 0.85);
}

.segmented-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.model-source {
  margin-bottom: 0.1rem;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
}

.primary-btn,
.secondary-btn,
.ghost-btn {
  border-radius: 12px;
  border: 0;
  padding: 0.64rem 0.95rem;
  font-size: 0.9rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.primary-btn {
  color: #ffffff;
  background: linear-gradient(120deg, #0ea5e9, #06b6d4);
  box-shadow: 0 10px 18px -14px rgba(2, 132, 199, 0.95);
}

.secondary-btn {
  color: #0f172a;
  background: #e2e8f0;
}

.ghost-btn {
  color: #0f172a;
  background: #e2e8f0;
}

.primary-btn:hover,
.secondary-btn:hover,
.ghost-btn:hover {
  transform: translateY(-1px);
}

.primary-btn:disabled,
.secondary-btn:disabled,
.ghost-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

.feedback-text {
  font-size: 0.86rem;
}

.feedback-text.success {
  color: #0f766e;
}

.feedback-text.error {
  color: #b91c1c;
}

.test-panel {
  border-radius: 14px;
  border: 1px solid transparent;
  padding: 0.8rem;
  display: grid;
  gap: 0.2rem;
}

.test-panel.ok {
  background: #ecfeff;
  border-color: #a5f3fc;
}

.test-panel.fail {
  background: #fef2f2;
  border-color: #fecaca;
}

.test-title {
  color: #0f172a;
  font-weight: 650;
}

.test-message {
  color: #334155;
  font-size: 0.9rem;
}

.test-meta {
  color: #475569;
  font-size: 0.82rem;
}

@media (max-width: 768px) {
  .config-card {
    border-radius: 18px;
    padding: 1rem;
  }

  .field-inline {
    flex-direction: column;
    align-items: flex-start;
  }

  .primary-btn,
  .secondary-btn {
    width: 100%;
    min-height: 42px;
  }
}
</style>
