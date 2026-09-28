<script setup>
import { Motion, AnimatePresence } from 'motion-v'
import { renderSVG } from 'uqr'
import { Icon } from '@iconify/vue'
import { findDeviceApi, pairApi, resolveConnectAddressApi } from '@/api'

const randCode = () => String(Date.now() % 1000000).padStart(6, '0')

/**
 * 等待设备出现在 `_adb-tls-pairing` 的上限。给这么长是因为这一段完全取决于人
 * 在手机上翻到「无线调试 → 使用二维码配对设备」并扫码，超过这个时长基本就是
 * 没开对页面，继续转圈只是骗人。
 */
const PAIRING_TIMEOUT_MS = 90_000

const modelValue = defineModel({ default: false })
const qrDataUrl = ref('')
const status = ref('idle') // idle-闲置 | waiting-等待 | error-错误
const statusMessage = ref('')
const emit = defineEmits(['paired'])

// 主进程那条发现轮询（`waitForMdnsService`）**没有超时、也不会 reject**（见 docs/TODO.md D9），
// 所以「取消」只能在我们这侧做：换掉令牌，让已经发出的请求迟到时不再生效。
// 组件本身在 App.vue 里是常驻挂载的（只有弹窗内容用 v-if 收放），所以这两个是实例级的
// 长生命周期状态 —— 等价于模块级，跨开关与跨页面都活着。
let attempt = 0
let timer = null
let password = ''

const stopWaiting = () => {
  attempt += 1
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

const start = async () => {
  stopWaiting()
  const my = attempt
  const fail = (message) => {
    if (my !== attempt) return
    status.value = 'error'
    statusMessage.value = message
  }

  password = randCode()
  const ssid = `d${randCode()}`
  qrDataUrl.value = `data:image/svg+xml;base64,${btoa(renderSVG(`WIFI:T:ADB;S:${ssid};P:${password};;`, { ecc: 'M', pixelSize: 8 }))}`
  status.value = 'waiting'
  statusMessage.value = '等待设备扫码…'

  // 超时用 resolve（而不是 reject）返回哨兵：下面每一段都要区分「哪一步失败的」，
  // 揉进一个 catch 里就只能报一句含糊的「启动发现失败」。
  let raced = await Promise.race([
    findDeviceApi().then(
      (device) => ({ device }),
      (error) => ({ error: `启动发现失败：${error?.message || error}` }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), PAIRING_TIMEOUT_MS)
    }),
  ])
  if (raced.timedOut) {
    fail('还没等到配对请求。确认手机已打开「无线调试 → 使用二维码配对设备」，再重新扫码。')
    return
  }
  timer = null
  if (raced.error) {
    fail(raced.error)
    return
  }

  const device = raced.device
  statusMessage.value = `正在配对 ${device?.address || ''}…`
  try {
    await pairApi(device, password)
    if (my !== attempt) return
    statusMessage.value = '配对成功，开始建立连接…'
    // 这一段同样可能永远不返回（它走的是同一条发现轮询），所以再套一次超时。
    raced = await Promise.race([
      resolveConnectAddressApi({ name: device?.name, address: device?.address }).then(
        (connectService) => ({ connectService }),
        (error) => ({ error: `建立连接失败：${error?.message || error}` }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), PAIRING_TIMEOUT_MS)
      }),
    ])
    if (my !== attempt) return
    if (raced.timedOut) {
      fail('设备已配对，但没能解析出连接地址。确认手机与电脑仍在同一网络，再重试一次。')
      return
    }
    timer = null
    if (raced.error) {
      fail(raced.error)
      return
    }
    emit('paired', raced.connectService)
  } catch (error) {
    fail(`配对失败：${error?.message || error}`)
  }
}

watch(modelValue, (bl) => {
  if (bl) start()
  // 关掉只是收起来，组件可能还挂着（也可能马上被重开）：作废当前等待，并让父层的发现循环重新接管。
  else stopWaiting()
})

onUnmounted(stopWaiting)
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
        <button
          v-if="status === 'error'"
          class="mt-2 w-full cursor-pointer rounded-[10px] bg-[#007aff] px-3 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-85"
          @click="start"
        >
          重新等待设备扫码
        </button>
      </div>
    </Motion>
  </AnimatePresence>
</template>
