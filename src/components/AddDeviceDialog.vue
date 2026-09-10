<script setup>
import { Motion, AnimatePresence } from 'motion-v'
import { renderSVG } from 'uqr'
import { Icon } from '@iconify/vue'
import { findDeviceApi, pairApi, resolveConnectAddressApi } from '@/api'

const randCode = () => String(Date.now() % 1000000).padStart(6, '0')

const modelValue = defineModel({ default: false })
const qrDataUrl = ref('')
const status = ref('idle') // idle-闲置 | waiting-等待 | error-错误
const statusMessage = ref('')
let password = ''
const emit = defineEmits(['paired'])

const start = async () => {
  password = randCode()
  const ssid = `d${randCode()}`
  qrDataUrl.value = `data:image/svg+xml;base64,${btoa(renderSVG(`WIFI:T:ADB;S:${ssid};P:${password};;`, { ecc: 'M', pixelSize: 8 }))}`

  status.value = 'waiting'
  statusMessage.value = '等待设备扫码…'

  const device = await findDeviceApi()
  statusMessage.value = `正在配对 ${device?.txt?.given_name || device?.device}…`
  try {
    await pairApi(device, password)
    statusMessage.value = '配对成功，开始建立连接…'
    const a = await resolveConnectAddressApi(device.name)
    localStorage.setItem('device', JSON.stringify(a))
    emit('paired')
  } catch (e) {
    status.value = 'error'
    statusMessage.value = `启动发现失败: ${e.message}`
  }
}

watch(modelValue, (bl) => {
  if (bl) start()
})
</script>

<template>
  <AnimatePresence>
    <Motion
      key="backdrop"
      v-if="modelValue"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      class="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]"
    />
    <Motion
      key="dialog"
      v-if="modelValue"
      :initial="{ opacity: 0, scale: 0.92, y: 8 }"
      :animate="{ opacity: 1, scale: 1, y: 0 }"
      :exit="{ opacity: 0, scale: 0.96 }"
      :transition="{ type: 'spring', stiffness: 420, damping: 32 }"
      class="fixed top-1/2 left-1/2 z-51 w-[380px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[20px] border border-white/60 bg-white/85 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur-2xl"
    >
      <div class="flex items-center justify-between px-5 pt-4 pb-1">
        <h2 class="text-[14px] font-semibold text-[#1d1d1f]">扫码添加设备</h2>
        <button
          class="flex size-6 cursor-pointer items-center justify-center rounded-full text-black/35 transition-colors hover:bg-black/[0.06] hover:text-black/60"
          @click="modelValue = false"
        >
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </div>

      <div class="flex flex-col items-center px-5 pt-3 pb-4">
        <div
          class="flex size-[216px] items-center justify-center rounded-[16px] bg-white p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)] ring-1 ring-black/5"
        >
          <img :src="qrDataUrl" class="size-full select-none" />
        </div>

        <div class="mt-4 flex h-4 items-center gap-2 text-[12px]">
          <span
            class="size-1.5 rounded-full"
            :class="status === 'error' ? 'bg-[#ff3b30]' : 'animate-pulse bg-[#007aff]'"
          />
          <span :class="status === 'error' ? 'text-[#ff3b30]' : 'text-black/55'">
            {{ statusMessage }}
          </span>
        </div>
      </div>

      <div
        class="border-t border-black/[0.06] bg-black/[0.02] px-5 py-4 text-[11px] leading-relaxed text-black/45"
      >
        请在 Android
        设备上开启无线调试，并确保设备与电脑连接到同一网络。打开无线调试中的“使用二维码配对设备”，扫描上方二维码完成配对。
      </div>
    </Motion>
  </AnimatePresence>
</template>
