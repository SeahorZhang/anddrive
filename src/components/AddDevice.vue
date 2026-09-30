<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from './BaseButton.vue'

const modelValue = defineModel({ default: false })
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-6 px-10 text-center">
    <div
      class="flex size-16 items-center justify-center rounded-[20px] bg-surface text-accent shadow-[0_2px_10px_rgba(0,0,0,0.08)] ring-1 ring-line"
    >
      <Icon icon="lucide:smartphone" :width="30" :height="30" />
    </div>

    <div class="space-y-1.5">
      <h1 class="text-[17px] font-semibold text-ink">连接你的 Android 设备</h1>
      <p class="mx-auto max-w-[300px] text-[12px] leading-relaxed text-ink-3">
        用 USB
        数据线连接手机并允许调试，设备会自动出现在右上角列表；也可以开启无线调试，扫描二维码完成配对。
      </p>
    </div>

    <BaseButton variant="primary" size="md" icon="lucide:plus" @click="modelValue = true">
      添加设备
    </BaseButton>
  </div>
</template>
