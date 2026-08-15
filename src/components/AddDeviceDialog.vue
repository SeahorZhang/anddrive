<script setup>
import { Motion, AnimatePresence } from 'motion-v'
import { renderSVG } from 'uqr'

const qrDataUrl = ref('')
const modelValue = defineModel({ default: false })

watch(modelValue, (newVal) => {
  console.log(1, modelValue)
  if (newVal) {
    generateQr()
  }
})

const generateQr = () => {
  const randPassword = String(Date.now() % 1000000).padStart(6, '0')
  const password = randPassword
  const ssid = `d${randPassword}`
  const qrContent = `WIFI:T:ADB;S:${ssid};P:${password};;`
  console.log(11, qrContent)
  const svgString = renderSVG(qrContent, { ecc: 'M', pixelSize: 8 })
  qrDataUrl.value = `data:image/svg+xml;base64,${btoa(svgString)}`
}
</script>

<template>
  <AnimatePresence>
    <Motion
      key="backdrop"
      v-if="modelValue"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-lg"
    >
    </Motion>
    <Motion
      key="dialog"
      class="fixed top-1/2 left-1/2 z-51 flex h-130 w-120 -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-4xl bg-white"
      v-if="modelValue"
      :initial="{ opacity: 0, scale: 0.8 }"
      :animate="{ opacity: 1, scale: 1 }"
      :exit="{ opacity: 0, scale: 0.4 }"
    >
      <!-- Header -->
      <div class="flex w-full items-center px-6 py-5">
        <h2 class="flex-1 text-lg font-semibold text-gray-900">扫码添加设备</h2>
        <button
          class="flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-gray-100"
          @click="modelValue = false"
        >
          <svg
            class="size-4.5 text-gray-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <!-- QR Code -->
      <div class="flex flex-1 items-center justify-center">
        <img :src="qrDataUrl" class="size-52 select-none" />
      </div>

      <!-- Footer -->
      <div class="px-8 pb-10 text-center text-sm text-gray-500">
        请确保小米设备在附近，已升级至小米澎湃OS 3
        及以上，并与本机登录相同小米账号、连接相同网络。打开小米设备的"相机"，扫描二维码添加设备。同步手机通知、传手机照片等
        AI 跨设备能力，需将手机升级至小米澎湃 OS 4 及以上。
      </div>
    </Motion>
  </AnimatePresence>
</template>
