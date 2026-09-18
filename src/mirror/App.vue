<script setup>
import { AutoCanvasRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'
import { useMirrorInput } from './useMirrorInput.js'
import { bootstrap, dispose as disposeSession } from './session.js'

// 镜像窗口（渲染层直连）：adb/scrcpy 全在本进程内由 Tango 官方库建立，
// 视频包直接写 WebCodecs 解码器、音频包直接播放，主进程不参与帧路径。
// 渲染走 Tango 的 AutoCanvasRenderer：优先 WebGL（GPU），GPU 不可用时回落 2D。

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
  audioPackets: 0,
  audioPlayed: 0,
  audioQueue: 0,
  audioDecoded: 0,
  audioState: '-',
  audioTime: 0,
  audioIssue: '-',
  win: '-',
  vid: '-',
  vidChanges: 0,
})

const renderer = shallowRef(null)
const decoder = shallowRef(null)
let writer = null
let disposeRendererType = null
let disposeSizeChanged = null
let hostResize = null
let statsTimer = null

/** 视频像素尺寸（解码器上报的真实分辨率），用于把指针坐标换算到设备坐标。 */
function getVideoSize() {
  const video = decoder.value
  if (video?.width && video?.height) return { width: video.width, height: video.height }
  const canvas = renderer.value?.canvas
  if (!canvas?.width || !canvas?.height) return null
  return { width: canvas.width, height: canvas.height }
}

/** 指针 / 滚轮 / 键盘 → 控制消息（直写本进程 control socket）。 */
useMirrorInput({ target: canvasHost, getVideoSize })

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

/**
 * 铺满策略固定为 letterbox：保比例尽量放，多出的留黑边。虚拟显示跟随窗口时
 * 视频宽高比与窗口一致，此时等价于铺满；拖动过程中也能避免拉伸变形。
 * 指针反算统一按「canvas 实际显示矩形」独立换算 x/y（见 useMirrorInput）。
 */
function syncCanvasBox() {
  const host = canvasHost.value
  const canvas = renderer.value?.canvas
  if (!host || !canvas) return
  const size = getVideoSize()
  hud.win = `${host.clientWidth}x${host.clientHeight}`
  hud.vid = size ? `${size.width}x${size.height}` : '-'
  if (!size?.width || !size?.height) {
    // 分辨率未知时先铺满容器，等 meta 到达后再套策略。
    canvas.style.width = `${host.clientWidth}px`
    canvas.style.height = `${host.clientHeight}px`
    canvas.style.objectFit = 'fill'
    return
  }
  const scale = Math.min(host.clientWidth / size.width, host.clientHeight / size.height)
  if (!Number.isFinite(scale) || scale <= 0) return
  canvas.style.width = `${Math.round(size.width * scale)}px`
  canvas.style.height = `${Math.round(size.height * scale)}px`
  canvas.style.objectFit = 'fill'
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
    flushPending()
    // 视频尺寸变化次数：虚拟显示被重排/应用重新取向都会让它增长，
    // 用来判断「画面旋转几下」是客户端 resize 触发的还是设备侧应用自己的行为。
    disposeSizeChanged = videoDecoder.sizeChanged(() => {
      hud.vidChanges += 1
      syncCanvasBox()
    })
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
  if (packet.type === 'configuration') hud.configs += 1
  else if (packet.type === 'data') {
    hud.packets += 1
    hud.bytes += packet.data?.byteLength || 0
  }
  if (!writer) {
    // 解码器在 meta 到达时创建；期间到达的包先缓冲。
    pendingPackets.push(packet)
    return
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
          pts: packet.pts != null ? Number(packet.pts) : undefined,
          data: packet.data instanceof Uint8Array ? packet.data : new Uint8Array(packet.data),
        }
  writer.write(mapped).catch((error) => {
    console.error('[mirror] decode write failed', error)
    if (status.value) return
    status.value = `解码失败（${meta.value?.codecName || '未知编码'}）：${error?.message || error}；可在启动参数里改用 h264 重试`
  })
}

let pendingPackets = []

/** dev 场景下看音频包分布；正式版只有计数。 */
const debugAudio = import.meta.env.DEV
  ? (packet) => console.info('[mirror] audio', packet.type, packet.data?.byteLength ?? '')
  : null

function flushPending() {
  if (!writer || !pendingPackets.length) return
  const pending = pendingPackets
  pendingPackets = []
  for (const packet of pending) onPacket(packet)
}

/**
 * 直连会话接线：meta 到达时建解码器；包到达保持原序喂入。
 */
async function booted() {
  await bootstrap({
    video: onPacket,
    audio: (packet) => {
      hud.audioPackets += 1
      debugAudio(packet)
    },
    audioStats: ({ played, queue, decoded, time, state }) => {
      hud.audioPlayed = played
      hud.audioQueue = queue
      hud.audioDecoded = decoded
      hud.audioState = state
      hud.audioTime = time ?? 0
    },
    hooks: {
      onMeta: (info) => {
        meta.value = info
        startDecoder(info)
      },
      onAudioError: (message) => {
        hud.audioIssue = message
        console.warn('[mirror] audio:', message)
      },
    },
  }).then(() => {
    status.value = ''
  }).catch((error) => {
    status.value = `镜像连接失败：${error?.message || error}`
  })
}

onMounted(() => {
  hostResize = new ResizeObserver(() => syncCanvasBox())
  if (canvasHost.value) hostResize.observe(canvasHost.value)
  void booted()
})

onBeforeUnmount(() => {
  if (statsTimer) clearInterval(statsTimer)
  hostResize?.disconnect()
  disposeSizeChanged?.()
  disposeRendererType?.()
  try {
    writer?.releaseLock()
  } catch {
    // 忽略释放失败
  }
  writer = null
  decoder.value?.dispose()
  void disposeSession()
})
</script>

<template>
  <div class="h-full bg-black text-white">
    <div ref="canvasHost" class="absolute inset-0 flex items-center justify-center overflow-hidden bg-black"
      style="touch-action: none"></div>

    <div class="pointer-events-auto absolute inset-x-0 top-0 z-10 h-6" style="-webkit-app-region: drag"></div>

    <p v-if="status"
      class="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-white/60">
      {{ status }}
    </p>
    <div v-if="showHud"
      class="pointer-events-none absolute bottom-2 left-2 z-10 rounded bg-black/60 px-2 py-1 font-mono text-[10px] leading-tight text-white/60">
      {{ title }} · {{ meta?.codecName }} · {{ fps }} fps
      <br />
      win={{ hud.win }} vid={{ hud.vid }} chg={{ hud.vidChanges }}
      <br />
      gl={{ hud.gl }} {{ hud.renderer }}/{{ hud.type }} shown={{ hud.frames }} draw={{ hud.rendered }} skipDraw={{ hud.skipRender }}
      q={{ hud.queue }} skipDec={{ hud.skipped }} reset={{ hud.resets }} packets={{ hud.packets }} bytes={{ hud.bytes }}
      audio={{ hud.audioPackets }} ap={{ hud.audioPlayed }} asq={{ hud.audioQueue }} ad={{ hud.audioDecoded }}
      atime={{ Math.round(hud.audioTime * 10) / 10 }} astate={{ hud.audioState }} {{ hud.audioIssue }}
    </div>
  </div>
</template>
