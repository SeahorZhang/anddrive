<script setup>
/**
 * 通用开关。基于 reka-ui SwitchRoot，支持键盘与无障碍语义。
 */
const modelValue = defineModel({ type: Boolean, default: false })
const props = defineProps({
  disabled: Boolean,
})
</script>

<template>
  <SwitchRoot v-model="modelValue" :disabled="props.disabled"
    class="relative inline-flex h-5 w-[34px] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-black/15 transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[#007aff]/40 data-[state=checked]:bg-[#34c759]">
    <SwitchThumb
      class="pointer-events-none block size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0" />
  </SwitchRoot>
</template>
