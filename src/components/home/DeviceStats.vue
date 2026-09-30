<script setup>
import BaseButton from '../BaseButton.vue'
import { getDeviceStatsApi } from '@/api'
import { formatBytes } from '@/utils/format'
import { readableError } from '@/utils/errors'

const props = defineProps({
  serial: { type: String, default: '' },
})

const loading = ref(false)
const error = ref('')
const stats = ref(null)

async function load(force = false) {
  if (!props.serial || loading.value) return
  loading.value = true
  error.value = ''
  try {
    stats.value = await getDeviceStatsApi(props.serial, force)
  } catch (e) {
    error.value = readableError(e, '读取设备信息失败')
  } finally {
    loading.value = false
  }
}

// 本组件只在弹层打开时被挂载 —— 所以「每次打开都是新数据」就是全部的加载时机。
// force：主进程那份设备信息缓存 30 秒，不强制刷新会看到上一次打开时的读数。
onMounted(() => load(true))

watch(
  () => props.serial,
  () => {
    stats.value = null
    error.value = ''
    load()
  },
)

const BATTERY_STATUS_TEXT = {
  charging: '充电中',
  discharging: '放电中',
  notCharging: '未充电',
  full: '已充满',
  unknown: '未知',
}

function batteryText(battery) {
  if (!battery || battery.level == null) return '—'
  const status = BATTERY_STATUS_TEXT[battery.status]
  const temperature = battery.temperatureC != null ? ` · ${battery.temperatureC.toFixed(1)}°C` : ''
  return `${battery.level}%${status ? ` · ${status}` : ''}${temperature}`
}

function cpuText() {
  const cpu = stats.value?.cpu
  if (!cpu) return '—'
  const parts = []
  if (cpu.cores) parts.push(`${cpu.cores} 核`)
  if (cpu.load1 != null) parts.push(`负载 ${cpu.load1.toFixed(2)}`)
  return parts.join(' · ') || '—'
}
</script>

<template>
  <!-- 外壳（圆角/描边/阴影）由 PopoverContent 给，这里只管内容 -->
  <div class="text-[12px]">
      <div v-if="loading && !stats" class="flex items-center justify-center gap-2 py-6 text-[12px] text-ink-3">
        <span class="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-ink-2" />
        正在读取设备信息…
      </div>

      <div v-else-if="error && !stats" class="flex flex-col items-center gap-2 py-5">
        <span class="text-[12px] text-[#d70015] dark:text-[#ff6961]">{{ error }}</span>
        <BaseButton variant="secondary" @click="load(true)">重试</BaseButton>
      </div>

      <template v-else-if="stats">
        <div class="grid grid-cols-2 gap-x-5 gap-y-2.5">
          <div>
            <div class="text-[11px] text-ink-3">型号</div>
            <div class="truncate text-[12px] text-ink" :title="stats.model || ''">{{ stats.model || '—' }}</div>
          </div>
          <div>
            <div class="text-[11px] text-ink-3">品牌</div>
            <div class="truncate text-[12px] text-ink">
              {{ stats.brand || stats.manufacturer || '—' }}
            </div>
          </div>
          <div>
            <div class="text-[11px] text-ink-3">Android 版本</div>
            <div class="text-[12px] text-ink">
              {{ stats.androidVersion || '—' }}
              <span v-if="stats.sdk" class="text-ink-3">（API {{ stats.sdk }}）</span>
            </div>
          </div>
          <div>
            <div class="text-[11px] text-ink-3">电量</div>
            <div class="text-[12px] text-ink">{{ batteryText(stats.battery) }}</div>
          </div>
          <div>
            <div class="text-[11px] text-ink-3">网络</div>
            <div class="truncate text-[12px] text-ink" :title="stats.network?.ip || ''">
              {{ stats.network?.ip || '—' }}
              <span v-if="stats.network?.interface" class="text-ink-3">（{{ stats.network.interface }}）</span>
            </div>
          </div>
          <div>
            <div class="text-[11px] text-ink-3">内存</div>
            <div class="text-[12px] text-ink">
              {{ formatBytes(stats.memory?.usedBytes) }} / {{ formatBytes(stats.memory?.totalBytes) }}
            </div>
          </div>
          <div class="col-span-2">
            <div class="text-[11px] text-ink-3">处理器</div>
            <div class="truncate text-[12px] text-ink" :title="stats.cpu?.model || ''">
              {{ stats.cpu?.model || '—' }}
              <span v-if="cpuText() !== '—'" class="text-ink-3">（{{ cpuText() }}）</span>
            </div>
          </div>
        </div>

      </template>
  </div>
</template>
