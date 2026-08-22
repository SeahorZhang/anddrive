<script setup>
import AppList from './AppList.vue'
import { useDeviceInfo } from '../../composables/useDeviceInfo'

const props = defineProps({
  serial: String,
})

const { device, loadDeviceInfo } = useDeviceInfo(() => props.serial)

watch(() => props.serial, loadDeviceInfo, { immediate: true })
</script>

<template>
  <div class="mb-3 flex items-center gap-2">
    <span class="text-2xl font-semibold text-black/80">
      {{ device.deviceName || device.model || '未知设备' }}
    </span>
  </div>

  <AppList :serial="serial" />
</template>
