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
      'focus-visible:ring-2 focus-visible:ring-accent/40',
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
        'bg-accent text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-accent-press active:brightness-90',
      variant === 'secondary' &&
        'border border-line bg-surface-2 text-ink-2 shadow-[0_1px_1px_rgba(0,0,0,0.05)] hover:bg-fill active:bg-fill-strong',
      variant === 'danger' &&
        'bg-[#ff3b30] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-[#f0332a] active:bg-[#e02d24] dark:bg-[#ff453a] dark:hover:bg-[#ff5c52] dark:active:bg-[#ff6961]',
      variant === 'default' && 'text-ink-3 hover:bg-fill hover:text-ink active:bg-fill-strong',
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
