<script setup>
import { AutoCanvasRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'
import { useMirrorInput } from './useMirrorInput.js'
import { bootstrap, dispose as disposeSession, reclaimApp, getSessionInfo } from './session.js'
import { CHANNELS } from '../../electron/ipcContract.js'
import { aspectDiffers } from './displayFollow.js'

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
/**
 * 拖窗口时的遮罩：设备侧每次重排都会 reset 采集、画面会跳/翻，所以在那一刻盖上。
 * 出现得快（90ms）、消失得慢（320ms 渐变），元素常驻只切 opacity。
 */
const covering = ref(false)
/** 画面尺寸连续这么久不再变化，才认为设备重排完了（它往往要变好几下：先翻方向再改尺寸）。 */
const COVER_UNTIL_STABLE_MS = 420
/** 兜底：设备一直没回传新尺寸（会话断了等）也不能把画面一直盖着。 */
const COVER_MAX_MS = 3000
let coverTimer = null
let coverDeadline = 0
/** 当前画面比例，由 syncCanvasBox 从解码器尺寸刷新。 */
let frameRatio = 0

function endCover() {
  coverTimer = null
  covering.value = false
}

/** 统一走一个定时器：短计时不能越过总兜底线。 */
function armCover(ms) {
  if (coverTimer) clearTimeout(coverTimer)
  const wait = Math.min(ms, Math.max(0, coverDeadline - Date.now()))
  coverTimer = setTimeout(endCover, wait)
}

/**
 * 手一拖就盖（`onIntent` 在每次尺寸请求都回调，包括拖拽过程中的每一帧）：
 * 遮罩要盖住的是「用户在改尺寸」这段时间，不是只有真正重排的那一下。
 * 每帧都把总兜底线往前推，慢拖（超过 COVER_MAX_MS）也不会中途露出来。
 */
function coverForReflow(target) {
  if (!decoder.value || !target) return
  // 同比例的纯缩放不会让 app 重新决定方向，不值得盖一次。
  if (!aspectDiffers(target.width / target.height, frameRatio)) return
  covering.value = true
  coverDeadline = Date.now() + COVER_MAX_MS
  armCover(COVER_MAX_MS)
}

/** 停手合并后发现尺寸其实没变（拖出去又拖回来）：没下发 resize，遮罩也没必要留。 */
function cancelCover() {
  if (coverTimer) clearTimeout(coverTimer)
  coverTimer = null
  coverDeadline = 0
  if (covering.value) endCover()
}

function onFrameSizeChanged() {
  hud.vidChanges += 1
  syncCanvasBox()
  if (!covering.value) return
  armCover(COVER_UNTIL_STABLE_MS)
}

/** 应用被别的显示（别的投屏软件）拿走了：画面还在播，但播的是我们这块空显示。 */
const stolen = ref(false)

/** 「接回画面」进行中。 */
const reclaiming = ref(false)

/** 一次性反馈（例如「画面已经在这个窗口」），两秒后自己消失。 */
const notice = ref('')
let noticeTimer = null
function showNotice(text) {
  notice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
    noticeTimer = null
  }, 2400)
}

/** 应用图标：等真要显示接回入口时才去缓存里取，平时不为它花一次 IO。 */
const appIcon = ref('')
const appLabel = ref('')
let iconLoaded = false
async function loadIcon() {
  if (iconLoaded) return
  iconLoaded = true
  const info = getSessionInfo()
  appLabel.value = info?.label || info?.packageName || ''
  if (!info?.serial || !info?.packageName) return
  let apps = null
  try {
    apps = await window.__anddriveIpc?.invoke?.(CHANNELS.adbGetCachedApps, info.serial)
  } catch {
    // 缓存读不到就退化成首字母方块，不为了图标打扰开会话
  }
  appIcon.value = apps?.find?.((app) => app.packageName === info.packageName)?.iconUrl || ''
}

/** 把被别处拿走的应用原样搬回本窗口：只搬任务、不重启，进程与页面状态都留着。 */
async function reclaim() {
  if (reclaiming.value) return
  reclaiming.value = true
  try {
    const result = await reclaimApp()
    if (result?.ok) showNotice(result.already ? '画面已经在这个窗口' : '已接回画面')
    else showNotice(result?.message || '接回失败')
  } finally {
    reclaiming.value = false
  }
}

function syncCanvasBox() {
  const host = canvasHost.value
  const canvas = renderer.value?.canvas
  if (!host || !canvas) return
  const size = getVideoSize()
  if (size?.width && size?.height) frameRatio = size.width / size.height
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
    disposeSizeChanged = videoDecoder.sizeChanged(onFrameSizeChanged)
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
      onReflowStart: coverForReflow,
      onReflowAbort: cancelCover,
      onStolen: (value) => {
        stolen.value = value
        if (value) void loadIcon()
      },
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

    <!-- 拖窗口时的遮罩：设备侧每次重排都会 reset 采集、画面会跳/翻，所以盖上这层。
         出现得快（90ms）、消失得慢（320ms 渐变），免得「啪」一下黑屏又「啪」一下揭开。
         一直挂在 DOM 上只切 opacity，这样才有淡出；不透明才盖得住闪烁，
         底色用中心偏亮的径向渐变，比纯黑柔和。 -->
    <div class="mirror-cover" :class="{ 'is-shown': covering }">
      <div class="mirror-cover__pill">
        <span class="mirror-cover__spinner" aria-hidden="true"></span>
        <span class="mirror-cover__text">调整画面尺寸…</span>
      </div>
    </div>

    <div class="pointer-events-auto absolute inset-x-0 top-0 z-10 h-6" style="-webkit-app-region: drag"></div>

    <!-- 应用被别的显示拿走时，画面中间给一个接回入口（带应用图标）。
         平时不显示：没被抢就不该有多余控件压在画面上。 -->
    <div v-if="stolen" class="mirror-reclaim" style="-webkit-app-region: no-drag">
      <img v-if="appIcon" :src="appIcon" class="mirror-reclaim__icon" alt="" />
      <span v-else class="mirror-reclaim__icon mirror-reclaim__icon--letter">{{ (appLabel || '?').slice(0, 1) }}</span>
      <button type="button" class="mirror-reclaim__button" :disabled="reclaiming" @click="reclaim">
        {{ reclaiming ? '接回中…' : '接回画面' }}
      </button>
    </div>
    <p v-if="notice" class="mirror-notice">{{ notice }}</p>

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

<style scoped>
.mirror-cover {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: radial-gradient(115% 85% at 50% 42%, #17181a 0%, #0b0b0c 55%, #000 100%);
  opacity: 0;
  transition: opacity 320ms cubic-bezier(0.4, 0, 0.2, 1);
}

.mirror-cover.is-shown {
  opacity: 1;
  transition-duration: 90ms;
}

.mirror-cover__pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px 7px 11px;
  border-radius: 999px;
  background: rgb(255 255 255 / 6%);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 9%), 0 8px 24px rgb(0 0 0 / 45%);
}

.mirror-cover__text {
  font-size: 11px;
  letter-spacing: 0.06em;
  color: rgb(255 255 255 / 58%);
}

.mirror-cover__spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid rgb(255 255 255 / 18%);
  border-top-color: rgb(255 255 255 / 72%);
  animation: mirror-cover-spin 720ms linear infinite;
}

@keyframes mirror-cover-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 系统开了「减少动态效果」就不转圈，只留文字。 */
@media (prefers-reduced-motion: reduce) {
  .mirror-cover__spinner {
    animation: none;
    border-top-color: rgb(255 255 255 / 18%);
  }
}

/* 被抢走时的接回入口：只压一层轻底，让原来的画面仍然看得清是「哪一块」空了。 */
.mirror-reclaim {
  position: absolute;
  inset: 0;
  z-index: 16;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgb(0 0 0 / 45%);
}

.mirror-reclaim__icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  box-shadow: 0 6px 18px rgb(0 0 0 / 45%);
}

.mirror-reclaim__icon--letter {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(255 255 255 / 14%);
  color: rgb(255 255 255 / 82%);
  font-size: 24px;
}

.mirror-reclaim__button {
  padding: 7px 16px;
  border: none;
  border-radius: 999px;
  background: rgb(255 255 255 / 94%);
  color: #101012;
  font-size: 13px;
  cursor: pointer;
}

.mirror-reclaim__button:disabled {
  opacity: 0.6;
  cursor: default;
}

.mirror-notice {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 17;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgb(20 20 22 / 84%);
  color: rgb(255 255 255 / 78%);
  font-size: 11px;
}

</style>
