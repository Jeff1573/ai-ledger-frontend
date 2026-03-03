<script setup>
import { computed, ref, watch } from 'vue'
import AIConfigPanel from './components/AIConfigPanel.vue'
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
  () => isConfigReady.value,
  (ready) => {
    if (!ready) {
      activeTab.value = 'config'
    }
  },
  { immediate: true },
)

function handleConfigSaved(config) {
  aiConfig.value = config
  if (isConfigReady.value) {
    activeTab.value = 'home'
  }
}

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
              <q-tab name="config" icon="settings" label="AI 配置" />
            </q-tabs>
          </q-card>

          <SmartAccountingHome
            v-if="activeTab === 'home'"
            :ai-config="aiConfig"
            :is-config-ready="isConfigReady"
            @request-config="handleRequestConfig"
          />

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
