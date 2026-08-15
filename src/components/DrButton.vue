<script setup vapor>
const { text } = defineProps({
  text: {
    type: String,
    required: true,
  },
})
</script>

<template>
  <div
    class="flex h-11.5 w-80 cursor-pointer items-center justify-center rounded-full bg-[#3482FF] font-medium text-white transition-colors hover:bg-[#2B6FE0]"
  >
    {{ text }}
  </div>
</template>
