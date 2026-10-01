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
const emit = defineEmits(['confirm', 'cancel'])

function handleConfirm() {
  if (props.loading) return
  emit('confirm')
}

// 取消按钮 / 点遮罩 / Esc 都是同一个出口：不确认并关闭。
function handleClose() {
  if (props.loading) return
  modelValue.value = false
  emit('cancel')
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
        class="data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-line bg-surface p-5 shadow-pop backdrop-blur-2xl outline-none"
        @pointer-down-outside.prevent="handleClose"
        @escape-key-down.prevent="handleClose"
      >
        <DialogTitle class="mb-2 text-[13px] font-semibold text-ink">{{ title }}</DialogTitle>
        <DialogDescription class="mb-5 text-[11px] leading-relaxed whitespace-pre-line text-ink-2">
          {{ message }}
        </DialogDescription>
        <p
          v-if="error"
          class="mb-4 rounded-md bg-[#ff3b30]/12 px-2.5 py-2 text-[11px] text-[#d70015] dark:text-[#ff6961]"
        >
          {{ error }}
        </p>
        <div class="flex justify-end gap-2">
          <BaseButton variant="secondary" size="sm" :disabled="loading" @click="handleClose">
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
