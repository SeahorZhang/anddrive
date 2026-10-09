<script setup>
import { AutoCanvasRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'
import { useMirrorInput } from './useMirrorInput.js'
import { bootstrap, dispose as disposeSession, reclaimApp, wakeScreen, getSessionInfo, setContentElement } from './direct-session.js'
import { aspectDiffers, createReflowGate } from './displayFollow.js'

// 镜像窗口（渲染层直连）：adb/scrcpy 全在本进程内由 Tango 官方库建立，
// 视频包直接写 WebCodecs 解码器、音频包直接播放，主进程不参与帧路径。
// 渲染走 Tango 的 AutoCanvasRenderer：优先 WebGL（GPU），GPU 不可用时回落 2D。

const webglSupported = WebGLVideoFrameRenderer.isSupported
console.info(`[mirror] WebGL 渲染可用：${webglSupported}`)

const canvasHost = ref(null)
const status = ref('正在连接设备…')
const meta = shallowRef(null)
const fps = ref(0)
/** 调试面板只在 dev 存在，默认收起，由右上角 `tools` 按钮开合。 */
const devTools = import.meta.env.DEV
const showHud = ref(false)
/** dev HUD 边栏宽度：`mirror-main` 让出的右侧宽度与 `aside` 宽度都用这一个值。 */
const HUD_WIDTH = 240
/** 字节数 → 人类可读（HUD 显示用，保留一位小数）。 */
function bytesText(bytes) {
  if (!bytes) return '0'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${index === 0 ? value : Math.round(value * 10) / 10} ${units[index]}`
}
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
  gl: webglSupported ? '可用' : '不可用',
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
 * 消失的时机不只看时间：重排后第一个可解码画面必然是关键帧，所以时间到了但关键帧
 * 还没来时再多等一会儿（总时长仍被 COVER_MAX_MS 卡住），否则会露出半帧或拖影。
 */
const covering = ref(false)
/** 画面尺寸连续这么久不再变化，才认为设备重排完了（它往往要变好几下：先翻方向再改尺寸）。 */
const COVER_UNTIL_STABLE_MS = 420
/** 兜底：设备一直没回传新尺寸（会话断了等）也不能把画面一直盖着。 */
const COVER_MAX_MS = 3000
/** 等到关键帧后再多留一点，让那一帧真正画上屏。 */
const COVER_AFTER_KEYFRAME_MS = 80
/** 时间到了但还在等关键帧时的轮询步长。 */
const COVER_GATE_POLL_MS = 150
let coverTimer = null
let coverDeadline = 0
/** 重排门闩：下发过 resize 之后，等一对 configuration + 关键帧。 */
const reflowGate = createReflowGate()
/** 当前画面比例，由 syncCanvasBox 从解码器尺寸刷新。 */
let frameRatio = 0

function endCover() {
  coverTimer = null
  if (covering.value && reflowGate.isWaiting() && Date.now() < coverDeadline) {
    // 关键帧还没到，先别揭 —— 下一步继续问，越过 coverDeadline 就无条件放行。
    armCover(COVER_GATE_POLL_MS)
    return
  }
  reflowGate.reset()
  covering.value = false
}

/** 统一走一个定时器：短计时不能越过总兜底线。 */
function armCover(ms) {
  if (coverTimer) clearTimeout(coverTimer)
  const wait = Math.min(ms, Math.max(0, coverDeadline - Date.now()))
  coverTimer = setTimeout(endCover, wait)
}

/** `displayFollow` 真的发出了一条 resizeDisplay。 */
function onReflowSent() {
  reflowGate.arm()
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
  reflowGate.reset()
  covering.value = false
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

/**
 * 接回横幅上的应用图标与名称：都取自启动参数（主进程建会话时带来，`.adr` 那条路径也带图标）。
 * 以前这里在横幅出现时调 `adb:getCachedApps` 读整台设备的图标缓存再 find 那一个包名 ——
 * 为一个图标花一整轮 IO，而且 `.adr` 冷启动时缓存还没建，读了也是空。
 */
const appIcon = ref('')
const appTitle = ref('')
function takeSessionIcon() {
  const info = getSessionInfo()
  if (!info) return
  appIcon.value = info.iconUrl || ''
  appTitle.value = info.label || info.packageName || ''
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

/**
 * 设备睡下了（`mWakefulness` = `Asleep`/`Dozing`）：面板灭了就不再有新帧，
 * 画面定住不是链路坏了。照竞品给一个「继续使用」，点了点亮屏幕；
 * 醒回来后轮询自己会把横幅撤掉（`onSleepChange(false)`）。
 */
const asleep = ref(false)
const waking = ref(false)

async function continueAfterSleep() {
  if (waking.value) return
  waking.value = true
  try {
    const result = await wakeScreen()
    // 失败只回一行文案：MIUI 上这条吃「USB 调试（安全设置）」那道闸，被拒要说清为什么。
    if (!result?.ok) showNotice(result?.message || '唤醒失败')
  } finally {
    waking.value = false
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
  if (packet.type === 'configuration') {
    hud.configs += 1
    reflowGate.configuration()
  } else if (packet.type === 'data') {
    hud.packets += 1
    hud.bytes += packet.data?.byteLength || 0
    // 重排后的第一帧关键帧到了：按「再多等一点让画上屏」收尾，不等就继续按时间兜底。
    if (packet.keyframe && reflowGate.keyFrame() && covering.value) {
      armCover(COVER_AFTER_KEYFRAME_MS)
    }
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
    audio: () => {
      hud.audioPackets += 1
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
      onReflowSent,
      onStolen: (value) => {
        stolen.value = value
        if (value) takeSessionIcon()
      },
      onSleepChange: (value) => {
        asleep.value = value
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
  // 虚拟显示按**画面区**算（见 direct-session 的 contentCss）：dev 右侧那条 HUD 边栏
  // 不算进画面区，否则显示比例与画面比例对不上。必须在 bootstrap 之前设好。
  setContentElement(canvasHost.value)
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
    <!-- 画面区：dev 时右侧让出一条 HUD 边栏，画面上的覆盖层（遮罩/接回/提示）都只盖这一块，
         这样调试信息永远不被盖住，也不会压在镜像画面上。 -->
    <div class="mirror-main" :style="showHud ? { right: `${HUD_WIDTH}px` } : undefined">
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

      <!-- dev 专用：右上角开合调试面板。压在拖拽条上，所以要 no-drag，否则点击被拖拽区吃掉。 -->
      <button v-if="devTools" type="button" class="mirror-tools-toggle" :aria-expanded="showHud"
        title="调试信息" style="-webkit-app-region: no-drag" @click="showHud = !showHud">tools</button>

      <!-- 应用被别的显示拿走时，画面中间给一个接回入口（带应用图标）。
           平时不显示：没被抢就不该有多余控件压在画面上。 -->
      <div v-if="stolen" class="mirror-reclaim" style="-webkit-app-region: no-drag">
        <img v-if="appIcon" :src="appIcon" class="mirror-reclaim__icon" alt="" />
        <span v-else class="mirror-reclaim__icon mirror-reclaim__icon--letter">{{ (appTitle || '?').slice(0, 1) }}</span>
        <button type="button" class="mirror-reclaim__button" :disabled="reclaiming" @click="reclaim">
          {{ reclaiming ? '接回中…' : '接回画面' }}
        </button>
      </div>
      <p v-if="notice" class="mirror-notice">{{ notice }}</p>

      <!-- 设备睡下了：给一个「继续使用」点亮屏幕（照竞品的「已休眠」那一格）。
           不自动弹醒 —— 手按电源键是用户的决定，程序不该抢。 -->
      <div v-if="asleep" class="mirror-sleep" style="-webkit-app-region: no-drag">
        <p class="mirror-sleep__title">已休眠</p>
        <button type="button" class="mirror-sleep__button" :disabled="waking" @click="continueAfterSleep">
          {{ waking ? '唤醒中…' : '继续使用' }}
        </button>
      </div>

      <p v-if="status"
        class="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-white/60">
        {{ status }}
      </p>
    </div>

    <!-- dev 专用：调试信息在画面**右边**的独立边栏里，不遮挡镜像内容。 -->
    <aside v-if="showHud" class="mirror-hud" :style="{ width: `${HUD_WIDTH}px` }">
      <div class="mirror-hud__title">{{ title }}</div>
      <div class="mirror-hud__sub">{{ meta?.codecName }} · {{ fps }} 帧/秒</div>

      <div class="mirror-hud__group">画面</div>
      <div class="mirror-hud__row"><span>画面区</span><b>{{ hud.win }}</b></div>
      <div class="mirror-hud__row"><span>视频</span><b>{{ hud.vid }}</b></div>
      <div class="mirror-hud__row"><span>尺寸变化</span><b>{{ hud.vidChanges }} 次</b></div>
      <div class="mirror-hud__row"><span>已显示</span><b>{{ hud.frames }}</b></div>
      <div class="mirror-hud__row"><span>已绘制</span><b>{{ hud.rendered }}</b></div>
      <div class="mirror-hud__row"><span>跳过绘制</span><b>{{ hud.skipRender }}</b></div>

      <div class="mirror-hud__group">解码</div>
      <div class="mirror-hud__row"><span>WebGL</span><b>{{ hud.gl }}</b></div>
      <div class="mirror-hud__row"><span>渲染方式</span><b>{{ hud.renderer }} / {{ hud.type }}</b></div>
      <div class="mirror-hud__row"><span>解码队列</span><b>{{ hud.queue }}</b></div>
      <div class="mirror-hud__row"><span>跳过解码</span><b>{{ hud.skipped }}</b></div>
      <div class="mirror-hud__row"><span>解码器重置</span><b>{{ hud.resets }}</b></div>

      <div class="mirror-hud__group">传输</div>
      <div class="mirror-hud__row"><span>视频包</span><b>{{ hud.packets }}</b></div>
      <div class="mirror-hud__row"><span>接收字节</span><b>{{ bytesText(hud.bytes) }}</b></div>

      <div class="mirror-hud__group">音频</div>
      <div class="mirror-hud__row"><span>收到包</span><b>{{ hud.audioPackets }}</b></div>
      <div class="mirror-hud__row"><span>已播放</span><b>{{ hud.audioPlayed }}</b></div>
      <div class="mirror-hud__row"><span>播放队列</span><b>{{ hud.audioQueue }}</b></div>
      <div class="mirror-hud__row"><span>已解码</span><b>{{ hud.audioDecoded }}</b></div>
      <div class="mirror-hud__row"><span>时钟</span><b>{{ Math.round(hud.audioTime * 10) / 10 }} 秒</b></div>
      <div class="mirror-hud__row"><span>状态</span><b>{{ hud.audioState }}</b></div>
      <div v-if="hud.audioIssue && hud.audioIssue !== '-'" class="mirror-hud__issue">{{ hud.audioIssue }}</div>
    </aside>
  </div>
</template>

<style scoped>
/* 画面区：canvas + 全部覆盖层都在这一块里。生产中它就是整个视口；
   dev 时右侧让出 HUD 边栏（`right` 内联覆盖），所以覆盖层也只盖画面、不盖调试信息。 */
.mirror-main {
  position: absolute;
  inset: 0;
}

/* dev 调试信息边栏：独立于画面区，永不被镜像内容或它的覆盖层遮挡。 */
.mirror-hud {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  padding: 10px 12px 16px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 1.45;
  color: rgb(255 255 255 / 72%);
  background: #0d0e10;
  border-left: 1px solid rgb(255 255 255 / 8%);
}

/* 开合按钮：右上角，压在拖拽条与边栏标题之上（两者都要给它让出这一块）。 */
.mirror-tools-toggle {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 40;
  padding: 2px 9px;
  border: none;
  border-radius: 999px;
  background: rgb(20 20 22 / 72%);
  color: rgb(255 255 255 / 62%);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.04em;
  cursor: pointer;
}

.mirror-tools-toggle:hover {
  background: rgb(40 40 44 / 88%);
  color: rgb(255 255 255 / 88%);
}

.mirror-hud__title {
  overflow: hidden;
  /* 右上角留给 `tools` 开合按钮，别让标题钻到它底下。 */
  padding-right: 48px;
  font-size: 11px;
  color: rgb(255 255 255 / 85%);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mirror-hud__sub {
  color: rgb(255 255 255 / 45%);
}

.mirror-hud__group {
  margin-top: 9px;
  margin-bottom: 3px;
  font-size: 9px;
  letter-spacing: 0.08em;
  color: rgb(255 255 255 / 32%);
}

.mirror-hud__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.mirror-hud__row span {
  color: rgb(255 255 255 / 45%);
}

.mirror-hud__row b {
  font-weight: 400;
  color: rgb(255 255 255 / 78%);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.mirror-hud__issue {
  margin-top: 8px;
  color: rgb(255 196 120 / 85%);
  word-break: break-all;
}

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

/* 设备睡下时的入口：只压一层轻底 + 居中小胶囊，让人看清画面定住的是最后一帧。 */
.mirror-sleep {
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

.mirror-sleep__title {
  margin: 0;
  color: rgb(255 255 255 / 82%);
  font-size: 14px;
}

.mirror-sleep__button {
  padding: 7px 16px;
  border: none;
  border-radius: 999px;
  background: rgb(255 255 255 / 94%);
  color: #101012;
  font-size: 13px;
  cursor: pointer;
}

.mirror-sleep__button:disabled {
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
