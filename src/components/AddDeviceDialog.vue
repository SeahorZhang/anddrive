<script setup>
import { Icon } from '@iconify/vue'
import { renderSVG } from 'uqr'
import BaseButton from './BaseButton.vue'
import { findDeviceApi, pairApi, resolveConnectAddressApi } from '@/api'
import { stateText, stateClass, stateDotClass, deviceHint } from '@/utils/deviceState'

const randCode = () => String(Date.now() % 1000000).padStart(6, '0')

/**
 * 等待设备出现在 `_adb-tls-pairing` 的上限。给这么长是因为这一段完全取决于人
 * 在手机上翻到「无线调试 → 使用二维码配对设备」并扫码，超过这个时长基本就是
 * 没开对页面，继续转圈只是骗人。
 */
const PAIRING_TIMEOUT_MS = 90_000

const modelValue = defineModel({ default: false })
const props = defineProps({
  /** 已发现的设备，扫码弹窗里直接给一个「可用设备」列表，省得再跑一趟右上角。 */
  devices: { type: Array, default: () => [] },
})
const qrDataUrl = ref('')
const status = ref('idle') // idle-闲置 | waiting-等待 | error-错误
const statusMessage = ref('')
const emit = defineEmits(['paired', 'connect'])

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
  <DialogRoot v-model:open="modelValue">
    <DialogPortal>
      <DialogOverlay
        class="data-[state=open]:animate-in data-[state=open]:fade-in fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px]"
      />
      <DialogContent
        class="data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[20px] border border-line bg-surface shadow-pop backdrop-blur-2xl outline-none"
      >
        <div class="flex items-start gap-3 px-5 pt-4.5 pb-3.5">
          <div
            class="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-gradient-to-b from-[#5ac8fa] to-accent text-white shadow-[0_1px_3px_rgba(0,122,255,0.35)]"
          >
            <Icon icon="lucide:qr-code" :width="18" :height="18" />
          </div>
          <div class="min-w-0 flex-1">
            <DialogTitle class="text-[14px] font-semibold text-ink">扫码添加设备</DialogTitle>
            <DialogDescription class="mt-0.5 text-[11px] text-ink-3">
              用手机扫描二维码，完成无线调试配对
            </DialogDescription>
          </div>
          <button
            type="button"
            title="重新生成二维码"
            aria-label="重新生成二维码"
            class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-fill hover:text-ink"
            @click="start"
          >
            <Icon icon="lucide:refresh-cw" :width="14" :height="14" />
          </button>
          <button
            type="button"
            title="关闭"
            aria-label="关闭"
            class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-fill hover:text-ink"
            @click="modelValue = false"
          >
            <Icon icon="lucide:x" :width="14" :height="14" />
          </button>
        </div>

        <div class="px-5 pb-4">
          <div class="text-[11px] font-medium text-ink-3">二维码</div>
          <div class="mt-2 flex justify-center">
            <!-- 二维码必须黑字白底，这里不跟主题走。 -->
            <div
              class="flex size-[216px] items-center justify-center rounded-[16px] bg-white p-3 shadow-[0_1px_3px_rgba(0,0,0,0.16)] ring-1 ring-black/10"
            >
              <img :src="qrDataUrl" class="size-full select-none" />
            </div>
          </div>
          <div class="mt-3 flex h-4 items-center justify-center gap-2 text-[12px]">
            <span
              class="size-1.5 rounded-full"
              :class="status === 'error' ? 'bg-[#ff453a]' : 'animate-pulse bg-[#34c759]'"
            />
            <span :class="status === 'error' ? 'text-[#ff6961]' : 'text-ink-2'">
              {{ statusMessage }}
            </span>
          </div>
        </div>

        <div class="h-px bg-line" />

        <div class="px-5 py-3.5">
          <div class="text-[11px] font-medium text-ink-3">可用设备</div>
          <div class="mt-2 flex max-h-[184px] flex-col gap-1.5 overflow-y-auto">
            <div
              v-for="device in props.devices"
              :key="device.address"
              class="flex items-center gap-2.5 rounded-[12px] bg-surface-2/70 px-3 py-2.5 ring-1 ring-line"
            >
              <div
                class="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#5ac8fa] to-accent text-white shadow-[0_1px_2px_rgba(0,122,255,0.3)]"
              >
                <Icon icon="lucide:smartphone" :width="15" :height="15" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-[12.5px] font-medium text-ink">
                    {{ device.label || device.name || '未知设备' }}
                  </span>
                  <span
                    v-if="device.transport === 'usb'"
                    class="shrink-0 rounded-[4px] bg-fill px-1 py-0.5 text-[10px] leading-none font-medium text-ink-3"
                  >
                    USB
                  </span>
                  <span
                    class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                    :class="stateClass(device)"
                  >
                    <span class="size-1.5 rounded-full" :class="stateDotClass(device)" />
                    {{ stateText(device) }}
                  </span>
                </div>
                <div class="mt-0.5 truncate text-[11px] text-ink-3">
                  {{ deviceHint(device) }}
                </div>
              </div>
              <BaseButton
                variant="primary"
                size="sm"
                :disabled="!device.connected"
                @click="emit('connect', device)"
              >
                连接
              </BaseButton>
            </div>

            <div
              v-if="!props.devices.length"
              class="flex items-center justify-center gap-2 rounded-[12px] px-3 py-4 text-[12px] text-ink-3"
            >
              <span
                class="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-ink-2"
              />
              正在查找设备…
            </div>
          </div>
        </div>

        <div class="h-px bg-line" />

        <div class="bg-fill px-5 py-3.5 text-[11px] leading-relaxed text-ink-3">
          请在 Android
          设备上开启无线调试，并确保设备与电脑连接到同一网络。打开无线调试中的「使用二维码配对设备」，扫描上方二维码完成配对。
          <button
            v-if="status === 'error'"
            class="mt-2 w-full cursor-pointer rounded-[10px] bg-accent px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-accent-press"
            @click="start"
          >
            重新等待设备扫码
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
