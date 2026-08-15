<script setup>
import { ref, onMounted, watch } from 'vue'
import { Icon } from '@iconify/vue'
import AppList from './AppList.vue'
import { useAdb } from '../../composables/useAdb'

const { getDeviceInfo } = useAdb()

const props = defineProps({
  serial: String,
})

const loading = ref(true)
const device = ref({
  serial: '',
  model: '',
  deviceName: '',
  battery: -1,
  isCharging: false,
  storage: '',
  storagePercent: 0,
})

const loadDeviceInfo = async () => {
  if (!props.serial) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const info = await getDeviceInfo(props.serial)
    device.value = { ...device.value, ...info }
  } catch (e) {
    console.error('获取设备信息失败:', e)
  } finally {
    loading.value = false
  }
}

onMounted(loadDeviceInfo)
watch(() => props.serial, loadDeviceInfo)
</script>

<template>
  <div class="flex h-full flex-1 flex-col">
    <!-- 设备名称 + 电量 -->
    <div class="mb-3 flex items-center gap-2">
      <span class="text-2xl font-semibold text-black/80">
        {{ device.deviceName || device.model || '未知设备' }}
      </span>
      <div v-if="loading" class="h-5 w-12 animate-pulse rounded bg-gray-200"></div>
      <div v-else-if="device.battery > 0">
        <span
          class="inline-flex items-center gap-0.5 rounded px-1.5 py-1 text-[10px] font-medium"
          :class="
            device.isCharging ? 'bg-green-500/10 text-green-500' : 'bg-blue-500/10 text-blue-500'
          "
        >
          <Icon v-if="device.isCharging" icon="lucide:battery-charging" class="h-3 w-3" />
          <Icon v-else icon="lucide:battery" class="h-3 w-3" />
          {{ device.battery }}%
        </span>
      </div>
    </div>

    <!-- 存储空间 -->
    <div class="mb-5">
      <template v-if="loading">
        <div class="mb-1 h-4 w-48 animate-pulse rounded bg-gray-200"></div>
        <div class="h-2 w-full animate-pulse rounded-full bg-gray-200"></div>
      </template>
      <template v-else-if="device.storage">
        <div class="mb-1 text-xs text-black/60">
          <span>已用 {{ device.storage.split('/')[0] }} / {{ device.storage.split('/')[1] }}</span>
          <span class="ml-1.5 font-medium text-black/80">{{ device.storagePercent }}%</span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            class="h-full rounded-full transition-all duration-500"
            :class="device.storagePercent > 90 ? 'bg-red-500' : device.storagePercent > 70 ? 'bg-yellow-500' : 'bg-blue-500'"
            :style="{ width: device.storagePercent + '%' }"
          ></div>
        </div>
      </template>
      <template v-else>
        <div class="text-xs text-black/40">存储信息获取失败</div>
      </template>
    </div>

    <AppList />
  </div>
</template>
