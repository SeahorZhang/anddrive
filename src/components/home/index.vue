<script setup>
import AppList from './AppList.vue'
import DeviceStats from './DeviceStats.vue'

const props = defineProps({
  device: {
    type: Object,
    required: true,
  },
})

const deviceTitle = computed(() => {
  return props.device.label || props.device.name || '未知设备'
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-5">
    <div class="mb-3.5 gap-3 px-0.5">
      <div class="truncate text-[15px] leading-tight font-semibold text-[#1d1d1f]">
        {{ deviceTitle }}
      </div>
      <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-black/45">
        <span class="size-1.5 rounded-full bg-[#34c759] shadow-[0_0_0_2px_rgba(52,199,89,0.18)]" />
        <span>已连接</span>
        <span class="text-black/20">·</span>
        <span class="truncate">{{ device.displayAddress || device.address }}</span>
      </div>
    </div>
    <DeviceStats :serial="device.address" />
    <AppList :address="device.address" />
  </div>
</template>
