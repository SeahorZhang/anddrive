<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from './BaseButton.vue'

defineProps({
  version: { type: String, default: '' },
  releaseNotes: { type: String, default: '' },
})
const modelValue = defineModel({ type: Boolean, required: true })
</script>

<template>
  <DialogRoot v-model:open="modelValue">
    <DialogPortal>
      <DialogOverlay
        class="data-[state=open]:animate-in data-[state=open]:fade-in fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]"
      />
      <DialogContent
        class="data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 flex max-h-[70vh] w-[340px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[16px] border border-white/60 bg-white/90 p-5 shadow-[0_16px_48px_rgba(0,0,0,0.22)] backdrop-blur-2xl outline-none"
        @escape-key-down.prevent="modelValue = false"
      >
        <div class="mb-2 flex items-center gap-2">
          <span
            class="flex size-7 items-center justify-center rounded-[8px] bg-gradient-to-b from-[#5ac8fa] to-[#007aff] text-white"
          >
            <Icon icon="lucide:refresh-cw" :width="15" :height="15" />
          </span>
          <h3 class="text-[13px] font-semibold text-[#1d1d1f]">更新内容</h3>
          <span v-if="version" class="text-[11px] text-black/40">{{ version }}</span>
        </div>

        <div class="min-h-0 flex-1 overflow-auto rounded-[10px] bg-black/[0.03] p-3">
          <p class="text-[11px] leading-relaxed whitespace-pre-wrap text-black/60">
            {{ releaseNotes || '本次更新暂无说明。' }}
          </p>
        </div>

        <div class="mt-4 flex justify-end">
          <BaseButton variant="primary" size="sm" @click="modelValue = false">开始使用</BaseButton>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
