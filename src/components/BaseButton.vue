<script setup lang="ts">
import { Icon } from '@iconify/vue'

const { variant, icon, disabled, loading, size, iconOnly } = defineProps({
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
</script>

<template>
  <button
    :disabled="disabled || loading"
    :class="[
      'inline-flex cursor-pointer items-center justify-center transition-all disabled:cursor-not-allowed disabled:opacity-40',
      iconOnly
        ? 'rounded-md p-1.5'
        : size === 'sm'
          ? 'gap-1 rounded-md px-2 py-1 text-[12px]'
          : 'gap-2 rounded-lg px-4 py-2.5 text-[12px]',
      variant === 'primary' && 'bg-blue-500 font-medium text-white hover:bg-blue-600',
      variant === 'secondary' &&
        'border border-black/8 font-medium text-black/50 hover:bg-gray-50 hover:text-black/70',
      variant === 'danger' && 'bg-red-500 font-medium text-white hover:bg-red-600',
      variant === 'default' &&
        'border border-transparent text-black/40 hover:bg-black/5 hover:text-black/60',
      variant === 'default' && !iconOnly && 'rounded-md px-2.5 py-1 text-[12px]',
    ]"
    @click="$emit('click')"
  >
    <Icon v-if="icon && !loading" :icon="icon" />
    <div
      v-if="loading"
      class="animate-spin rounded-full border-2 border-current border-t-transparent"
    ></div>
    <slot />
  </button>
</template>
