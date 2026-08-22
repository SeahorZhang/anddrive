<script setup>
import BaseButton from './BaseButton.vue'
import DiagnosticsPanel from './DiagnosticsPanel.vue'

defineProps({
  error: { type: String, default: '' },
})
const modelValue = defineModel({ default: false })

const showDiagnostics = ref(false)
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-end gap-3 pb-2">
    <p v-if="error" class="max-w-80 text-center text-xs leading-relaxed text-red-500">
      {{ error }}
    </p>
    <BaseButton variant="primary" size="md" @click="modelValue = true">添加设备</BaseButton>
    <button
      class="cursor-pointer text-[11px] text-black/35 transition-colors hover:text-black/60"
      @click="showDiagnostics = !showDiagnostics"
    >
      {{ showDiagnostics ? '收起诊断' : '连接诊断' }}
    </button>
    <DiagnosticsPanel v-if="showDiagnostics" />
  </div>
</template>
