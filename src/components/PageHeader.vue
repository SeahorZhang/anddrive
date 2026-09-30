<script setup>
import { Icon } from '@iconify/vue'
import ConfirmDialog from './ConfirmDialog.vue'
import BaseButton from './BaseButton.vue'
import {
  stateText,
  stateClass,
  stateDotClass,
  deviceHint,
  deviceTransports,
  transportText,
} from '@/utils/deviceState'

const props = defineProps({
  pageType: String,
  disconnecting: Boolean,
  disconnectError: { type: String, default: '' },
  devices: { type: Array, default: () => [] },
  // 当前活动设备：断开文案要按它的传输类型走（USB 不摘 ADB 传输），列表里要标出「当前」
  activeDevice: { type: Object, default: null },
})
const showConfirm = ref(false)
// 设备下拉的开合状态：交给父级决定什么时候拉设备列表（只在展开时轮询）
const menuOpen = ref(false)
const emit = defineEmits([
  'disconnect',
  'openSettings',
  'closeSettings',
  'switchDevice',
  'deviceMenuChange',
  'addDevice',
])

const isUsb = computed(() => props.activeDevice?.transport === 'usb')

// 触发器上直接显示当前设备名，没连上时退回「切换设备」
const deviceName = computed(() => props.activeDevice?.label || props.activeDevice?.name || '切换设备')

watch(menuOpen, (open) => emit('deviceMenuChange', open))

const disconnectMessage = computed(() =>
  isUsb.value
    ? '将在 AndDrive 中断开这台 USB 设备（停止镜像与应用读取），数据线连接与手机上的调试授权都会保留。'
    : '将断开当前无线 ADB 连接。手机端的配对记录仍会保留，之后可以再次连接。若设备已经离线，断开操作仍会视为成功。',
)

/** 列表行的身份：同一台设备的有线/无线两条传输合并后 address 会不同，优先按稳定标识。 */
function deviceKey(device) {
  return device?.stableId || device?.address || ''
}

/** 下拉里这行是不是正在用的那台。 */
function isCurrent(device) {
  return !!props.activeDevice && !!deviceKey(device) && deviceKey(device) === deviceKey(props.activeDevice)
}

/** 选中另一台设备：关掉下拉，把切换交给父级（它负责给上一台收摊）。 */
function pickDevice(device) {
  if (isCurrent(device) || !device.connected) return
  menuOpen.value = false
  emit('switchDevice', device)
}

/** 从下拉去配对新设备（二维码弹窗在 App.vue，始终挂着）。 */
function openPairDialog() {
  menuOpen.value = false
  emit('addDevice')
}

const actions = computed(() => {
  if (props.pageType === 'settings') {
    return [{ icon: 'lucide:arrow-left', tip: '返回', event: 'closeSettings' }]
  }
  // 只有首页（= 连着设备）才有设置入口：投屏参数里那一串「这台设备能编什么」的列表
  // 没有设备就算不出来，给个半空的页面进去只会误导人。
  if (props.pageType !== 'home') return []
  return [{ icon: 'lucide:unplug', tip: '断开连接', event: 'disconnect' }]
    .concat([{ icon: 'lucide:settings', tip: '设置', event: 'openSettings' }])
})

function onAction(event) {
  if (event === 'disconnect') showConfirm.value = true
  else emit(event)
}

function handleConfirm() {
  emit('disconnect')
}

function handleCancel() {
  if (!props.disconnecting) showConfirm.value = false
}

watch(
  () => props.pageType,
  (pageType) => {
    // 离开首页：确认框和设备下拉一起收掉，否则下拉关着但父级还在为它轮询。
    if (pageType !== 'home') {
      showConfirm.value = false
      menuOpen.value = false
    }
  },
)
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="relative">
      <div style="-webkit-app-region: drag" class="h-11 w-full"></div>

      <div v-if="pageType !== 'loading'" style="-webkit-app-region: no-drag"
        class="absolute top-1/2 right-4 z-10 flex -translate-y-1/2 items-center gap-1">
        <ScrcpySessions />

        <!-- 切换设备：首页右上角的下拉，展开期间父级才轮询设备列表 -->
        <PopoverRoot v-if="pageType === 'home'" v-model:open="menuOpen">
          <PopoverTrigger as-child>
            <BaseButton variant="secondary" :title="`切换设备：${deviceName}`" aria-label="切换设备">
              <span class="max-w-[200px] truncate font-semibold">{{ deviceName }}</span>
              <Icon icon="lucide:chevron-down" :width="14" :height="14"
                class="shrink-0 transition-transform duration-150" :class="menuOpen ? 'rotate-180' : ''" />
            </BaseButton>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent side="bottom" align="end" :side-offset="8"
              class="z-50 w-[300px] rounded-[12px] border border-line bg-surface p-1.5 shadow-pop outline-none backdrop-blur-xl">
              <div class="px-2 pt-1 pb-1.5 text-[11px] font-medium text-ink-3">切换设备</div>

              <button v-for="item in devices" :key="deviceKey(item)" type="button"
                class="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
                :class="isCurrent(item) ? 'bg-accent/[0.08]' : 'hover:bg-fill disabled:hover:bg-transparent'"
                :disabled="!item.connected" @click="pickDevice(item)">
                <div
                  class="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-gradient-to-b from-[#5ac8fa] to-accent text-white shadow-[0_1px_2px_rgba(0,122,255,0.3)]">
                  <Icon icon="lucide:smartphone" :width="14" :height="14" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate text-[12.5px] font-medium text-ink">
                      {{ item.label || item.name || '未知设备' }}
                    </span>
                    <span v-for="transport in deviceTransports(item)" :key="transport"
                      class="shrink-0 rounded-[4px] bg-fill px-1 py-0.5 text-[10px] leading-none font-medium text-ink-3">
                      {{ transportText(transport) }}
                    </span>
                  </div>
                  <div class="mt-0.5 truncate text-[11px] text-ink-3">
                    {{ deviceHint(item) }}
                  </div>
                </div>
                <Icon v-if="isCurrent(item)" icon="lucide:check" :width="15" :height="15"
                  class="shrink-0 text-accent" />
                <span v-else class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                  :class="stateClass(item)">
                  <span class="size-1.5 rounded-full" :class="stateDotClass(item)" />
                  {{ stateText(item) }}
                </span>
              </button>

              <div v-if="!devices.length" class="px-2 py-2 text-[12px] text-ink-3">正在查找设备…</div>

              <div class="mx-1.5 my-1 h-px bg-line" />

              <button type="button"
                class="flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left text-[12.5px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-fill hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
                @click="openPairDialog">
                <Icon icon="lucide:qr-code" :width="15" :height="15" class="shrink-0" />
                扫码配对新设备
              </button>
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>

        <TooltipRoot v-for="action in actions" :key="action.event">
          <TooltipTrigger as-child>
            <BaseButton :icon="action.icon" icon-only :disabled="action.event === 'disconnect' && disconnecting"
              @click="onAction(action.event)" />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent :side-offset="8" side="bottom"
              class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg">
              {{ action.tip }}
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
      </div>

      <ConfirmDialog v-model="showConfirm" title="断开连接" :message="disconnectMessage" confirm-label="断开"
        :loading="disconnecting" :error="disconnectError" @confirm="handleConfirm" @cancel="handleCancel"
        @close="handleCancel" />
    </div>
  </TooltipProvider>
</template>
