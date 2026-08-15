<script setup>
import AppList from './AppList.vue'
const device = {
  deviceName: 'Xiaomi 17 Pro Max',
}
</script>

<template>
  <div class="flex h-full flex-1 flex-col">
    <div class="mb-3 flex items-center gap-2">
      <span class="text-2xl font-semibold text-black/80">
        {{ device.deviceName || device.model }}
      </span>
      <div>
        <span class="rounded bg-blue-500/10 px-1.5 py-1 text-[10px] font-medium text-blue-500">
          电量
        </span>
      </div>
    </div>
    <div class="mb-5">
      <div class="mb-1 text-xs">
        <span>已用 169.08 GB，总共 512.23 GB</span>
        <span>32%</span>
      </div>
      <!-- 进度条 -->
      <div class="h-2 w-full rounded-full bg-gray-200">
        <div class="h-2 rounded-full bg-blue-500" style="width: 32%"></div>
      </div>
    </div>
    <AppList />
  </div>
</template>
