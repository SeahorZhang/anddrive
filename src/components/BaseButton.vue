<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'

const {
  variant = 'default',
  icon,
  disabled,
  loading,
  size = 'sm',
  iconOnly,
} = defineProps({
  variant: {
    type: String,
    default: 'default', //'primary' | 'secondary' | 'danger'
  },
  icon: String,
  disabled: Boolean,
  loading: Boolean,
  size: {
    type: String,
    default: 'sm', //'sm' | 'md'
  },
  iconOnly: Boolean,
})

defineEmits(['click'])

const iconSize = computed(() => (size === 'md' ? 16 : 14))
</script>

<template>
  <button
    :disabled="disabled || loading"
    :class="[
      'relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none',
      'transition-[background-color,color,box-shadow] duration-150 outline-none',
      'focus-visible:ring-2 focus-visible:ring-[#007aff]/40',
      'disabled:cursor-not-allowed disabled:opacity-40',
      iconOnly
        ? size === 'md'
          ? 'size-8 rounded-[8px]'
          : 'size-7 rounded-[7px]'
        : size === 'md'
          ? 'h-8 gap-1.5 rounded-[8px] px-3.5 text-[13px]'
          : 'h-7 gap-1 rounded-[7px] px-2.5 text-[12px]',
      !iconOnly && 'font-medium',
      variant === 'primary' &&
        'bg-[#007aff] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-[#0071e3] active:bg-[#0064d2]',
      variant === 'secondary' &&
        'border border-black/10 bg-white text-black/70 shadow-[0_1px_1px_rgba(0,0,0,0.05)] hover:bg-black/[0.03] active:bg-black/[0.07]',
      variant === 'danger' &&
        'bg-[#ff3b30] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-[#f0332a] active:bg-[#e02d24]',
      variant === 'default' &&
        'text-black/50 hover:bg-black/[0.06] hover:text-black/80 active:bg-black/[0.1]',
    ]"
    @click="$emit('click')"
  >
    <Icon
      v-if="icon && !loading"
      :icon="icon"
      :width="iconSize"
      :height="iconSize"
      class="shrink-0"
    />
    <span
      v-if="loading"
      class="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
    />
    <slot />
  </button>
</template>
