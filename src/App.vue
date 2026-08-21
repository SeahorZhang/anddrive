<script setup>
import AddDeviceDialog from './components/AddDeviceDialog.vue'
import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'
import { useDevice } from './composables/useDevice'

const { device, connect } = useDevice()
const loading = ref(true)

const deviceDialogVisible = ref(false)
const pageType = ref('loading') // loading or 'addDevice' or 'home'

const init = async () => {
  try {
    loading.value = true
    const res = await connect()
    console.log(11, res)
    pageType.value = res ? 'home' : 'addDevice'
  } catch (e) {
    console.error('初始化失败:', e)
    pageType.value = 'addDevice'
  } finally {
    loading.value = false
  }
}

init()
</script>

<template>
  <div class="flex h-full flex-col bg-white">
    <div class="flex flex-1 items-center justify-center" v-if="pageType === 'loading'">
      <div class="ball-grid-pulse">
        <div></div>
        <div></div>
        <div></div>
        <div></div>
        <div></div>
        <div></div>
        <div></div>
        <div></div>
        <div></div>
      </div>
    </div>
    <PageHome :serial="device.serial" :device="device" v-if="pageType === 'home'" />
    <AddDevice v-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
    <AddDeviceDialog v-model="deviceDialogVisible" @paired="init" />
  </div>
</template>
