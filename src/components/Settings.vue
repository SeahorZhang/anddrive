<script setup>
/* global __BUILD_TIME__, __APP_CHANNEL__, __APP_VERSION__ */
import helperVersion from '../../resources/helper-app.version.json'

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

const sections = [
  {
    title: '应用',
    rows: [
      { label: '版本', value: `v${__APP_VERSION__}` },
      { label: '通道', value: __APP_CHANNEL__ === 'beta' ? 'Beta' : '正式' },
      { label: '构建时间', value: formatTime(__BUILD_TIME__) },
    ],
  },
  {
    title: 'Helper',
    rows: [
      { label: '版本', value: `v${helperVersion.versionName} (${helperVersion.versionCode})` },
      { label: '构建时间', value: formatTime(helperVersion.builtAt) },
    ],
  },
]
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-5">
    <section v-for="section in sections" :key="section.title">
      <div class="mb-1.5 px-1 text-[11px] font-medium text-black/40">{{ section.title }}</div>
      <div
        class="divide-y divide-black/[0.06] overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur"
      >
        <div
          v-for="row in section.rows"
          :key="row.label"
          class="flex items-center justify-between px-4 py-3"
        >
          <span class="text-[13px] text-black/70">{{ row.label }}</span>
          <span class="text-[12px] tabular-nums text-black/45">{{ row.value }}</span>
        </div>
      </div>
    </section>
  </div>
</template>
