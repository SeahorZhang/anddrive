<script setup>
import { Icon } from '@iconify/vue'
import AppList from './AppList.vue'

defineProps({
  device: {
    type: Object,
    required: true,
  },
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-5">
    <div class="mb-3.5 flex items-center gap-3 px-0.5">
      <div
        class="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-b from-[#5ac8fa] to-[#007aff] text-white shadow-[0_1px_3px_rgba(0,122,255,0.35)]"
      >
        <Icon icon="lucide:smartphone" :width="18" :height="18" />
      </div>
      <div class="min-w-0">
        <div class="truncate text-[15px] leading-tight font-semibold text-[#1d1d1f]">
          {{ device.given_name || device.name || '未知设备' }}
        </div>
        <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-black/45">
          <span
            class="size-1.5 rounded-full bg-[#34c759] shadow-[0_0_0_2px_rgba(52,199,89,0.18)]"
          />
          <span>已连接</span>
          <span class="text-black/20">·</span>
          <span class="truncate">{{ device.address }}</span>
        </div>
      </div>
    </div>
    <AppList :address="device.address" />
  </div>
</template>
