<script setup lang="ts">
import { ref } from 'vue'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import type { Device } from '../composables/useDevices'
import { Icon } from '@iconify/vue'
import BaseButton from './BaseButton.vue'
import BaseBadge from './BaseBadge.vue'

defineProps<{
  devices: Device[]
  currentSerial: string
  isLoading: boolean
}>()

const emit = defineEmits<{
  select: [serial: string]
  pairNew: []
}>()

const open = ref(false)
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-black/8 bg-white px-3 py-1.5 text-[11px] text-black/60 transition-colors hover:bg-gray-50"
    >
      <Icon icon="lucide:smartphone" class="h-3 w-3" />
      <span class="max-w-[120px] truncate">
        {{ devices.find((d) => d.serial === currentSerial)?.deviceName || '选择设备' }}
      </span>
      <Icon icon="lucide:chevron-down" class="h-3 w-3 text-black/30" />
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        class="z-50 w-56 rounded-xl border border-black/8 bg-white p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.12)]"
        :side-offset="4"
        align="start"
      >
        <div class="text-[10px] font-medium text-black/40 px-2 py-1">已连接设备</div>
        <BaseButton
          v-for="device in devices"
          :key="device.serial"
          variant="ghost"
          size="sm"
          class="w-full justify-start"
          :active="device.serial === currentSerial"
          @click="emit('select', device.serial); open = false"
        >
          <span
            class="h-1.5 w-1.5 rounded-full flex-shrink-0"
            :class="device.serial === currentSerial ? 'bg-green-500' : 'bg-black/15'"
          ></span>
          <span class="flex-1 truncate text-[11px] text-black/70">
            {{ device.deviceName || device.model }}
          </span>
          <BaseBadge
            variant="blue"
            :label="device.type === 'wireless' ? 'Wi-Fi' : 'USB'"
          />
        </BaseButton>

        <div class="my-1 border-t border-black/8"></div>

        <BaseButton
          variant="ghost"
          size="sm"
          icon="lucide:plus"
          class="w-full"
          @click="emit('pairNew'); open = false"
        >
          配对新设备
        </BaseButton>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
