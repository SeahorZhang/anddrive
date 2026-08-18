<script setup>
import BaseButton from './BaseButton.vue'

const modelValue = defineModel({ default: false })
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-end">
    <BaseButton variant="primary" size="md" @click="modelValue = true">添加设备</BaseButton>
  </div>
</template>
