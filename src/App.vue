<script setup>
import AddDeviceDialog from './components/AddDeviceDialog.vue'
import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'
import PageHeader from './components/PageHeader.vue'
import { adb } from './services/desktopApi'

const { getActiveSession, disconnect: disconnectDevice } = adb

/** @type {import('vue').Ref<'idle' | 'restoring' | 'connected' | 'disconnecting' | 'error'>} */
const state = ref('restoring')
const serial = ref('')
const errorMessage = ref('')
const disconnectError = ref('')
const deviceDialogVisible = ref(false)

// 断开失败不离开当前设备页，错误在确认框内展示并允许重试；
// 其余错误（恢复失败/多设备冲突）落在添加设备页的横幅上。
const pageType = computed(() =>
  state.value === 'connected' || state.value === 'disconnecting' ? 'home' : 'addDevice',
)

async function restoreSession() {
  errorMessage.value = ''
  state.value = 'restoring'
  try {
    const session = await getActiveSession()
    if (session.status === 'conflict') {
      errorMessage.value = `检测到 ${session.serials.length} 台在线设备（${session.serials.join('、')}），请仅连接一台设备后重试`
      serial.value = ''
      state.value = 'error'
    } else if (session.status === 'connected') {
      serial.value = session.serial
      state.value = 'connected'
    } else {
      serial.value = ''
      state.value = 'idle'
    }
  } catch (error) {
    errorMessage.value = error?.message || '获取设备失败'
    state.value = 'error'
  }
}

async function disconnect() {
  if (!serial.value || state.value !== 'connected') return
  disconnectError.value = ''
  state.value = 'disconnecting'
  try {
    await disconnectDevice(serial.value)
    serial.value = ''
    state.value = 'idle'
  } catch (error) {
    disconnectError.value = error?.message || '断开连接失败'
    state.value = 'connected'
  }
}

restoreSession()
</script>

<template>
  <PageHeader
    :pageType="pageType"
    :disconnecting="state === 'disconnecting'"
    :disconnectError="disconnectError"
    @disconnect="disconnect"
  />

  <div class="flex flex-1 flex-col overflow-hidden px-7 pb-12">
    <div v-if="state === 'restoring'" class="flex flex-1 items-center justify-center">
      <span class="text-sm text-black/40">正在检查设备连接...</span>
    </div>
    <PageHome v-else-if="pageType === 'home'" :key="serial" :serial="serial" />
    <template v-else>
      <div
        v-if="state === 'error'"
        class="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500"
      >
        {{ errorMessage }}
      </div>
      <AddDevice v-model="deviceDialogVisible" />
    </template>
  </div>
  <AddDeviceDialog v-model="deviceDialogVisible" @paired="restoreSession" />
</template>
