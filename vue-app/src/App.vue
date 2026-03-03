<script setup>
import AIConfigPanel from './components/AIConfigPanel.vue'
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container class="app-shell">
      <q-page class="app-page">
        <AIConfigPanel />
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
  align-items: center;
  justify-content: center;
  padding: 2.25rem 1rem 2.5rem;
}
</style>
