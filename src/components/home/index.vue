<script setup>
import { Icon } from '@iconify/vue'
import AppList from './AppList.vue'
import DeviceStats from './DeviceStats.vue'
import StoragePanel from './StoragePanel.vue'
import { getDeviceStatsApi, getStorageVolumesApi } from '@/api'
import { deviceTransports, transportText } from '@/utils/deviceState'

const props = defineProps({
  device: {
    type: Object,
    required: true,
  },
})

const deviceTitle = computed(() => {
  return props.device.label || props.device.name || '未知设备'
})

// 同一台手机插着线又开着无线调试时两个接法都标出来，只标代表行那种会少信息。
const transportLabel = computed(() =>
  deviceTransports(props.device).map((transport) => transportText(transport)).join(' + '),
)

// 外观照 BaseButton 的 icon-only + default 变体（size-7 / rounded-[7px] / 图标 14）。
// 不复用组件是因为它 `defineEmits(['click'])`：Reka 的 Trigger 在 as-child 下把 onClick
// 当普通属性传下来，被 emits 声明吃掉后就落不到真正的 <button> 上 —— 点击挂不上，弹层打不开。
const CHIP_CLASS =
  'inline-flex h-6 cursor-pointer items-center gap-1 rounded-[7px] px-1.5 whitespace-nowrap select-none text-[11px] text-ink-2 transition-colors duration-150 outline-none hover:bg-fill hover:text-ink active:bg-fill-strong focus-visible:ring-2 focus-visible:ring-accent/40'
const POPOVER_CLASS =
  'z-50 w-[346px] rounded-[12px] border border-line bg-surface/95 p-3.5 shadow-pop outline-none backdrop-blur-xl'

// 摘要行只放「每次都想瞟一眼」的三件事：连没连上、系统版本、电还剩多少、还剩多少空间。
// 完整的型号 / 网络 / 内存 / CPU 留在弹层里，点开才拉（各 30s / 15s 缓存），
// 首页常驻的只有这一次汇总读数。
const stats = ref(null)
const storage = ref(null)
const summaryReady = ref(false)

async function loadSummary() {
  const [statsResult, storageResult] = await Promise.allSettled([
    getDeviceStatsApi(props.device.address),
    getStorageVolumesApi(props.device.address),
  ])
  if (statsResult.status === 'fulfilled') stats.value = statsResult.value
  if (storageResult.status === 'fulfilled') storage.value = storageResult.value
  summaryReady.value = true
}

onMounted(loadSummary)

const BATTERY_STATUS_TEXT = {
  charging: '充电中',
  discharging: '放电中',
  notCharging: '未充电',
  full: '已充满',
  unknown: '未知',
}

const batteryText = computed(() => {
  const battery = stats.value?.battery
  if (!battery || battery.level == null) return ''
  const status = BATTERY_STATUS_TEXT[battery.status]
  const temperature = battery.temperatureC != null ? ` · ${battery.temperatureC.toFixed(1)}°C` : ''
  return `${battery.level}%${status ? ` · ${status}` : ''}${temperature}`
})

// 图标跟着电量走，比固定一颗电池更像系统状态栏
const batteryIcon = computed(() => {
  const battery = stats.value?.battery
  if (!battery || battery.level == null) return 'lucide:battery'
  if (battery.status === 'charging') return 'lucide:battery-charging'
  if (battery.level <= 20) return 'lucide:battery-low'
  if (battery.level <= 50) return 'lucide:battery-medium'
  return 'lucide:battery-full'
})

const storagePercent = computed(() => {
  const value = storage.value?.summary?.percentUsed
  return value == null ? null : Math.round(value)
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-5">
    <!-- 设备摘要：设备名与切换在顶栏，这里只回答「这台机器现在什么状态」。
         电量 / 存储两个 chip 本身就是弹层入口，比两个看不出含义的图标按钮好找。 -->
    <div class="mb-3.5 flex items-center gap-2 px-0.5">
      <span :title="`${deviceTitle} · ${device.displayAddress || device.address}`"
        class="inline-flex h-6 items-center gap-1.5 rounded-full bg-[#34c759]/12 pr-2 pl-2.5 text-[11px] font-medium text-[#248a3d] dark:bg-[#34c759]/14 dark:text-[#30d158]">
        <span class="size-1.5 -ml-1 rounded-full bg-[#34c759] shadow-[0_0_0_2px_rgba(52,199,89,0.16)]" />
        已连接
        <span class="text-current opacity-60">·</span>
        {{ transportLabel }}
      </span>

      <span v-if="stats?.androidVersion" class="text-[11px] text-ink-3">
        Android {{ stats.androidVersion }}
      </span>

      <div class="ml-auto flex items-center gap-1">
        <template v-if="!summaryReady">
          <span class="h-6 w-[52px] animate-pulse rounded-[7px] bg-fill" aria-hidden="true" />
          <span class="h-6 w-[52px] animate-pulse rounded-[7px] bg-fill" aria-hidden="true" />
        </template>

        <template v-else>
          <PopoverRoot v-if="batteryText">
            <PopoverTrigger as-child>
              <button type="button" aria-label="设备信息" :title="`查看设备信息 · ${batteryText}`"
                :class="CHIP_CLASS">
                <Icon :icon="batteryIcon" :width="13" :height="13" class="shrink-0 text-ink-4" />
                <span class="tabular-nums">{{ stats.battery.level }}%</span>
              </button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent side="bottom" align="end" :side-offset="6" :class="POPOVER_CLASS">
                <DeviceStats :serial="device.address" />
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>

          <PopoverRoot v-if="storagePercent !== null">
            <PopoverTrigger as-child>
              <button type="button" aria-label="存储" title="查看存储 · 容量与卷"
                :class="CHIP_CLASS">
                <Icon icon="lucide:hard-drive" :width="13" :height="13" class="shrink-0 text-ink-4" />
                <span class="tabular-nums">{{ storagePercent }}%</span>
              </button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent side="bottom" align="end" :side-offset="6" :class="POPOVER_CLASS">
                <StoragePanel :serial="device.address" :device-label="deviceTitle" />
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>

          <button v-if="!batteryText && storagePercent === null" type="button" aria-label="设备信息"
            title="查看设备信息" :class="CHIP_CLASS">
            <Icon icon="lucide:info" :width="13" :height="13" class="shrink-0 text-ink-4" />
          </button>
        </template>
      </div>
    </div>

    <AppList :address="device.address" />
  </div>
</template>
