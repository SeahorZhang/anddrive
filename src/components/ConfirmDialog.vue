<script setup>
import BaseButton from './BaseButton.vue'

const props = defineProps({
  title: { type: String, default: '确认操作' },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: '确认' },
  cancelLabel: { type: String, default: '取消' },
  loading: Boolean,
  error: { type: String, default: '' },
})
const modelValue = defineModel({ type: Boolean, required: true })
const emit = defineEmits(['confirm', 'cancel', 'close'])

function handleConfirm() {
  if (props.loading) return
  emit('confirm')
}

function handleCancel() {
  if (props.loading) return
  modelValue.value = false
  emit('cancel')
}

function handleClose() {
  if (props.loading) return
  emit('close')
}
</script>

<template>
  <DialogRoot v-model:open="modelValue">
    <DialogPortal>
      <DialogOverlay
        class="data-[state=open]:animate-in data-[state=open]:fade-in fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]"
        @click="handleClose"
      />
      <DialogContent
        class="data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-white/60 bg-white/90 p-5 shadow-[0_16px_48px_rgba(0,0,0,0.22)] backdrop-blur-2xl outline-none"
        @pointer-down-outside.prevent="handleClose"
        @escape-key-down.prevent="handleClose"
      >
        <DialogTitle class="mb-2 text-[13px] font-semibold text-[#1d1d1f]">{{ title }}</DialogTitle>
        <DialogDescription
          class="mb-5 text-[11px] leading-relaxed whitespace-pre-line text-black/50"
        >
          {{ message }}
        </DialogDescription>
        <p v-if="error" class="mb-4 rounded-md bg-red-500/10 px-2.5 py-2 text-[11px] text-red-600">
          {{ error }}
        </p>
        <div class="flex justify-end gap-2">
          <BaseButton variant="secondary" size="sm" :disabled="loading" @click="handleCancel">
            {{ cancelLabel }}
          </BaseButton>
          <BaseButton variant="danger" size="sm" :loading="loading" @click="handleConfirm">
            {{ loading ? '处理中…' : confirmLabel }}
          </BaseButton>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
