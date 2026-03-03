<script setup>
import AIConfigPanel from './components/AIConfigPanel.vue'
</script>

<template>
  <main class="app-shell">
    <AIConfigPanel />
  </main>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2.25rem 1rem;
}
</style>
