<script setup>
// import AddDeviceDialog from './components/AddDeviceDialog.vue'
// import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'
// import PageHeader from './components/PageHeader.vue'
const adb = window.electronAPI.adb

const { connect } = adb

// /** @type {import('vue').Ref<'idle' | 'restoring' | 'connected' | 'disconnecting' | 'error'>} */
// const state = ref('restoring')
// const serial = ref('')
// const errorMessage = ref('')
// const disconnectError = ref('')
// const deviceDialogVisible = ref(false)
// /** @type {import('vue').Ref<{ serial: string, state: string }[]>} */
// const devices = ref([])

// function connectDevice(device) {
//   if (device.state !== 'device') return
//   errorMessage.value = ''
//   serial.value = device.serial
//   state.value = 'connected'
// }

// // 断开失败不离开当前设备页，错误在确认框内展示并允许重试；
// // 其余错误（恢复失败/多设备冲突）落在添加设备页的横幅上。
// const pageType = computed(() =>
//   state.value === 'connected' || state.value === 'disconnecting' ? 'home' : 'addDevice',
// )

// async function restoreSession() {
//   errorMessage.value = ''
//   state.value = 'restoring'
//   try {
//     const session = await getActiveSession()
//     if (session.status === 'conflict') {
//       errorMessage.value = `检测到 ${session.serials.length} 台在线设备（${session.serials.join('、')}），请仅连接一台设备后重试`
//       serial.value = ''
//       state.value = 'error'
//     } else if (session.status === 'connected') {
//       serial.value = session.serial
//       state.value = 'connected'
//     } else {
//       serial.value = ''
//       state.value = 'idle'
//     }
//   } catch (error) {
//     errorMessage.value = error?.message || '获取设备失败'
//     state.value = 'error'
//   }
// }

// async function disconnect() {
//   if (!serial.value || state.value !== 'connected') return
//   disconnectError.value = ''
//   state.value = 'disconnecting'
//   try {
//     await disconnectDevice(serial.value)
//     serial.value = ''
//     state.value = 'idle'
//   } catch (error) {
//     disconnectError.value = error?.message || '断开连接失败'
//     state.value = 'connected'
//   }
// }

// restoreSession()

// const serial = ref('')
// async function getAllDevice() {
//   try {
//     const devices = await getDevices()
//     serial.value = devices.find((item) => item.state === 'device')?.serial
//     console.log(1, serial.value)
//   } catch (error) {
//     console.warn('获取设备列表失败:', error)
//   }
// }

// getAllDevice()

const device = {
  serial: 'adb-af3d7abd-Zvci5V._adb-tls-connect._tcp',
  address: '192.168.100.91:39957',
  deviceName: 'Xiaomi 17 Pro Max',
}
const pageType = ref('loading') // loading | home | addDevice

function adbConnect(serial, address) {
  return connect(address)
    .then((res) => {
      console.log('连接手机成功', res)
      // return getAllDevice()
      pageType.value = 'home'
    })
    .catch((err) => {
      console.log('连接手机失败', err?.message || err)
      pageType.value = 'addDevice'
    })
}

adbConnect(device.serial, device.address)
</script>

<template>
  <PageHeader :pageType="pageType" />

  <div v-if="pageType === 'loading'" class="">loading</div>

  <PageHome v-else-if="pageType === 'home'" :device="device" />

  <!-- 


  <div class="flex flex-1 flex-col overflow-hidden px-7 pb-12">
    <div v-if="state === 'restoring'" class="flex flex-1 items-center justify-center">
      <span class="text-sm text-black/40">正在检查设备连接...</span>
    </div>
    <template v-else>
      <div
        v-if="state === 'error'"
        class="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500"
      >
        {{ errorMessage }}
      </div>

      <div v-if="devices.length > 0" class="mb-4">
        <div class="mb-1.5 flex items-center justify-between">
          <span class="text-[11px] font-medium text-black/50">在线设备（adb devices）</span>
          <button
            class="text-[11px] text-blue-500/80 transition-colors hover:text-blue-500"
            @click="refreshDevices"
          >
            刷新
          </button>
        </div>
        <div class="flex flex-col gap-1">
          <button
            v-for="device in devices"
            :key="device.serial"
            class="flex items-center justify-between rounded-lg border border-black/8 bg-gray-50 px-3 py-2 text-left text-xs transition-colors hover:bg-gray-100 disabled:opacity-50"
            :disabled="device.state !== 'device'"
            @click="connectDevice(device)"
          >
            <span class="truncate font-mono text-black/70">{{ device.serial }}</span>
            <span
              class="ml-3 shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              :class="
                device.state === 'device'
                  ? 'bg-green-500/10 text-green-600'
                  : 'bg-red-500/10 text-red-500'
              "
            >
              {{ device.state === 'device' ? '在线' : device.state }}
            </span>
          </button>
        </div>
      </div>

      <AddDevice v-model="deviceDialogVisible" />
    </template>
  </div>
  <AddDeviceDialog v-model="deviceDialogVisible" @paired="restoreSession" /> -->
</template>
