<script setup>
import AppList from './AppList.vue'
defineProps({
  device: {
    type: Object,
    required: true,
  },
})
</script>

<template>
  <div class="flex flex-1 flex-col px-7 pb-5">
    <div class="mb-3 flex items-center gap-2">
      <span class="text-2xl font-semibold text-black/80">
        {{ device.deviceName || device.model || '未知设备' }}
      </span>
    </div>

    <AppList :serial="device.serial" />
  </div>
</template>
