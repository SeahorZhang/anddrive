<script setup>
import BaseButton from './BaseButton.vue'

defineProps({
  error: { type: String, default: '' },
})
const modelValue = defineModel({ default: false })
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-end gap-3 pb-2">
    <p v-if="error" class="max-w-80 text-center text-xs leading-relaxed text-red-500">
      {{ error }}
    </p>
    <BaseButton variant="primary" size="md" @click="modelValue = true">添加设备</BaseButton>
  </div>
</template>
