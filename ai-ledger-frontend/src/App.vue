<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AIConfigPanel from './components/AIConfigPanel.vue'
import CategoryPresetPanel from './components/CategoryPresetPanel.vue'
import SmartAccountingHome from './components/SmartAccountingHome.vue'
import { loadAIConfig, syncCloudDataForUser } from './services/storage'
import { bindViewportHeightSync } from './services/viewportHeightSync'

const activeTab = ref('home')
const aiConfig = ref(loadAIConfig())
const isRefreshing = ref(false)
const isInitializing = ref(true)
const refreshMessage = ref({ type: '', text: '' })
const panelVersion = ref(0)
let stopViewportHeightSync = () => {}

const isConfigReady = computed(() => {
  const provider = aiConfig.value?.provider === 'anthropic' ? 'anthropic' : 'openai'
  const activeModel = aiConfig.value?.providerModels?.[provider]?.currentModel?.trim() || ''
  const baseURL = aiConfig.value?.baseURL?.trim() || ''
  const token = aiConfig.value?.token?.trim() || ''
  return Boolean(baseURL && token && activeModel)
})

/**
 * 设置页面顶部刷新反馈消息。
 *
 * @param {'success' | 'error' | ''} type 消息类型。
 * @param {string} text 消息文本。
 * @returns {void} 无返回值。
 */
function setRefreshMessage(type, text) {
  refreshMessage.value = { type, text }
}

/**
 * 格式化当前时间，用于展示刷新完成时刻。
 *
 * @returns {string} 当前时间文本。
 */
function formatNowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 从服务端刷新全量数据并更新页面状态。
 *
 * @param {string} reason 刷新触发原因。
 * @param {{silent?: boolean}} [options={}] 执行选项。
 * @returns {Promise<{success: boolean, skipped: boolean}>} 刷新结果。
 */
async function refreshFromServer(reason, options = {}) {
  const { silent = false } = options
  if (isRefreshing.value) {
    return { success: false, skipped: true }
  }

  isRefreshing.value = true
  try {
    const result = await syncCloudDataForUser('default')
    aiConfig.value = loadAIConfig()
    panelVersion.value += 1

    if (!silent) {
      setRefreshMessage(
        'success',
        `刷新完成：AI ${result.aiConfig.direction}，类别 ${result.categoryPresets.direction}，账单 ${result.ledger.pulled} 条 · ${formatNowTime()}`,
      )
    }
    return { success: true, skipped: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : '服务端数据刷新失败'
    setRefreshMessage('error', `${reason}失败：${message}`)
    return { success: false, skipped: false }
  } finally {
    isRefreshing.value = false
  }
}

/**
 * 接收配置页保存后的 AI 配置快照。
 *
 * @param {object} config 最新 AI 配置。
 * @returns {void} 无返回值。
 */
function handleConfigSaved(config) {
  aiConfig.value = config
}

/**
 * 从首页跳转到 AI 配置页。
 *
 * @returns {void} 无返回值。
 */
function handleRequestConfig() {
  activeTab.value = 'config'
}

/**
 * 网络恢复后静默拉取一次最新云端数据。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleOnline() {
  await refreshFromServer('网络恢复刷新', { silent: true })
}

onMounted(async () => {
  stopViewportHeightSync = bindViewportHeightSync()

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }

  try {
    await refreshFromServer('初始化加载', { silent: true })
  } finally {
    isInitializing.value = false
  }
})

onBeforeUnmount(() => {
  stopViewportHeightSync()

  if (typeof window !== 'undefined') {
    window.removeEventListener('online', handleOnline)
  }
})

watch(
  () => activeTab.value,
  () => {
    void refreshFromServer('切换页面刷新', { silent: true })
  },
)
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container class="app-shell">
      <q-page :class="['app-page', { 'app-page--home': activeTab === 'home' }]">
        <section :class="['workspace', { 'workspace--home': activeTab === 'home' }]">
          <q-banner
            v-if="refreshMessage.type === 'error' && refreshMessage.text"
            rounded
            dense
            class="bg-negative text-white"
          >
            <div class="row items-center justify-between q-gutter-sm">
              <span>{{ refreshMessage.text }}</span>
              <q-chip
                v-if="isRefreshing"
                dense
                size="sm"
                color="white"
                text-color="primary"
                label="刷新中"
              />
            </div>
          </q-banner>

          <q-card v-if="isInitializing" flat bordered class="loading-card">
            <q-card-section class="row items-center q-gutter-sm text-grey-8">
              <q-spinner color="primary" size="sm" />
              <span>正在从服务端加载数据...</span>
            </q-card-section>
          </q-card>

          <SmartAccountingHome
            v-else-if="activeTab === 'home'"
            :key="`home-${activeTab}-${panelVersion}`"
            :ai-config="aiConfig"
            :is-config-ready="isConfigReady"
            @request-config="handleRequestConfig"
          />

          <CategoryPresetPanel
            v-else-if="activeTab === 'presets'"
            :key="`presets-${activeTab}-${panelVersion}`"
          />

          <AIConfigPanel
            v-else
            :key="`config-${activeTab}-${panelVersion}`"
            @config-saved="handleConfigSaved"
          />
        </section>

        <q-card flat bordered class="tab-card tab-card--floating">
          <q-tabs
            v-model="activeTab"
            align="justify"
            active-color="primary"
            indicator-color="transparent"
            no-caps
            class="bottom-tabs"
          >
            <q-tab name="home" icon="home" label="主页" />
            <q-tab name="presets" icon="category" label="类别" />
            <q-tab name="config" icon="settings" label="AI配置" />
          </q-tabs>
        </q-card>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  min-height: var(--app-viewport-height, 100vh);
}

.app-page {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 1.15rem 0.95rem calc(6.8rem + env(safe-area-inset-bottom));
}

.workspace {
  width: 100%;
  max-width: 1040px;
  min-width: 0;
  display: grid;
  gap: 0.8rem;
}

.app-page--home {
  min-height: 100vh;
  min-height: var(--app-viewport-height, 100vh);
}

.workspace--home {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.loading-card {
  width: 100%;
  min-width: 0;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(10px);
}

.tab-card {
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(18px);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
}

.tab-card--floating {
  position: fixed;
  left: 50%;
  bottom: calc(1rem + env(safe-area-inset-bottom));
  z-index: 40;
  width: min(460px, calc(100vw - 1rem));
  transform: translateX(-50%);
}

.bottom-tabs {
  min-height: 72px;
}

.tab-card :deep(.q-tabs__content) {
  min-width: 0;
}

.tab-card :deep(.q-tab) {
  min-height: 72px;
  color: #64748b;
}

.tab-card :deep(.q-tab__icon) {
  font-size: 1.35rem;
}

.tab-card :deep(.q-tab__label) {
  font-size: 0.82rem;
  font-weight: 700;
}

.tab-card :deep(.q-tab--active) {
  color: #4f46e5;
}

@media (max-width: 760px) {
  .app-page {
    padding: 0.55rem 0.45rem calc(6.4rem + env(safe-area-inset-bottom));
  }

  .workspace {
    gap: 0.6rem;
  }

  .tab-card--floating {
    width: calc(100vw - 1rem);
    bottom: calc(0.65rem + env(safe-area-inset-bottom));
  }

  .bottom-tabs,
  .tab-card :deep(.q-tab) {
    min-height: 68px;
  }

  .tab-card :deep(.q-tab__label) {
    font-size: 0.78rem;
  }
}
</style>

