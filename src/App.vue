<script setup>
import AddDeviceDialog from './components/AddDeviceDialog.vue'
import AddDevice from './components/AddDevice.vue'
import PageHome from './components/home/index.vue'
import PageHeader from './components/PageHeader.vue'
import { useAdb } from './composables/useAdb'
import { selectDevice } from '../shared/selectDevice.js'

const { getDevices } = useAdb()
const deviceDialogVisible = ref(false)
const pageType = ref('addDevice') // 'addDevice' or 'home'
const serial = ref('')

const disconnect = () => {
  pageType.value = 'addDevice'
  serial.value = ''
}

const loadDevice = async () => {
  try {
    const device = selectDevice(await getDevices())
    if (device) {
      serial.value = device.serial
      pageType.value = 'home'
    }
  } catch (e) {
    console.error('获取设备失败:', e)
  }
}

loadDevice()
</script>

<template>
  <PageHeader @disconnect="disconnect" :pageType="pageType" />

  <div class="flex flex-1 flex-col overflow-hidden px-7 pb-12">
    <AddDevice v-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
    <PageHome v-else :serial="serial" />
  </div>
  <AddDeviceDialog v-model="deviceDialogVisible" @paired="loadDevice" />
</template>
