<script setup>
import AddDeviceDialog from './components/AddDeviceDialog.vue'
import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'
import { useDevice } from './composables/useDevice'

const { device, connect, refresh } = useDevice()
const loading = ref(true)

const deviceDialogVisible = ref(false)
const pageType = ref('loading') // loading or 'addDevice' or 'home'

// 轮询刷新设备信息，让充电状态/电量/名称保持新鲜
const DEVICE_INFO_POLL_MS = 15000
let devicePollTimer = null

const startDevicePolling = () => {
  stopDevicePolling()
  devicePollTimer = setInterval(async () => {
    try {
      await refresh()
    } catch (e) {
      console.warn('刷新设备信息失败:', e)
    }
  }, DEVICE_INFO_POLL_MS)
}

const stopDevicePolling = () => {
  if (devicePollTimer) {
    clearInterval(devicePollTimer)
    devicePollTimer = null
  }
}

const init = async () => {
  try {
    loading.value = true
    const res = await connect()
    console.log(11, res)
    pageType.value = res ? 'home' : 'addDevice'
    if (res) startDevicePolling()
    else stopDevicePolling()
  } catch (e) {
    console.error('初始化失败:', e)
    pageType.value = 'addDevice'
    stopDevicePolling()
  } finally {
    loading.value = false
  }
}

init()
onUnmounted(stopDevicePolling)
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
