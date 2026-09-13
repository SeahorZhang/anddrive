<script setup>
import { Icon } from '@iconify/vue'
import ConfirmDialog from './ConfirmDialog.vue'
import BaseButton from './BaseButton.vue'

const props = defineProps({
  pageType: String,
  disconnecting: Boolean,
  disconnectError: { type: String, default: '' },
  devices: { type: Array, default: () => [] },
})
const showConfirm = ref(false)
const emit = defineEmits(['disconnect', 'openSettings', 'closeSettings', 'connectDevice'])

const actions = computed(() => {
  if (props.pageType === 'settings') {
    return [{ icon: 'lucide:arrow-left', tip: '返回', event: 'closeSettings' }]
  }
  const list = []
  if (props.pageType === 'home')
    list.push({ icon: 'lucide:unplug', tip: '断开连接', event: 'disconnect' })
  list.push({ icon: 'lucide:settings', tip: '设置', event: 'openSettings' })
  return list
})

function onAction(event) {
  if (event === 'disconnect') showConfirm.value = true
  else emit(event)
}

function handleConfirm() {
  emit('disconnect')
}

function handleCancel() {
  if (!props.disconnecting) showConfirm.value = false
}

watch(
  () => props.pageType,
  (pageType) => {
    if (pageType !== 'home') showConfirm.value = false
  },
)
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="relative">
      <div style="-webkit-app-region: drag" class="h-11 w-full"></div>

      <div v-if="pageType !== 'loading'" style="-webkit-app-region: no-drag"
        class="absolute top-1/2 right-4 z-10 flex -translate-y-1/2 items-center gap-1">
        <ScrcpySessions />
        <TooltipRoot v-for="action in actions" :key="action.event">
          <TooltipTrigger as-child>
            <BaseButton :icon="action.icon" icon-only :disabled="action.event === 'disconnect' && disconnecting"
              @click="onAction(action.event)" />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent :side-offset="8" side="bottom"
              class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg">
              {{ action.tip }}
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
      </div>

      <ConfirmDialog v-model="showConfirm" title="断开连接"
        message="将断开当前无线 ADB 连接。手机端的配对记录仍会保留，之后可以再次连接。若设备已经离线，断开操作仍会视为成功。" confirm-label="断开" :loading="disconnecting"
        :error="disconnectError" @confirm="handleConfirm" @cancel="handleCancel" @close="handleCancel" />

      <div v-if="devices.length && pageType === 'addDevice'" style="-webkit-app-region: no-drag"
        class="absolute top-12 right-4 z-60 flex w-72 flex-col gap-2">
        <div v-for="device in devices" :key="device.address"
          class="flex items-center gap-3 rounded-[14px] border border-white/70 bg-white/85 p-3 text-left shadow-[0_8px_30px_rgba(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl">
          <div
            class="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-b from-[#5ac8fa] to-[#007aff] text-white shadow-[0_1px_3px_rgba(0,122,255,0.35)]">
            <Icon icon="lucide:smartphone" :width="18" :height="18" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-[13px] font-semibold text-[#1d1d1f]">
                {{ device.label || device.name || '未知设备' }}
              </span>
              <span class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none" :class="device.connected
                ? 'bg-[#34c759]/12 text-[#248a3d]'
                : 'bg-black/[0.06] text-black/40'
                ">
                <span class="size-1.5 rounded-full" :class="device.connected ? 'bg-[#34c759]' : 'bg-black/25'" />
                {{ device.connected ? '可连接' : '离线' }}
              </span>
            </div>
            <div class="mt-0.5 truncate text-[11px] text-black/45">
              {{ device.displayAddress || device.address }}
            </div>
          </div>
          <BaseButton variant="primary" size="sm" :disabled="!device.connected" @click="emit('connectDevice', device)">
            连接
          </BaseButton>
        </div>
      </div>
    </div>
  </TooltipProvider>
</template>
