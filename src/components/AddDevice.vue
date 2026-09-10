<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from './BaseButton.vue'

const modelValue = defineModel({ default: false })
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-6 px-10 text-center">
    <div
      class="flex size-16 items-center justify-center rounded-[20px] bg-white/70 text-[#007aff] shadow-[0_2px_10px_rgba(0,0,0,0.08)] ring-1 ring-black/5"
    >
      <Icon icon="lucide:smartphone" :width="30" :height="30" />
    </div>

    <div class="space-y-1.5">
      <h1 class="text-[17px] font-semibold text-[#1d1d1f]">连接你的 Android 设备</h1>
      <p class="mx-auto max-w-[280px] text-[12px] leading-relaxed text-black/45">
        在手机开启无线调试后，扫描二维码即可完成配对，并在这里浏览已安装的应用。
      </p>
    </div>

    <BaseButton variant="primary" size="md" icon="lucide:plus" @click="modelValue = true">
      添加设备
    </BaseButton>
  </div>
</template>
