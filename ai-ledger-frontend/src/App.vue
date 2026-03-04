<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AIConfigPanel from './components/AIConfigPanel.vue'
import AuthPanel from './components/AuthPanel.vue'
import CategoryPresetPanel from './components/CategoryPresetPanel.vue'
import SmartAccountingHome from './components/SmartAccountingHome.vue'
import {
  GUEST_OWNER_KEY,
  loadAIConfig,
  setStorageOwnerKey,
  syncAIConfigNow,
  syncCloudDataForUser,
} from './services/storage'
import { isCloudApiConfigured } from './services/cloudApiClient'

const CLOUD_SYNC_INTERVAL_MS = 30_000

/**
 * @typedef {{id: string, username: string}} AuthUser
 */

const activeTab = ref('home')
const currentUser = ref(null)
const ownerKey = ref(GUEST_OWNER_KEY)
const aiConfig = ref(loadAIConfig())
const isSyncing = ref(false)
const syncMessage = ref({ type: '', text: '' })

let cloudSyncIntervalTimer = null

const isCloudEnabled = computed(() => isCloudApiConfigured())

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

watch(
  () => currentUser.value?.id || '',
  (userId) => {
    clearCloudSyncInterval()
    if (!userId || !isCloudEnabled.value) {
      return
    }

    // 周期同步用于兜底离线恢复与跨设备增量拉取。
    cloudSyncIntervalTimer = setInterval(() => {
      void runCloudSync('周期同步', { silent: true })
    }, CLOUD_SYNC_INTERVAL_MS)
  },
  { immediate: true },
)

/**
 * 清理周期同步定时器。
 *
 * @returns {void} 无返回值。
 */
function clearCloudSyncInterval() {
  if (!cloudSyncIntervalTimer) {
    return
  }
  clearInterval(cloudSyncIntervalTimer)
  cloudSyncIntervalTimer = null
}

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
 * @param {{silent?: boolean, mode?: 'all' | 'ai'}} [options={}] 执行选项。
 * @returns {Promise<void>} 无返回值。
 */
async function runCloudSync(reason, options = {}) {
  const { silent = false, mode = 'all' } = options

  if (!isCloudEnabled.value) {
    return
  }
  const userId = currentUser.value?.id
  if (!userId) {
    return
  }
  if (isSyncing.value) {
    return
  }

  isSyncing.value = true
  try {
    if (mode === 'ai') {
      const result = await syncAIConfigNow(userId)
      aiConfig.value = loadAIConfig()
      if (!silent) {
        setSyncMessage('success', `AI 配置已同步（${result.direction}）· ${formatNowTime()}`)
      }
      return
    }

    const result = await syncCloudDataForUser(userId)
    aiConfig.value = loadAIConfig()
    if (!silent) {
      setSyncMessage(
        'success',
        `同步完成：AI ${result.aiConfig.direction}，类别 ${result.categoryPresets.direction}，账单 +${result.ledger.pushed}/↓${result.ledger.pulled} · ${formatNowTime()}`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '云同步失败'
    setSyncMessage('error', `${reason}失败：${message}`)
  } finally {
    isSyncing.value = false
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
 * @returns {void} 无返回值。
 */
function handleAuthChanged(user) {
  currentUser.value = user

  if (!user) {
    applyOwnerScope(GUEST_OWNER_KEY)
    setSyncMessage('', '')
    return
  }

  applyOwnerScope(user.id)
  void runCloudSync('登录后同步', { silent: false })
}

/**
 * 处理子组件配置保存事件并更新主页面状态。
 *
 * @param {object} config 最新 AI 配置对象。
 * @returns {void} 无返回值。
 */
function handleConfigSaved(config) {
  aiConfig.value = config
  if (isConfigReady.value) {
    activeTab.value = 'home'
  }

  // AI 配置保存后立刻做一次云端推送，满足跨端快速生效。
  if (currentUser.value?.id) {
    void runCloudSync('AI 配置同步', {
      silent: true,
      mode: 'ai',
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
 * @returns {void} 无返回值。
 */
function handleOnline() {
  if (!currentUser.value?.id) {
    return
  }
  void runCloudSync('网络恢复同步', { silent: true })
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }
})

onBeforeUnmount(() => {
  clearCloudSyncInterval()
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', handleOnline)
  }
})
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container class="app-shell">
      <q-page class="app-page">
        <section class="workspace">
          <AuthPanel @auth-changed="handleAuthChanged" />

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
              <q-tab name="config" icon="settings" label="AI 配置" />
            </q-tabs>
          </q-card>

          <SmartAccountingHome
            v-if="activeTab === 'home'"
            :key="`home-${ownerKey}`"
            :ai-config="aiConfig"
            :is-config-ready="isConfigReady"
            @request-config="handleRequestConfig"
          />

          <CategoryPresetPanel
            v-else-if="activeTab === 'presets'"
            :key="`presets-${ownerKey}`"
          />

          <AIConfigPanel
            v-else
            :key="`config-${ownerKey}`"
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
</style>
