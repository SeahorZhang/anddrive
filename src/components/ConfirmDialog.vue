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
        class="data-[state=open]:animate-in data-[state=open]:fade-in fixed inset-0 z-50 bg-black/30"
        @click="handleClose"
      />
      <DialogContent
        class="data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-black/8 bg-white p-5 shadow-[0_4px_16px_rgba(0,0,0,0.12)] outline-none"
        @pointer-down-outside.prevent="handleClose"
        @escape-key-down.prevent="handleClose"
      >
        <h3 class="mb-2 text-[13px] font-medium text-black/80">{{ title }}</h3>
        <p class="mb-5 text-[11px] leading-relaxed whitespace-pre-line text-black/50">
          {{ message }}
        </p>
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
