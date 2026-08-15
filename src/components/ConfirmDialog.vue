<script setup lang="ts">
import BaseButton from './BaseButton.vue'

defineProps({ title: String, message: String })
const modelValue = defineModel({ type: Boolean, required: true })

const emit = defineEmits(['confirm', 'cancel'])

const handleConfirm = () => {
  emit('confirm')
  modelValue.value = false
}
</script>

<template>
  <DialogRoot v-model:open="modelValue">
    <DialogPortal>
      <DialogOverlay
        class="data-[state=open]:animate-in data-[state=open]:fade-in fixed inset-0 z-50 bg-black/30"
      />
      <DialogContent
        class="data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-black/8 bg-white p-5 shadow-[0_4px_16px_rgba(0,0,0,0.12)] outline-none"
      >
        <h3 class="mb-2 text-[13px] font-medium text-black/80">断开连接</h3>
        <p class="mb-5 text-[11px] leading-relaxed whitespace-pre-line text-black/50">
          设备将被断开连接。
          <br /><br />
          手机端的配对记录仍会保留，设备可能会自动重连。
          <br /><br />
          如需彻底断开，请在手机上手动移除： 开发者选项 > 无线调试 > 已配对的设备 > 移除
        </p>
        <div class="flex justify-end gap-2">
          <BaseButton variant="secondary" size="sm" @click="modelValue = false"> 取消 </BaseButton>
          <BaseButton variant="danger" size="sm" @click="handleConfirm"> 确认移除 </BaseButton>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
