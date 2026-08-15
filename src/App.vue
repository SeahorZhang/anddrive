<script setup>
import AddDeviceDialog from './components/AddDeviceDialog.vue'
import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'
import PageHeader from './components/PageHeader.vue'
import { useAdb } from './composables/useAdb'

const { getDevices } = useAdb()
const deviceDialogVisible = ref(false)
const pageType = ref('addDevice') // 'addDevice' or 'home'

const disconnect = () => {
  pageType.value = 'addDevice'
}

// 启动时检查已连接的设备
onMounted(async () => {
  try {
    const devices = await getDevices()
    if (devices.length > 0) {
      pageType.value = 'home'
    }
  } catch (e) {
    console.error('检查设备失败:', e)
  }
})
</script>

<template>
  <PageHeader @disconnect="disconnect" :pageType="pageType" />

  <div class="flex flex-col px-7 pb-12">
    <AddDevice v-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
    <PageHome v-else></PageHome>
  </div>
  <AddDeviceDialog v-model="deviceDialogVisible" @paired="pageType = 'home'" />
</template>
