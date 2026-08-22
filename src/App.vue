<script setup>
import AddDeviceDialog from './components/AddDeviceDialog.vue'
import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'
import { useDevice } from './composables/useDevice'
import { adb } from './services/desktopApi'

const { device, connect, refresh, reset } = useDevice()

/**
 * 连接生命周期状态机：
 * restoring（恢复连接中）→ connected / idle / error；
 * connected → disconnecting → idle 或回退 connected。
 */
const connectionState = ref('restoring')
const initError = ref('')
const disconnectError = ref('')
const deviceDialogVisible = ref(false)

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
  stopDevicePolling()
  disconnectError.value = ''
  initError.value = ''
  connectionState.value = 'restoring'
  try {
    const connected = await connect()
    if (connected) {
      startDevicePolling()
      connectionState.value = 'connected'
    } else {
      connectionState.value = 'idle'
    }
  } catch (e) {
    // 含多设备冲突：展示错误并停在添加设备页，不做静默选择
    console.error('初始化失败:', e)
    initError.value = e?.message || String(e)
    connectionState.value = 'error'
  }
}

// 断开当前无线 ADB 连接：main 侧统一释放 scrcpy/加载/forward；
// 成功后清空状态回到添加设备页；失败保留连接并展示错误。
const handleDisconnect = async () => {
  if (connectionState.value !== 'connected' || !device.value.serial) return
  disconnectError.value = ''
  connectionState.value = 'disconnecting'
  try {
    await adb.disconnect(device.value.serial)
    stopDevicePolling()
    reset()
    connectionState.value = 'idle'
  } catch (e) {
    console.error('断开连接失败:', e)
    disconnectError.value = e?.message || String(e)
    connectionState.value = 'connected'
  }
}

init()
onUnmounted(stopDevicePolling)
</script>

<template>
  <div class="flex h-full flex-col bg-white">
    <div v-if="connectionState === 'restoring'" class="flex flex-1 items-center justify-center">
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
    <PageHome
      v-else-if="connectionState === 'connected' || connectionState === 'disconnecting'"
      :serial="device.serial"
      :device="device"
      :disconnecting="connectionState === 'disconnecting'"
      :disconnect-error="disconnectError"
      @disconnect="handleDisconnect"
    />
    <AddDevice v-else v-model="deviceDialogVisible" :error="initError" />
    <AddDeviceDialog v-model="deviceDialogVisible" @paired="init" />
  </div>
</template>
