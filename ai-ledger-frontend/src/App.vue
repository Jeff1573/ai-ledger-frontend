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

function setRefreshMessage(type, text) {
  refreshMessage.value = { type, text }
}

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

function handleConfigSaved(config) {
  aiConfig.value = config
}

function handleRequestConfig() {
  activeTab.value = 'config'
}

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
            v-if="refreshMessage.text"
            rounded
            dense
            :class="refreshMessage.type === 'error' ? 'bg-negative text-white' : 'bg-positive text-white'"
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

          <q-card flat bordered class="tab-card">
            <q-tabs
              v-model="activeTab"
              align="left"
              inline-label
              active-color="primary"
              indicator-color="primary"
            >
              <q-tab name="home" icon="home" label="主页记账" />
              <q-tab name="presets" icon="category" label="类别预设" />
              <q-tab name="config" icon="settings" label="AI 配置" />
            </q-tabs>
          </q-card>

          <q-card
            v-if="isInitializing"
            flat
            bordered
            class="loading-card"
          >
            <q-card-section class="row items-center q-gutter-sm text-grey-8">
              <q-spinner color="primary" size="sm" />
              <span>正在从服务端加载数据...</span>
            </q-card-section>
          </q-card>

          <SmartAccountingHome
            v-else-if="activeTab === 'home'"
            :key="`home-${activeTab}`"
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
  padding: 1.4rem 1rem 2rem;
}

.workspace {
  width: 100%;
  max-width: 1040px;
  min-width: 0;
  display: grid;
  gap: 0.9rem;
}

.app-page--home {
  height: 100vh;
  height: var(--app-viewport-height, 100vh);
  overflow: hidden;
}

.workspace--home {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.tab-card {
  width: 100%;
  min-width: 0;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(8px);
}

.loading-card {
  width: 100%;
  min-width: 0;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(8px);
}

.tab-card :deep(.q-tabs) {
  max-width: 100%;
  min-width: 0;
}

@media (max-width: 760px) {
  .app-page {
    padding: 0.85rem 0.55rem 1.2rem;
  }

  .workspace {
    gap: 0.75rem;
  }

  .app-page--home {
    height: auto;
    min-height: var(--app-viewport-height, 100vh);
    overflow: visible;
  }

  .workspace--home {
    height: auto;
    overflow: visible;
  }

  .tab-card :deep(.q-tabs__content) {
    min-width: 0;
    justify-content: flex-start;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .tab-card :deep(.q-tabs__content::-webkit-scrollbar) {
    display: none;
  }

  .tab-card :deep(.q-tab) {
    flex: 0 0 auto;
    min-width: max-content;
    padding-inline: 0.6rem;
  }
}

@media (max-height: 700px) {
  .app-page--home {
    height: auto;
    min-height: 100vh;
    min-height: var(--app-viewport-height, 100vh);
    overflow: visible;
  }

  .workspace--home {
    height: auto;
    overflow: visible;
  }
}
</style>
