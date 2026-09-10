<script setup>
import { onMounted } from 'vue'
import PageHome from './components/home/index.vue'
import UpdateNotesDialog from './components/UpdateNotesDialog.vue'
import { connectApi, disconnectApi } from '@/api'
import { initUpdater, takeUpdateNotes } from '@/update'

const pageType = ref('loading') // loading | home | addDevice
const deviceDialogVisible = ref(false)
const device = ref(null)
const disconnecting = ref(false)
const disconnectError = ref('')

const updateNotesVisible = ref(false)
const updateVersion = ref('')
const updateReleaseNotes = ref('')

initUpdater()

onMounted(async () => {
  const notes = await takeUpdateNotes()
  if (notes && (notes.releaseNotes || notes.version)) {
    updateVersion.value = notes.version || ''
    updateReleaseNotes.value = notes.releaseNotes || ''
    updateNotesVisible.value = true
  }
})

const connect = async () => {
  device.value = localStorage.getItem('device') ? JSON.parse(localStorage.getItem('device')) : null
  console.log(22, device.value)
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
</script>

<template>
  <PageHeader
    :pageType="pageType"
    :disconnecting="disconnecting"
    :disconnect-error="disconnectError"
    @disconnect="disconnect"
  />

  <div v-if="pageType === 'loading'" class="flex flex-1 items-center justify-center">
    <span
      class="size-5 animate-spin rounded-full border-2 border-black/10 border-t-[#007aff]"
      aria-label="加载中"
    />
  </div>

  <PageHome v-else-if="pageType === 'home'" :device="device" />

  <AddDevice v-else-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
  <AddDeviceDialog v-model="deviceDialogVisible" @paired="connect" />

  <UpdateNotesDialog
    v-model="updateNotesVisible"
    :version="updateVersion"
    :release-notes="updateReleaseNotes"
  />
</template>
