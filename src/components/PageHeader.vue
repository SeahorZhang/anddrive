<script setup>
import ConfirmDialog from './ConfirmDialog.vue'
import BaseButton from './BaseButton.vue'

const props = defineProps({
  pageType: String,
  disconnecting: Boolean,
  disconnectError: { type: String, default: '' },
})
const showConfirm = ref(false)
const emit = defineEmits(['disconnect', 'openSettings', 'closeSettings'])

const actions = computed(() => {
  if (props.pageType === 'settings') {
    return [{ icon: 'lucide:arrow-left', tip: '返回', event: 'closeSettings' }]
  }
  const list = []
  if (props.pageType === 'home') list.push({ icon: 'lucide:unplug', tip: '断开连接', event: 'disconnect' })
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

      <div
        v-if="pageType !== 'loading'"
        style="-webkit-app-region: no-drag"
        class="absolute top-1/2 right-4 z-10 flex -translate-y-1/2 items-center gap-1"
      >
        <TooltipRoot v-for="action in actions" :key="action.event">
          <TooltipTrigger as-child>
            <BaseButton
              :icon="action.icon"
              icon-only
              :disabled="action.event === 'disconnect' && disconnecting"
              @click="onAction(action.event)"
            />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent
              :side-offset="8"
              side="bottom"
              class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg"
            >
              {{ action.tip }}
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
      </div>

      <ConfirmDialog
        v-model="showConfirm"
        title="断开连接"
        message="将断开当前无线 ADB 连接。手机端的配对记录仍会保留，之后可以再次连接。若设备已经离线，断开操作仍会视为成功。"
        confirm-label="断开"
        :loading="disconnecting"
        :error="disconnectError"
        @confirm="handleConfirm"
        @cancel="handleCancel"
        @close="handleCancel"
      />
    </div>
  </TooltipProvider>
</template>
