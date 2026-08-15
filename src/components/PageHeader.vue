<script setup>
import { Icon } from '@iconify/vue'
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
      >
        <TooltipRoot>
          <TooltipTrigger as-child>
            <button
              class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md hover:bg-black/5"
            >
              <Icon icon="lucide:unplug" class="h-4 w-4" />
            </button>
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
    </div>
  </TooltipProvider>
</template>
