<script setup>
import { Motion, AnimatePresence } from 'motion-v'
import { Icon } from '@iconify/vue'
import BaseButton from './BaseButton.vue'

const modelValue = defineModel({ default: false })
const props = defineProps({
  info: { type: Object, default: null },
})

/** 单台设备上的应用详情行 */
const rows = computed(() => {
  const info = props.info
  if (!info) return []
  const version = info.versionName
    ? `${info.versionName}${info.versionCode ? ` (${info.versionCode})` : ''}`
    : info.versionCode
      ? String(info.versionCode)
      : '—'
  const sdk =
    info.targetSdk != null || info.minSdk != null
      ? `target ${info.targetSdk ?? '—'} · min ${info.minSdk ?? '—'}`
      : '—'
  return [
    { icon: 'lucide:tag', label: '包名', value: info.packageName || '—' },
    { icon: 'lucide:hash', label: '版本', value: version },
    { icon: 'lucide:shield', label: 'SDK', value: sdk },
    { icon: 'lucide:calendar', label: '安装时间', value: info.firstInstallTime || '—' },
    { icon: 'lucide:clock', label: '更新时间', value: info.lastUpdateTime || '—' },
    { icon: 'lucide:database', label: '安装来源', value: info.installerPackageName || '—' },
  ]
})

const apkPaths = computed(() => props.info?.apkPaths || [])
</script>

<template>
  <AnimatePresence>
    <Motion
      key="backdrop"
      v-if="modelValue"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      class="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]"
    />
    <Motion
      key="dialog"
      v-if="modelValue"
      :initial="{ opacity: 0, scale: 0.94, y: 8 }"
      :animate="{ opacity: 1, scale: 1, y: 0 }"
      :exit="{ opacity: 0, scale: 0.96 }"
      :transition="{ type: 'spring', stiffness: 420, damping: 32 }"
      class="fixed top-1/2 left-1/2 z-51 w-[420px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[18px] border border-white/60 bg-white/90 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur-2xl"
    >
      <div class="flex items-center justify-between px-5 pt-4 pb-2">
        <h2 class="text-[14px] font-semibold text-[#1d1d1f]">应用信息</h2>
        <button
          class="flex size-6 cursor-pointer items-center justify-center rounded-full text-black/35 transition-colors hover:bg-black/[0.06] hover:text-black/60"
          @click="modelValue = false"
        >
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </div>

      <div class="max-h-[60vh] overflow-y-auto px-5 pb-3">
        <div class="divide-y divide-black/[0.06] overflow-hidden rounded-[12px] border border-black/[0.06]">
          <div v-for="row in rows" :key="row.label" class="flex items-start gap-3 px-3.5 py-2.5">
            <Icon :icon="row.icon" :width="14" :height="14" class="mt-0.5 shrink-0 text-black/35" />
            <span class="w-16 shrink-0 text-[12px] text-black/45">{{ row.label }}</span>
            <span class="min-w-0 flex-1 text-right text-[12px] break-all text-black/75">
              {{ row.value }}
            </span>
          </div>
        </div>

        <div v-if="apkPaths.length" class="mt-3">
          <div class="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium text-black/40">
            <Icon icon="lucide:hard-drive" :width="11" :height="11" />
            APK 路径
          </div>
          <div class="flex flex-col gap-1 rounded-[12px] bg-black/[0.04] p-2.5">
            <span v-for="apk in apkPaths" :key="apk" class="text-[11px] break-all text-black/55">
              {{ apk }}
            </span>
          </div>
        </div>
      </div>

      <div class="flex justify-end px-5 pt-1 pb-4">
        <BaseButton variant="secondary" @click="modelValue = false">关闭</BaseButton>
      </div>
    </Motion>
  </AnimatePresence>
</template>
