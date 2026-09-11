<script setup>
import PageHome from './components/home/index.vue'
import PageSettings from './components/Settings.vue'
import { connectApi, disconnectApi } from '@/api'

const pageType = ref('loading') // loading | home | addDevice | settings
const settingsReturn = ref('addDevice')
const deviceDialogVisible = ref(false)
const device = ref(null)
const disconnecting = ref(false)
const disconnectError = ref('')

const connect = async () => {
  device.value = localStorage.getItem('device') ? JSON.parse(localStorage.getItem('device')) : null
  if (device.value) {
    try {
      await connectApi(device.value.address)
      deviceDialogVisible.value = false
      pageType.value = 'home'
    } catch (e) {
      console.error('连接设备失败：', e)
      pageType.value = 'addDevice'
    }
  } else {
    pageType.value = 'addDevice'
  }
}
connect()

async function disconnect() {
  if (!device.value) return
  disconnecting.value = true
  disconnectError.value = ''
  try {
    await disconnectApi(device.value.address)
    localStorage.removeItem('device')
    device.value = null
    pageType.value = 'addDevice'
  } catch (e) {
    disconnectError.value = e?.message || '断开连接失败'
  } finally {
    disconnecting.value = false
  }
}

function openSettings() {
  settingsReturn.value = pageType.value === 'home' ? 'home' : 'addDevice'
  pageType.value = 'settings'
}

function closeSettings() {
  pageType.value = settingsReturn.value
}
</script>

<template>
  <PageHeader :pageType="pageType" :disconnecting="disconnecting" :disconnect-error="disconnectError"
    @disconnect="disconnect" @open-settings="openSettings" @close-settings="closeSettings" />

  <div v-if="pageType === 'loading'" class="flex flex-1 items-center justify-center">
    <span class="size-5 animate-spin rounded-full border-2 border-black/10 border-t-[#007aff]" aria-label="加载中" />
  </div>

  <PageHome v-else-if="pageType === 'home'" :device="device" />

  <PageSettings v-else-if="pageType === 'settings'" />

  <AddDevice v-else-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
  <AddDeviceDialog v-model="deviceDialogVisible" @paired="connect" />
</template>
