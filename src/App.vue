<script setup>
import AddDeviceDialog from './components/AddDeviceDialog.vue'
import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'

const deviceDialogVisible = ref(false)

const pageType = ref('home') // 'addDevice' or 'home'
</script>

<template>
  <div class="flex min-h-150 min-w-2xl flex-col bg-amber-100 px-7 py-12">
    <AddDevice v-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
    <PageHome v-else></PageHome>
  </div>
  <AddDeviceDialog v-model="deviceDialogVisible" />
</template>
