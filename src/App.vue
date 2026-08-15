<script setup>
import AddDeviceDialog from './components/AddDeviceDialog.vue'
import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'
import PageHeader from './components/PageHeader.vue'

const deviceDialogVisible = ref(false)

const pageType = ref('home') // 'addDevice' or 'home'
</script>

<template>
  <PageHeader />

  <div class="flex flex-col px-7 pb-12">
    <AddDevice v-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
    <PageHome v-else></PageHome>
  </div>
  <AddDeviceDialog v-model="deviceDialogVisible" />
</template>
