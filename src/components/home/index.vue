<script setup>
import { Icon } from '@iconify/vue'
import AppList from './AppList.vue'
import PageHeader from '../PageHeader.vue'

defineProps({
  serial: String,
  device: {
    type: Object,
    default: () => ({}),
  },
})
</script>

<template>
  <PageHeader />

  <div class="flex flex-1 flex-col overflow-hidden px-7 pb-6">
    <div class="mb-3 flex items-center gap-2">
      <span class="text-2xl font-semibold text-black/80">
        {{ device.deviceName || device.model || '未知设备' }}
      </span>
      <span
        class="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium"
        :class="
          device.isCharging ? 'bg-green-500/10 text-green-500' : 'bg-blue-500/10 text-blue-500'
        "
      >
        <Icon v-if="device.isCharging" icon="lucide:battery-charging" class="size-4" />
        <Icon v-else icon="lucide:battery" class="size-4" />
        {{ device.battery }}%
      </span>
    </div>

    <div class="mb-5">
      <div class="mb-1 flex items-center text-xs text-black/60">
        <span class="flex-1">
          已用 {{ device.storage?.split('/')[0] || '0' }} GB，总共
          {{ device.storage?.split('/')[1] || '0' }} GB
        </span>
        <span>{{ device.storagePercent }}%</span>
      </div>
      <div class="h-2 w-full overflow-hidden rounded-full bg-gray-200">
        <div
          class="h-full rounded-full transition-all duration-500"
          :class="
            device.storagePercent > 90
              ? 'bg-red-500'
              : device.storagePercent > 70
                ? 'bg-yellow-500'
                : 'bg-blue-500'
          "
          :style="{ width: device.storagePercent + '%' }"
        ></div>
      </div>
    </div>

    <AppList :serial="serial" />
  </div>
</template>
