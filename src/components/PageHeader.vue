<script setup>
import { Icon } from '@iconify/vue'
import ConfirmDialog from './ConfirmDialog.vue'
import BaseButton from './BaseButton.vue'
import { updateState, requestUpdateInstall } from '@/update'

const props = defineProps({
  pageType: String,
  disconnecting: Boolean,
  disconnectError: { type: String, default: '' },
})
const showConfirm = ref(false)
const emit = defineEmits(['disconnect'])

const updateReady = computed(() => updateState.state === 'downloaded')
const updating = computed(() => updateState.state === 'installing')

async function handleInstall() {
  if (updating.value) return
  await requestUpdateInstall()
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
        style="-webkit-app-region: no-drag"
        class="absolute top-1/2 right-4 z-10 flex -translate-y-1/2 items-center gap-2"
      >
        <span
          v-if="updateState.state === 'downloading'"
          class="text-[11px] font-medium text-black/45 tabular-nums"
        >
          更新 {{ updateState.percent }}%
        </span>
        <span
          v-else-if="updateState.state === 'error' && updateState.message"
          :title="updateState.message"
          class="max-w-[180px] truncate text-[11px] font-medium text-[#ff3b30]"
        >
          更新失败
        </span>

        <button
          v-if="updateReady || updating"
          type="button"
          :disabled="updating"
          :title="updateState.version ? `新版本 ${updateState.version}` : '更新并重启'"
          class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-[#007aff] pr-3 pl-2.5 text-[12px] font-medium text-white shadow-[0_1px_3px_rgba(0,122,255,0.35)] transition-colors outline-none hover:bg-[#0071e3] focus-visible:ring-2 focus-visible:ring-[#007aff]/40 active:bg-[#0064d2] disabled:cursor-default disabled:opacity-70"
          @click="handleInstall"
        >
          <Icon
            :icon="updating ? 'lucide:refresh-cw' : 'lucide:download'"
            :width="14"
            :height="14"
            :class="updating && 'animate-spin'"
          />
          {{ updating ? '正在重启…' : '更新重启' }}
        </button>

        <TooltipRoot v-if="pageType === 'home'">
          <TooltipTrigger as-child>
            <BaseButton
              icon="lucide:unplug"
              icon-only
              :disabled="disconnecting"
              @click="showConfirm = true"
            />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent
              :side-offset="8"
              side="bottom"
              class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg"
            >
              断开连接
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
