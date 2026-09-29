<script setup>
import { Icon } from '@iconify/vue'
import AppList from './AppList.vue'
import DeviceStats from './DeviceStats.vue'
import StoragePanel from './StoragePanel.vue'

const props = defineProps({
  device: {
    type: Object,
    required: true,
  },
})

const deviceTitle = computed(() => {
  return props.device.label || props.device.name || '未知设备'
})

// 外观照 BaseButton 的 icon-only + default 变体（size-7 / rounded-[7px] / 图标 14）。
// 不复用组件是因为它 `defineEmits(['click'])`：Reka 的 Trigger 在 as-child 下把 onClick
// 当普通属性传下来，被 emits 声明吃掉后就落不到真正的 <button> 上 —— 点击挂不上，弹层打不开。
const TRIGGER_CLASS =
  'relative inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] whitespace-nowrap select-none text-black/50 transition-[background-color,color,box-shadow] duration-150 outline-none hover:bg-black/[0.06] hover:text-black/80 active:bg-black/[0.1] focus-visible:ring-2 focus-visible:ring-[#007aff]/40'
const POPOVER_CLASS =
  'z-50 w-[346px] rounded-[12px] border border-black/[0.08] bg-white/95 p-3.5 shadow-[0_10px_34px_rgba(0,0,0,0.18)] outline-none backdrop-blur-xl'
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-5">
    <div class="mb-3.5 gap-3 px-0.5">
      <div class="flex min-w-0 items-center gap-1.5">
        <div class="truncate text-[15px] leading-tight font-semibold text-[#1d1d1f]">
          {{ deviceTitle }}
        </div>
        <!-- 设备信息收在这里：它不是每次都看的，摊在列表上方会把应用挤下去。
             弹层打开时才挂载 DeviceStats，所以「点开即拉一次」，不占首页的加载。 -->
        <PopoverRoot>
          <PopoverTrigger as-child>
            <button type="button" aria-label="设备信息" title="设备信息" :class="TRIGGER_CLASS">
              <Icon icon="lucide:info" :width="14" :height="14" class="shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent side="bottom" align="start" :side-offset="6" :class="POPOVER_CLASS">
              <DeviceStats :serial="device.address" />
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
        <!-- 存储单独一个入口：容量、卷列表要占的地方比设备信息里的两行多，
             塞进那个弹层会把身份信息挤到折叠线以下。 -->
        <PopoverRoot>
          <PopoverTrigger as-child>
            <button type="button" aria-label="存储" title="存储" :class="TRIGGER_CLASS">
              <Icon icon="lucide:hard-drive" :width="14" :height="14" class="shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent side="bottom" align="start" :side-offset="6" :class="POPOVER_CLASS">
              <StoragePanel :serial="device.address" :device-label="deviceTitle" />
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
      </div>
      <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-black/45">
        <span class="size-1.5 rounded-full bg-[#34c759] shadow-[0_0_0_2px_rgba(52,199,89,0.18)]" />
        <span>已连接</span>
        <template v-if="device.transport === 'usb'">
          <span class="text-black/20">·</span>
          <span>USB</span>
        </template>
        <span class="text-black/20">·</span>
        <span class="truncate">{{ device.displayAddress || device.address }}</span>
      </div>
    </div>
    <AppList :address="device.address" />
  </div>
</template>
