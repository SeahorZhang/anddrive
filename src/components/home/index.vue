<script setup>
import { ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import AppList from './AppList.vue'
import { useAdb } from '../../composables/useAdb'

const { getDeviceInfo } = useAdb()

const props = defineProps({
  serial: String,
})

const device = ref({
  model: '', // 设备型号
  deviceName: '', // 设备名称
  battery: -1, // 电量
  isCharging: false, // 是否在充电
  storage: '', // 存储容量
  storagePercent: 0, // 存储容量百分比
})

const loadDeviceInfo = async () => {
  try {
    device.value = await getDeviceInfo(props.serial)
    console.log('设备信息:', device.value)
  } catch (e) {
    console.error('获取设备信息失败:', e)
  }
}

if (props.serial) {
  loadDeviceInfo()
}

watch(() => props.serial, loadDeviceInfo)
</script>

<template>
  <!-- 设备名称 + 电量 -->
  <div class="mb-3 flex items-center gap-2">
    <span class="text-2xl font-semibold text-black/80">
      {{ device.deviceName || device.model || '未知设备' }}
    </span>
    <span
      class="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium"
      :class="device.isCharging ? 'bg-green-500/10 text-green-500' : 'bg-blue-500/10 text-blue-500'"
    >
      <Icon v-if="device.isCharging" icon="lucide:battery-charging" class="size-4" />
      <Icon v-else icon="lucide:battery" class="size-4" />
      {{ device.battery }}%
    </span>
  </div>

  <!-- 存储空间 -->
  <div class="mb-5">
    <div class="mb-1 flex items-center text-xs text-black/60">
      <span class="flex-1">
        已用 {{ device.storage.split('/')[0] }} GB，总共 {{ device.storage.split('/')[1] }} GB
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

  <AppList />
</template>
