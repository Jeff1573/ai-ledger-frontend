<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AIConfigPanel from './components/AIConfigPanel.vue'
import AuthPanel from './components/AuthPanel.vue'
import CategoryPresetPanel from './components/CategoryPresetPanel.vue'
import SmartAccountingHome from './components/SmartAccountingHome.vue'
import { ensureAuthReady, subscribeAuthChanges } from './services/authService'
import {
  GUEST_OWNER_KEY,
  loadAIConfig,
  setStorageOwnerKey,
  syncAIConfigNow,
  syncCategoryPresetsForUser,
  syncCloudDataForUser,
} from './services/storage'
import { isCloudApiConfigured } from './services/cloudApiClient'
import {
  buildNextTabSyncStamps,
  createDefaultTabSyncStamps,
  doesSyncModeCover,
  isDataSyncTab,
  resolveTabSyncMode,
  shouldRunTabSync,
} from './services/tabSyncPolicy'

/**
 * @typedef {{id: string, username: string}} AuthUser
 */

const activeTab = ref('home')
const currentUser = ref(null)
const ownerKey = ref(GUEST_OWNER_KEY)
const aiConfig = ref(loadAIConfig())
const isSyncing = ref(false)
const isPreparingTabData = ref(false)
const syncMessage = ref({ type: '', text: '' })
const tabRenderVersion = reactive({
  home: 0,
  presets: 0,
  config: 0,
})
const lastTabSyncAt = reactive(createDefaultTabSyncStamps())

let latestPrepareToken = 0
let unsubscribeAuthChanges = null
let runningSyncPromise = null
let runningSyncMode = null

const isCloudEnabled = computed(() => isCloudApiConfigured())
const isCurrentTabDataTab = computed(() => isDataSyncTab(activeTab.value))

const isConfigReady = computed(() => {
  const provider = aiConfig.value?.provider === 'anthropic' ? 'anthropic' : 'openai'
  const activeModel = aiConfig.value?.providerModels?.[provider]?.currentModel?.trim() || ''
  const baseURL = aiConfig.value?.baseURL?.trim() || ''
  const token = aiConfig.value?.token?.trim() || ''
  return Boolean(baseURL && token && activeModel)
})

watch(
  () => [isConfigReady.value, activeTab.value],
  ([ready, tab]) => {
    // 配置不完整时仅限制主页记账，允许用户继续维护类别预设与 AI 配置。
    if (!ready && tab === 'home') {
      activeTab.value = 'presets'
    }
  },
  { immediate: true },
)

/**
 * 设置云同步提示消息。
 *
 * @param {'success' | 'error' | ''} type 消息类型。
 * @param {string} text 消息文本。
 * @returns {void} 无返回值。
 */
function setSyncMessage(type, text) {
  syncMessage.value = { type, text }
}

/**
 * 格式化当前时间，作为同步提示后缀。
 *
 * @returns {string} `HH:mm:ss` 时间文本。
 */
function formatNowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 执行云同步（全量或仅 AI 配置）。
 *
 * @param {string} reason 同步触发原因。
 * @param {{silent?: boolean, mode?: 'all' | 'ai' | 'category'}} [options={}] 执行选项。
 * @returns {Promise<{success: boolean, skipped: boolean, reason?: string}>} 同步执行结果。
 */
async function runCloudSync(reason, options = {}) {
  const { silent = false, mode = 'all' } = options

  if (!isCloudEnabled.value) {
    return {
      success: false,
      skipped: true,
      reason: 'cloud-disabled',
    }
  }
  const userId = currentUser.value?.id
  if (!userId) {
    return {
      success: false,
      skipped: true,
      reason: 'unauthenticated',
    }
  }
  if (isSyncing.value) {
    const inflightPromise = runningSyncPromise
    const inflightMode = runningSyncMode
    if (!inflightPromise) {
      return {
        success: false,
        skipped: true,
        reason: 'sync-busy',
      }
    }

    let inflightResult
    try {
      inflightResult = await inflightPromise
    } catch {
      inflightResult = {
        success: false,
        skipped: false,
        reason: 'sync-error',
      }
    }
    if (doesSyncModeCover(inflightMode, mode)) {
      return {
        success: inflightResult.success,
        skipped: true,
        reason: inflightResult.success ? 'joined-existing-sync' : 'joined-existing-sync-failed',
      }
    }

    // 当前正在执行的同步无法覆盖目标模式，等待其完成后补一次目标同步。
    return runCloudSync(reason, options)
  }

  isSyncing.value = true
  runningSyncMode = mode
  const syncTaskPromise = (async () => {
    if (mode === 'ai') {
      const result = await syncAIConfigNow(userId)
      aiConfig.value = loadAIConfig()
      if (!silent) {
        setSyncMessage('success', `AI 配置已同步（${result.direction}）· ${formatNowTime()}`)
      }
      return {
        success: true,
        skipped: false,
      }
    }

    if (mode === 'category') {
      const result = await syncCategoryPresetsForUser(userId)
      if (!silent) {
        setSyncMessage('success', `类别预设已同步（${result.direction}）· ${formatNowTime()}`)
      }
      return {
        success: true,
        skipped: false,
      }
    }

    const result = await syncCloudDataForUser(userId)
    aiConfig.value = loadAIConfig()
    if (!silent) {
      setSyncMessage(
        'success',
        `同步完成：AI ${result.aiConfig.direction}，类别 ${result.categoryPresets.direction}，账单 +${result.ledger.pushed}/↓${result.ledger.pulled} · ${formatNowTime()}`,
      )
    }
    return {
      success: true,
      skipped: false,
    }
  })()
  runningSyncPromise = syncTaskPromise

  try {
    return await syncTaskPromise
  } catch (error) {
    const message = error instanceof Error ? error.message : '云同步失败'
    setSyncMessage('error', `${reason}失败：${message}`)
    return {
      success: false,
      skipped: false,
      reason: 'sync-error',
    }
  } finally {
    isSyncing.value = false
    if (runningSyncPromise === syncTaskPromise) {
      runningSyncPromise = null
      runningSyncMode = null
    }
  }
}

/**
 * 覆盖写入页签最近同步时间戳映射。
 *
 * @param {{home: number, presets: number, config: number}} nextStamps 目标时间戳映射。
 * @returns {void} 无返回值。
 */
function applyTabSyncStamps(nextStamps) {
  lastTabSyncAt.home = nextStamps.home
  lastTabSyncAt.presets = nextStamps.presets
  lastTabSyncAt.config = nextStamps.config
}

/**
 * 重置全部页签同步时间戳（用于 owner 切换后重新评估同步时机）。
 *
 * @returns {void} 无返回值。
 */
function resetTabSyncStamps() {
  applyTabSyncStamps(createDefaultTabSyncStamps())
}

/**
 * 按同步模式更新页签同步时间戳。
 *
 * @param {'all' | 'ai' | 'category'} mode 同步模式。
 * @returns {void} 无返回值。
 */
function markTabsSynced(mode) {
  applyTabSyncStamps(buildNextTabSyncStamps(mode, lastTabSyncAt))
}

/**
 * 递增指定页签的渲染版本，强制子组件按最新本地数据重挂载。
 *
 * @param {string} tab 页签名称。
 * @returns {void} 无返回值。
 */
function bumpTabRenderVersion(tab) {
  if (!isDataSyncTab(tab)) {
    return
  }
  tabRenderVersion[tab] += 1
}

/**
 * 进入数据页前按策略执行同步，完成后刷新该页本地数据视图。
 *
 * @param {string} tab 目标页签。
 * @param {string} reason 同步触发原因。
 * @param {{force?: boolean, silent?: boolean}} [options={}] 执行选项。
 * @returns {Promise<void>} 无返回值。
 */
async function prepareTabData(tab, reason, options = {}) {
  if (!isDataSyncTab(tab)) {
    return
  }

  const { force = false, silent = true } = options
  const prepareToken = latestPrepareToken + 1
  latestPrepareToken = prepareToken
  isPreparingTabData.value = true

  try {
    const userId = currentUser.value?.id
    if (isCloudEnabled.value && userId) {
      const lastSyncedAtMs = lastTabSyncAt[tab]
      if (shouldRunTabSync(lastSyncedAtMs, { force })) {
        const mode = resolveTabSyncMode(tab)
        if (mode) {
          const syncResult = await runCloudSync(reason, { silent, mode })
          if (syncResult.success) {
            markTabsSynced(mode)
          }
        }
      }
    }
  } finally {
    if (prepareToken !== latestPrepareToken) {
      return
    }
    bumpTabRenderVersion(tab)
    isPreparingTabData.value = false
  }
}

/**
 * 应用 owner 切换，刷新本地作用域数据。
 *
 * @param {string} nextOwnerKey 目标 ownerKey。
 * @returns {void} 无返回值。
 */
function applyOwnerScope(nextOwnerKey) {
  ownerKey.value = setStorageOwnerKey(nextOwnerKey)
  aiConfig.value = loadAIConfig()
}

/**
 * 处理认证状态变化。
 *
 * @param {AuthUser | null} user 当前用户。
 * @returns {Promise<void>} 无返回值。
 */
async function handleAuthChanged(user) {
  // owner 切换时让旧的页签预加载流程立即失效，避免过期结果覆盖当前视图状态。
  latestPrepareToken += 1
  isPreparingTabData.value = false
  currentUser.value = user

  if (!user) {
    applyOwnerScope(GUEST_OWNER_KEY)
    resetTabSyncStamps()
    setSyncMessage('', '')
    if (isDataSyncTab(activeTab.value)) {
      bumpTabRenderVersion(activeTab.value)
    }
    return
  }

  applyOwnerScope(user.id)
  resetTabSyncStamps()
  const syncResult = await runCloudSync('登录后同步', {
    silent: false,
    mode: 'all',
  })
  if (syncResult.success) {
    markTabsSynced('all')
  }
  if (isDataSyncTab(activeTab.value)) {
    bumpTabRenderVersion(activeTab.value)
  }
}

/**
 * 处理子组件配置保存事件并更新主页面状态。
 *
 * @param {object} config 最新 AI 配置对象。
 * @returns {void} 无返回值。
 */
function handleConfigSaved(config) {
  aiConfig.value = config

  // AI 配置保存后立刻做一次云端推送，满足跨端快速生效。
  if (currentUser.value?.id) {
    void runCloudSync('AI 配置同步', { silent: true, mode: 'ai' }).then((result) => {
      if (result.success) {
        markTabsSynced('ai')
      }
    })
  }
}

/**
 * 响应主页“去配置”动作，切换到配置页签。
 *
 * @returns {void} 无返回值。
 */
function handleRequestConfig() {
  activeTab.value = 'config'
}

/**
 * 处理网络恢复事件，触发一次静默同步。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleOnline() {
  if (!currentUser.value?.id) {
    return
  }
  const syncResult = await runCloudSync('网络恢复同步', {
    silent: true,
    mode: 'all',
  })
  if (syncResult.success) {
    markTabsSynced('all')
    if (isDataSyncTab(activeTab.value)) {
      bumpTabRenderVersion(activeTab.value)
    }
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }

  unsubscribeAuthChanges = subscribeAuthChanges((user) => {
    void handleAuthChanged(user)
  })
  void ensureAuthReady().catch((error) => {
    const message = error instanceof Error ? error.message : '认证模块初始化失败'
    setSyncMessage('error', `认证初始化失败：${message}`)
  })
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', handleOnline)
  }
  if (typeof unsubscribeAuthChanges === 'function') {
    unsubscribeAuthChanges()
    unsubscribeAuthChanges = null
  }
})

watch(
  () => activeTab.value,
  (tab) => {
    void prepareTabData(tab, '进入页面同步', {
      force: false,
      silent: true,
    })
  },
  { immediate: true },
)
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container class="app-shell">
      <q-page class="app-page">
        <section class="workspace">
          <q-banner
            v-if="isCloudEnabled && currentUser && syncMessage.text"
            rounded
            dense
            :class="syncMessage.type === 'error' ? 'bg-negative text-white' : 'bg-positive text-white'"
          >
            <div class="row items-center justify-between q-gutter-sm">
              <span>{{ syncMessage.text }}</span>
              <q-chip
                v-if="isSyncing"
                dense
                size="sm"
                color="white"
                text-color="primary"
                label="同步中"
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
              <q-tab name="home" icon="home" label="主页记账" :disable="!isConfigReady" />
              <q-tab name="presets" icon="category" label="类别预设" />
              <q-tab name="auth" icon="cloud_sync" label="账号与云同步" />
              <q-tab name="config" icon="settings" label="AI 配置" />
            </q-tabs>
          </q-card>

          <q-card
            v-if="isPreparingTabData && isCurrentTabDataTab"
            flat
            bordered
            class="loading-card"
          >
            <q-card-section class="row items-center q-gutter-sm text-grey-8">
              <q-spinner color="primary" size="sm" />
              <span>正在检查云端并加载本地数据...</span>
            </q-card-section>
          </q-card>

          <SmartAccountingHome
            v-else-if="activeTab === 'home'"
            :key="`home-${ownerKey}-${tabRenderVersion.home}`"
            :ai-config="aiConfig"
            :is-config-ready="isConfigReady"
            @request-config="handleRequestConfig"
          />

          <CategoryPresetPanel
            v-else-if="activeTab === 'presets'"
            :key="`presets-${ownerKey}-${tabRenderVersion.presets}`"
          />

          <AuthPanel
            v-else-if="activeTab === 'auth'"
          />

          <AIConfigPanel
            v-else
            :key="`config-${ownerKey}-${tabRenderVersion.config}`"
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
}

.app-page {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 1.4rem 1rem 2rem;
}

.workspace {
  width: min(100%, 1040px);
  display: grid;
  gap: 0.9rem;
}

.tab-card {
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(8px);
}

.loading-card {
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(8px);
}
</style>
