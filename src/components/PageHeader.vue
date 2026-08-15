<script setup>
import ConfirmDialog from './ConfirmDialog.vue'
import BaseButton from './BaseButton.vue'
const { pageType } = defineProps(['pageType'])
const showConfirm = ref(false)
const emit = defineEmits(['disconnect'])

function handleConfirm() {
  emit('disconnect')
}
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="relative">
      <!-- 可拖拽标题栏 -->
      <div style="-webkit-app-region: drag" class="h-12 w-full"></div>

      <!-- 设备选择器 + 操作按钮 -->
      <div
        style="-webkit-app-region: no-drag"
        class="absolute top-1/2 right-4 z-10 flex -translate-y-1/2 items-center gap-1"
        v-if="pageType === 'home'"
      >
        <TooltipRoot>
          <TooltipTrigger as-child>
            <BaseButton icon="lucide:unplug" icon-only @click="showConfirm = true" />
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

      <ConfirmDialog v-model="showConfirm" @confirm="handleConfirm" />
    </div>
  </TooltipProvider>
</template>
