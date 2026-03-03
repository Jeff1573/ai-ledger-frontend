<script setup>
import { computed, ref, watch } from 'vue'
import AIConfigPanel from './components/AIConfigPanel.vue'
import CategoryPresetPanel from './components/CategoryPresetPanel.vue'
import SmartAccountingHome from './components/SmartAccountingHome.vue'
import { loadAIConfig } from './services/storage'

const activeTab = ref('home')
const aiConfig = ref(loadAIConfig())

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
}

/**
 * 响应主页“去配置”动作，切换到配置页签。
 *
 * @returns {void} 无返回值。
 */
function handleRequestConfig() {
  activeTab.value = 'config'
}
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container class="app-shell">
      <q-page class="app-page">
        <section class="workspace">
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
            :ai-config="aiConfig"
            :is-config-ready="isConfigReady"
            @request-config="handleRequestConfig"
          />

          <CategoryPresetPanel v-else-if="activeTab === 'presets'" />

          <AIConfigPanel v-else @config-saved="handleConfigSaved" />
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
