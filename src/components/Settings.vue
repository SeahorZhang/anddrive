<script setup>
/* global __BUILD_TIME__ */
import { Icon } from '@iconify/vue'
import packageJson from '../../package.json'
import helperVersion from '../../resources/helper-app.version.json'

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

const rows = [
  { label: '应用版本', value: `v${packageJson.version}` },
  { label: '应用构建时间', value: formatTime(__BUILD_TIME__) },
  { label: 'Helper 版本', value: `v${helperVersion.versionName} (${helperVersion.versionCode})` },
  { label: 'Helper 构建时间', value: formatTime(helperVersion.builtAt) },
]
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-5">
    <div class="mb-3.5 flex items-center gap-3 px-0.5">
      <div
        class="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-b from-[#5ac8fa] to-[#007aff] text-white shadow-[0_1px_3px_rgba(0,122,255,0.35)]"
      >
        <Icon icon="lucide:settings" :width="18" :height="18" />
      </div>
      <div class="min-w-0">
        <div class="text-[15px] leading-tight font-semibold text-[#1d1d1f]">设置</div>
        <div class="mt-0.5 text-[11px] text-black/45">AndDrive</div>
      </div>
    </div>

    <div
      class="divide-y divide-black/[0.06] overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur"
    >
      <div v-for="row in rows" :key="row.label" class="flex items-center justify-between px-4 py-3">
        <span class="text-[13px] text-black/70">{{ row.label }}</span>
        <span class="text-[12px] tabular-nums text-black/45">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>
