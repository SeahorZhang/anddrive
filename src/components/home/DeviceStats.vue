<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from '../BaseButton.vue'
import { getDeviceStatsApi } from '@/api'
import { readableError } from '@/utils/errors'

const props = defineProps({
  serial: { type: String, default: '' },
})

const expanded = ref(false)
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

function toggle() {
  expanded.value = !expanded.value
  if (expanded.value && !stats.value) load()
}

watch(
  () => props.serial,
  () => {
    stats.value = null
    error.value = ''
    if (expanded.value) load()
  },
)

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 || index < 2 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

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

function updatedText() {
  const at = stats.value?.updatedAt
  if (!at) return '—'
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

const storagePercent = computed(() => {
  const value = stats.value?.storage?.percentUsed
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
})
</script>

<template>
  <section class="mb-3 shrink-0 overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/60 backdrop-blur">
    <button class="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2 text-left outline-none" @click="toggle">
      <Icon icon="lucide:cpu" :width="13" :height="13" class="shrink-0 text-black/40" />
      <span class="shrink-0 text-[12px] font-medium text-black/65">设备信息</span>
      <span v-if="stats" class="ml-1 truncate text-[11px] text-black/40">
        {{ stats.model || '未知型号' }}
        <template v-if="stats.battery?.level != null"> · 电量 {{ stats.battery.level }}%</template>
        <template v-if="stats.storage?.percentUsed != null"> · 存储 {{ stats.storage.percentUsed }}%</template>
      </span>
      <Icon :icon="expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'" :width="14" :height="14"
        class="ml-auto shrink-0 text-black/35" />
    </button>

    <div v-if="expanded" class="border-t border-black/[0.06] px-3.5 py-3">
      <div v-if="loading && !stats" class="flex items-center justify-center gap-2 py-6 text-[12px] text-black/45">
        <span class="size-3.5 animate-spin rounded-full border-2 border-black/15 border-t-black/45" />
        正在读取设备信息…
      </div>

      <div v-else-if="error && !stats" class="flex flex-col items-center gap-2 py-5">
        <span class="text-[12px] text-red-600">{{ error }}</span>
        <BaseButton variant="secondary" @click="load(true)">重试</BaseButton>
      </div>

      <template v-else-if="stats">
        <div class="grid grid-cols-2 gap-x-5 gap-y-2.5">
          <div>
            <div class="text-[11px] text-black/40">型号</div>
            <div class="truncate text-[12px] text-black/75" :title="stats.model || ''">{{ stats.model || '—' }}</div>
          </div>
          <div>
            <div class="text-[11px] text-black/40">品牌</div>
            <div class="truncate text-[12px] text-black/75">
              {{ stats.brand || stats.manufacturer || '—' }}
            </div>
          </div>
          <div>
            <div class="text-[11px] text-black/40">Android 版本</div>
            <div class="text-[12px] text-black/75">
              {{ stats.androidVersion || '—' }}
              <span v-if="stats.sdk" class="text-black/40">（API {{ stats.sdk }}）</span>
            </div>
          </div>
          <div>
            <div class="text-[11px] text-black/40">电量</div>
            <div class="text-[12px] text-black/75">{{ batteryText(stats.battery) }}</div>
          </div>
          <div>
            <div class="text-[11px] text-black/40">网络</div>
            <div class="truncate text-[12px] text-black/75" :title="stats.network?.ip || ''">
              {{ stats.network?.ip || '—' }}
              <span v-if="stats.network?.interface" class="text-black/40">（{{ stats.network.interface }}）</span>
            </div>
          </div>
          <div>
            <div class="text-[11px] text-black/40">内存</div>
            <div class="text-[12px] text-black/75">
              {{ formatBytes(stats.memory?.usedBytes) }} / {{ formatBytes(stats.memory?.totalBytes) }}
            </div>
          </div>
          <div class="col-span-2">
            <div class="flex items-center justify-between text-[11px] text-black/40">
              <span>存储（/data）</span>
              <span class="tabular-nums">
                {{ formatBytes(stats.storage?.usedBytes) }} / {{ formatBytes(stats.storage?.totalBytes) }}
                <span v-if="stats.storage?.percentUsed != null">（{{ stats.storage.percentUsed }}%）</span>
              </span>
            </div>
            <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08]">
              <div class="h-full rounded-full bg-[#007aff]" :style="{ width: `${storagePercent}%` }" />
            </div>
          </div>
          <div class="col-span-2">
            <div class="text-[11px] text-black/40">处理器</div>
            <div class="truncate text-[12px] text-black/75" :title="stats.cpu?.model || ''">
              {{ stats.cpu?.model || '—' }}
              <span v-if="cpuText() !== '—'" class="text-black/40">（{{ cpuText() }}）</span>
            </div>
          </div>
        </div>

        <div class="mt-3 flex items-center justify-between">
          <span class="text-[10px] text-black/35">更新于 {{ updatedText() }}</span>
          <button class="cursor-pointer text-[11px] text-[#007aff] outline-none hover:underline disabled:opacity-50"
            :disabled="loading" @click="load(true)">
            {{ loading ? '刷新中…' : '刷新' }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>
