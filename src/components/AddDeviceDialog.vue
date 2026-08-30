<script setup>
import { Motion, AnimatePresence } from 'motion-v'
import { renderSVG } from "uqr";
import { findDeviceApi, pairApi, resolveConnectAddressApi } from '@/api'

const randCode = () => String(Date.now() % 1000000).padStart(6, "0");

const modelValue = defineModel({ default: false })
const qrDataUrl = ref("");
const status = ref("idle"); // idle-闲置 | waiting-等待 | error-错误
const statusMessage = ref("");
let password = "";
const emit = defineEmits(['paired'])

const start = async () => {
  password = randCode();
  const ssid = `d${randCode()}`;
  qrDataUrl.value = `data:image/svg+xml;base64,${btoa(renderSVG(`WIFI:T:ADB;S:${ssid};P:${password};;`, { ecc: "M", pixelSize: 8 }))}`;

  status.value = "waiting";
  statusMessage.value = "等待设备扫码...";

  const device = await findDeviceApi()
  statusMessage.value = `正在配对 ${device?.txt?.given_name || device?.device}...`;
  try {
    await pairApi(device, password);
    statusMessage.value = "配对成功，开始建立连接...";
    const a = await resolveConnectAddressApi(device.name)
    localStorage.setItem('device', JSON.stringify(a))
    emit('paired')
  } catch (e) {
    status.value = "error";
    statusMessage.value = `启动发现失败: ${e.message}`;
  }
};

watch(modelValue, (bl) => {
  if (bl) start()
})
</script>

<template>
  <AnimatePresence>
    <Motion key="backdrop" v-if="modelValue" :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" />
    <Motion key="dialog" v-if="modelValue" :initial="{ opacity: 0, scale: 0.8 }" :animate="{ opacity: 1, scale: 1 }"
      :exit="{ opacity: 0, scale: 0.4 }"
      class="fixed top-1/2 left-1/2 z-51 flex h-130 w-120 -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-4xl bg-white">
      <div class="flex w-full items-center px-6 py-5">
        <h2 class="flex-1 text-lg font-semibold text-gray-900">扫码添加设备</h2>
        <button
          class="flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-gray-100"
          @click="modelValue = false">
          <svg class="size-4.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="flex flex-1 items-center justify-center">
        <img :src="qrDataUrl" class="size-52 select-none" />
      </div>

      <div class="px-8 pb-8 text-center text-sm">
        <span :class="{
          'text-gray-500': status === 'waiting',
          'text-red-500': status === 'error',
        }">{{ statusMessage }}</span>
      </div>

      <div class="px-8 pb-10 text-center text-sm text-gray-500">
        请在 Android
        设备上开启无线调试，并确保设备与电脑连接到同一网络。打开无线调试中的“使用二维码配对设备”，扫描上方二维码完成配对。
      </div>
    </Motion>
  </AnimatePresence>
</template>
