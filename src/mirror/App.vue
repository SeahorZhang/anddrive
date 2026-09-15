<script setup>
import { Icon } from '@iconify/vue'
import { AutoCanvasRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'
import { useMirrorInput } from './useMirrorInput.js'

// 镜像窗口：视频包从主进程经 IPC 送来，用 WebCodecs 解码后画在 canvas 上。
// 渲染走 Tango 的 AutoCanvasRenderer：优先 WebGL（GPU），GPU 不可用时回落 2D。
// canvas 按显示尺寸出图（canvasSize: display），窗口比视频小时可省填充开销。
// 指针 / 滚轮 / 键盘与右侧操作栏都通过 useMirrorInput 发送控制消息。

const webglSupported = WebGLVideoFrameRenderer.isSupported
console.info(`[mirror] WebGL 渲染可用：${webglSupported}`)

const canvasHost = ref(null)
const status = ref('正在连接设备…')
const meta = shallowRef(null)
const fps = ref(0)
const showHud = import.meta.env.DEV
const hud = reactive({
  packets: 0,
  configs: 0,
  frames: 0,
  renderer: '-',
  queue: 0,
  bytes: 0,
  type: '-',
  skipped: 0,
  resets: 0,
  rendered: 0,
  skipRender: 0,
  gl: webglSupported ? 'Y' : 'N',
})

const renderer = shallowRef(null)
const decoder = shallowRef(null)
let writer = null
let disposeRendererType = null
let disposeSizeChanged = null
let hostResize = null
let statsTimer = null

const sessionId = computed(() => meta.value?.id || '')

/** 操作栏按钮 → 控制动作（见 electron/mirror/control.js）。 */
const actions = [
  { action: 'back', icon: 'lucide:arrow-left', tip: '返回' },
  { action: 'home', icon: 'lucide:house', tip: '主屏幕' },
  { action: 'appSwitch', icon: 'lucide:square', tip: '最近任务' },
  { action: 'notification', icon: 'lucide:bell', tip: '通知栏' },
  { action: 'rotate', icon: 'lucide:rotate-cw', tip: '旋转屏幕' },
  { action: 'volumeDown', icon: 'lucide:volume-1', tip: '音量 -' },
  { action: 'volumeUp', icon: 'lucide:volume-2', tip: '音量 +' },
  { action: 'power', icon: 'lucide:power', tip: '电源' },
]

/** 视频像素尺寸（解码器上报的真实分辨率），用于把指针坐标换算到设备坐标。 */
function getVideoSize() {
  const video = decoder.value
  if (video?.width && video?.height) return { width: video.width, height: video.height }
  const canvas = renderer.value?.canvas
  if (!canvas?.width || !canvas?.height) return null
  return { width: canvas.width, height: canvas.height }
}

const { runAction } = useMirrorInput({ target: canvasHost, sessionId, getVideoSize })

const title = computed(() => meta.value?.label || meta.value?.packageName || '镜像')

/** canvas 由 Tango 渲染器创建，切换 WebGL / 2D 时重新挂载。 */
function attachCanvas() {
  const active = renderer.value
  if (!active || !canvasHost.value) return
  const canvas = active.canvas
  canvas.className = 'block'
  canvasHost.value.replaceChildren(canvas)
  syncCanvasBox()
}

/** canvas 的 CSS 尺寸按视频比例贴合容器；渲染器据此按显示分辨率出图。 */
function syncCanvasBox() {
  const host = canvasHost.value
  const canvas = renderer.value?.canvas
  const size = getVideoSize()
  if (!host || !canvas || !size) return
  const scale = Math.min(host.clientWidth / size.width, host.clientHeight / size.height)
  if (!Number.isFinite(scale) || scale <= 0) return
  canvas.style.width = `${Math.round(size.width * scale)}px`
  canvas.style.height = `${Math.round(size.height * scale)}px`
}

function startDecoder(info) {
  if (!WebCodecsVideoDecoder.isSupported) {
    status.value = '当前环境不支持 WebCodecs，无法解码画面'
    return
  }
  try {
    const frameRenderer = new AutoCanvasRenderer({ canvasSize: 'display' })
    renderer.value = frameRenderer
    disposeRendererType = frameRenderer.onTypeChanged?.(() => attachCanvas())

    const videoDecoder = new WebCodecsVideoDecoder({
      codec: info.codec,
      renderer: frameRenderer,
      optimizeForLatency: true,
    })
    decoder.value = videoDecoder
    writer = videoDecoder.writable.getWriter()
    disposeSizeChanged = videoDecoder.sizeChanged(() => syncCanvasBox())
    attachCanvas()
    status.value = ''

    let lastFrames = 0
    statsTimer = setInterval(() => {
      const current = videoDecoder.framesDisplayed || 0
      fps.value = Math.max(0, current - lastFrames)
      lastFrames = current
      hud.frames = current
      hud.queue = videoDecoder.decodeQueueSize || 0
      hud.renderer = videoDecoder.rendererType || '-'
      hud.type = videoDecoder.type || '-'
      hud.skipped = videoDecoder.framesSkippedDecoding || 0
      hud.resets = videoDecoder.decoderResetCount || 0
      hud.rendered = videoDecoder.framesRendered || 0
      hud.skipRender = videoDecoder.framesSkippedRendering || 0
    }, 1000)
  } catch (error) {
    console.error('[mirror] decoder init failed', error)
    status.value = `初始化解码器失败：${error?.message || error}`
  }
}

function onPacket(packet) {
  if (!writer) return
  if (packet.type === 'configuration') hud.configs += 1
  else if (packet.type === 'data') {
    hud.packets += 1
    hud.bytes += packet.data?.byteLength || 0
  }
  const mapped =
    packet.type === 'session'
      ? {
          type: 'session',
          isClientResize: packet.isClientResize,
          width: packet.width,
          height: packet.height,
        }
      : {
          type: packet.type,
          keyframe: packet.keyframe,
          pts: packet.pts ?? undefined,
          data: packet.data instanceof Uint8Array ? packet.data : new Uint8Array(packet.data),
        }
  writer.write(mapped).catch((error) => {
    console.error('[mirror] decode write failed', error)
    if (status.value) return
    status.value = `解码失败（${meta.value?.codecName || '未知编码'}）：${error?.message || error}；可在启动参数里改用 h264 重试`
  })
}

function onWindowMessage(event) {
  if (event.source !== window) return
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.__anddriveMirror === 'init') {
    meta.value = message.payload
    startDecoder(message.payload)
  } else if (message.__anddriveMirror === 'packet') {
    onPacket(message.payload)
  }
}

let disposeError = null

onMounted(() => {
  window.addEventListener('message', onWindowMessage)
  hostResize = new ResizeObserver(() => syncCanvasBox())
  if (canvasHost.value) hostResize.observe(canvasHost.value)
  disposeError = window.electronAPI?.mirror?.onError?.(({ message }) => {
    status.value = message || '镜像已中断'
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onWindowMessage)
  if (statsTimer) clearInterval(statsTimer)
  hostResize?.disconnect()
  disposeSizeChanged?.()
  disposeRendererType?.()
  disposeError?.()
  try {
    writer?.releaseLock()
  } catch {
    // 忽略释放失败
  }
  decoder.value?.dispose()
})
</script>

<template>
  <div class="flex h-full flex-col bg-black text-white">
    <header class="flex h-9 shrink-0 items-center gap-2 pr-3 pl-20" style="-webkit-app-region: drag">
      <span class="truncate text-[12px] font-medium">{{ title }}</span>
      <span v-if="meta" class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] tracking-wide text-white/70">
        {{ meta.codecName }}
      </span>
      <span class="ml-auto shrink-0 text-[10px] tabular-nums text-white/40">{{ fps }} fps</span>
    </header>

    <div class="flex min-h-0 flex-1">
      <div class="relative min-w-0 flex-1 bg-black">
        <div ref="canvasHost" class="absolute inset-0 flex items-center justify-center overflow-hidden"
          style="touch-action: none"></div>
        <p v-if="status"
          class="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-white/60">
          {{ status }}
        </p>
        <div v-if="showHud"
          class="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-[10px] leading-tight text-white/60">
          gl={{ hud.gl }} {{ hud.renderer }}/{{ hud.type }} shown={{ hud.frames }} draw={{ hud.rendered }} skipDraw={{ hud.skipRender }}
          q={{ hud.queue }} skipDec={{ hud.skipped }} reset={{ hud.resets }} packets={{ hud.packets }} bytes={{ hud.bytes }}
        </div>
      </div>

      <aside class="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-white/10 py-2"
        style="-webkit-app-region: no-drag">
        <button v-for="action in actions" :key="action.action" :title="action.tip" type="button" tabindex="-1"
          class="flex size-8 cursor-pointer items-center justify-center rounded-[8px] text-white/50 outline-none hover:bg-white/10 hover:text-white active:bg-white/15"
          @click="runAction(action.action)">
          <Icon :icon="action.icon" :width="16" :height="16" />
        </button>
      </aside>
    </div>
  </div>
</template>
