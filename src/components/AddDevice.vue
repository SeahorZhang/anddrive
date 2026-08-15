<script setup>
import DrButton from './DrButton.vue'

const modelValue = defineModel({ default: false })
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-end">
    2323-{{ modelValue }}
    <DrButton text="添加设备" @click="modelValue = true" />
  </div>
</template>
