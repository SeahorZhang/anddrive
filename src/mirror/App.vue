<script setup>
import { AutoCanvasRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'
import { Icon } from '@iconify/vue'
import { useMirrorInput } from './useMirrorInput.js'
import { bootstrap, dispose as disposeSession, reclaimApp, wakeScreen, setWindowButtons, setHudExtra, getSessionInfo, setContentElement, sendControl, setScreenPower, kickSleepWatch, setMacKeyboard, watchMacKeyboardState, syncMacKeyboard, commitViaMacKeyboard, onMacKeyboardFeedback, onMacKeyboardCaret, openDesktopMode } from './direct-session.js'
import { createMacTextSink } from './macTextSink.js'
import { caretRectToAnchor, clientToDevice, deviceToScreen, emSizePx, estimateAdvancePx, LINE_HEIGHT_RATIO } from './macTextAnchor.js'
import { capsuleBox, capsuleRect, macTextCapsule } from './macTextCapsule.js'
import { scaleDisplayDpi } from '../../shared/scrcpyConfig.js'
import { aspectDiffers, createReflowGate } from './displayFollow.js'
import { createChromeReveal, isOutsideRect } from './chromeReveal.js'
import { FROZEN_STATES, needsRealWake, panelIsOff } from './sleepWatch.js'
import { KEY_CODES } from '../../shared/keys.js'
import { MIRROR_FRAME, MIRROR_RAIL } from '../../electron/mirror/options.js'

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
/** dev HUD 边栏宽度：`aside` 的固定宽，画面区（`flex: 1`）自己让出剩下的。 */
const HUD_WIDTH = 240
/**
 * 边栏展开时把**窗口**撑宽同样的量（主进程 `mirror:windowHud`），画面那块矩形才不会被挤小 ——
 * 挤小 = 虚拟显示尺寸变了 = 发一条 `resizeDisplay`，手机上当场重排一次（dev 面板不该有这副作用）。
 */
watch(showHud, (open) => setHudExtra(open ? HUD_WIDTH : 0))
/**
 * 手机**右边外面**那条悬浮长条（红绿灯 + 返回/Home/多任务）：平时不画，鼠标进到窗口右边那一条
 * 才淡入，**离开那一条 1 秒后收回**（用户 2026-10-10 第三次改，作废「只有移出窗口才收」；
 * 状态机在 `chromeReveal.js`）。红绿灯跟着它一起开关（系统画的，CSS 盖不住；落点由主进程按 `MIRROR_RAIL` 贴进来）。
 *
 * 条上那颗**「一直显示」**（2026-10-11 用户点单）：按下去常驻、不再自动收，再按一次回到上面那套
 * hover 显隐（状态在 `railPinned`，判据在 `chromeReveal.js` 的 `setPinned`）。
 *
 * 2026-10-10 三轮定稿：先把外面那圈「hover 才往外扩」的浅色窗口底整块删了（黑框那圈留着常驻），
 * 又把长条从**画面里面**挪到**画面外面** —— 「任何 UI 都不要在手机里出现」。
 * 挪出来意味着它**占窗口宽度**（进 `mirrorScreenInsets()` 的右边），换来的是：
 * 触发不用按坐标筛（那条本来就是它自己的格子），也不会吃掉手机画面右缘的点按。
 */
/**
 * 满屏那一屏（绿色按钮 zoom / 设置里的「满屏启动」）是**另一种形态**：手机要在整块屏幕正中，
 * 常态那条从顶到底、还从窗口右边挖走 86px 宽度的长条在这里两件事都碍事（画面会偏左半条）。
 * 状态由主进程推过来（`mirror:fullscreen`），初值取启动参数里的 `prefs.fullscreen`；
 * 排法全在 CSS（`.mirror-window.is-fullscreen` 那一组）。
 */
const fullscreen = ref(false)
const railShown = ref(false)
/**
 * 长条**常驻**（2026-10-11，用户：「侧边悬浮按钮栏加一个始终显示悬浮的按钮」）。
 * 真状态在状态机里（`setPinned`），这里只镜像一份给模板绑 `is-active` —— 与 `railShown` 同一套写法。
 *
 * ⚠️ **不持久化**：它是窗口级的一次性开关（与 `railShown` 同类）。要跨会话记住就得进 `prefs`
 * —— 那个口子连着 `shared/scrcpyConfig.js` 与设置界面，用户没要，先不动。
 */
const railPinned = ref(false)
const reveal = createChromeReveal({
  onShow: (shown) => {
    railShown.value = shown
    if (shown) {
      setWindowButtons(true)
      // 他把鼠标移进来就是要看那颗「关屏 / 恢复亮屏」，此刻读一次真状态最划算（顺带快轮询一阵）。
      kickSleepWatch()
      return
    }
    // 红绿灯是系统画的，**没有淡出可跟**：原来条还在半透明、三颗已经「啪」地没了（用户 10-10
    // 「消失的时候感觉不太协调」）⇒ 让面板把淡出跑完再藏它们。期间若又显形就别补这一刀。
    setTimeout(() => {
      // 满屏那一屏长条是常驻的（CSS 直接显形，`railShown` 可能仍是 false）⇒ 三颗也别跟着收。
      if (!railShown.value && !fullscreen.value) setWindowButtons(false)
    }, MIRROR_RAIL.fadeOutMs)
  },
})
/**
 * 收起判据：**坐标真的出了那一格的矩形**才算「移出悬浮栏」（用户 2026-10-10：移出悬浮栏 1 秒后才消失）。
 * 不能直接收 `pointerleave` —— 面板显形那一刻它会盖到触发格上面、命中层一变浏览器就补发一次 leave，
 * 坐标其实还在格里，那样就是「鼠标在条里移动 = 展示/隐藏来回抖」（10-10 报的循环）。
 * 过了这道关才交给状态机延 `RAIL_HIDE_DELAY_MS` 收，期间鼠标再进来会撤掉计时。
 */
const railSlot = ref(null)
function onRailLeave(event) {
  const el = railSlot.value
  if (!el) return
  const box = el.getBoundingClientRect()
  if (isOutsideRect(event, { left: box.left, top: box.top, right: box.right, bottom: box.bottom }))
    reveal.leave()
}
/**
 * 长条上那颗「一直显示」按钮。常驻交给状态机（`setPinned`），这里只镜像一份给模板。
 *
 * ⚠️ 取消常驻要**看指针在哪**：状态机解除"不许收"之后并不会自己排收回计时（点这颗按钮时
 * 指针必然在条上，那条路径靠下一次 `pointerleave` 收）。但键盘触发（焦点在按钮上按回车）
 * 时指针可能压根不在条上 —— 那条路径上**不会再有 `pointerleave`**，不补这一下条就一直挂着。
 * `matches(':hover')` 是这里唯一能同步问到"指针在不在这个元素上"的办法。
 */
function toggleRailPinned() {
  const next = !railPinned.value
  railPinned.value = next
  reveal.setPinned(next)
  if (!next && !railSlot.value?.matches?.(':hover')) reveal.leave()
}
/** 长条上的三个导航键：`kind:'key'` 走已经在的控制 socket（Tango `injectKeyCode`），不起 adb 进程。 */
const RAIL_KEYS = [
  { name: 'back', label: '返回', hint: '返回上一屏', icon: 'lucide:arrow-left', keyCode: KEY_CODES.back },
  { name: 'home', label: '桌面', hint: '回手机桌面', icon: 'lucide:home', keyCode: KEY_CODES.home },
  { name: 'recents', label: '多任务', hint: '多任务卡片', icon: 'lucide:square', keyCode: KEY_CODES.recents },
]
function pressRailKey(keyCode) {
  sendControl({ kind: 'key', action: 'down', keyCode, metaState: 0 })
  sendControl({ kind: 'key', action: 'up', keyCode, metaState: 0 })
}
/**
 * 长条上 tooltip 气泡的样式：**白底胶囊 + 深色一行文案 + 软阴影**（用户 10-10 给了参照图，
 * 否掉了之前那版黑底小方角）。`whitespace-nowrap` 是要点 —— 胶囊要圆到底，文案就得短到一行，
 * 长说明放文档里不塞进气泡。
 * ⚠️ 参照图里气泡带图标，但 `@iconify/vue` 的 `Icon` 放进 reka 的 `TooltipContent` 里渲染不出来
 * （实测 `svgCount: 0`，连占位节点都没有）；图标本来就在按钮上，气泡里重复也没必要 ⇒ 纯文字。
 */
const TIP_CLASS =
  'z-50 whitespace-nowrap rounded-full border border-black/10 bg-white px-3.5 py-2 text-[12px] font-medium text-black/75 shadow-[0_8px_24px_rgba(0,0,0,0.18),0_1px_2px_rgba(0,0,0,0.10)]'
/**
 * 设备的两条电源读数（`wakefulness` = `mWakefulness` 睡没睡，`screen` = SurfaceFlinger 的 `powerMode` 面板亮没亮），
 * 由 `sleepWatch` 轮询 + 我们点按钮时 `kickSleepWatch()` 快轮询喂进来。
 * **页面上所有跟屏有关的状态都从这一条派生**，不再各记各的：
 * - 「已休眠」横幅 = 冻结态（`Asleep`/`Dozing`，画面不再出新帧）；`Hangup` 不算（还在合成，弹了是谎报）。
 * - 长条那颗「关屏使用 / 恢复亮屏」= `panelIsOff(powerState)`（面板读数不是 `ON`，读不到时退回睡没睡）。
 * 醒回来后轮询自己会把横幅撤掉（`onSleepChange(false, state)`）。
 */
const powerState = ref({ wakefulness: 'Awake', screen: 'ON' })
const asleep = computed(() => FROZEN_STATES.has(powerState.value.wakefulness))
/**
 * **关屏使用**（长条最上面那一格，用户 2026-10-10 点名）：走 scrcpy 的 `setDisplayPower`，
 * 不占 `INJECT_EVENTS`（不同于「继续使用」那条 `input keyevent 224`）。
 * 再点一次 = `Normal`，屏幕回到系统默认（会按设备自己的超时再睡）。
 *
 * ⚠️ 两档会话的行为不一样：**虚拟显示那档（14+）**关掉的是手机自己的屏，我们那块显示照出画面；
 * **采主屏那档（13 及以下）**关的就是被采集的那块屏 —— 关掉基本就没帧了
 * （MIUI/HyperOS 有 `synergy_mode` 兜着可能还合成，见 `electron/mirror/miProjection.js`）。
 *
 * ⚠️ **图标画的是"现在的状态"，不是"点下去会发生什么"**（用户 10-10 报：「明明是亮着屏幕，
 * 息屏图标却展示息屏」—— 上一版把 `monitor-off` 挂在"亮着屏"上表示"可关屏"，读起来正好反了）。
 * 状态**只有一个来源**：设备自己的两条电源读数（上面的 `powerState`）。之前另有一个自己记的
 * 「是我们关的」标记，轮询一旦没观察到"醒"（MIUI 按电源键进的是 `Hangup`，不算休眠）它就永远挂着，
 * 把「已休眠 + 继续使用」那颗按钮整个吃掉 —— 用户 10-10 报的「手按电源键后镜像提醒恢复的按钮没了」。
 */
const screenBusy = ref(false)
/**
 * 屏灭着 = 设备自己报面板不是 `ON`，或已经睡下 / 进了 `Hangup`（判据在 `sleepWatch.js` 的
 * `panelIsOff` + `PANEL_OFF_STATES`，那边有全项目的来龙去脉）。
 * ⚠️ 不能只看 `mWakefulness`：「关屏使用」走 scrcpy 的 `setDisplayPower(OFF)`，那**只关面板、设备还 `Awake`** ——
 * 只看睡没睡的话，图标会翻回「关屏使用」，再点一次还是关屏，永远点不亮（用户 10-10）。
 * ⚠️ 也不能只看面板读数：`Hangup` 面板灭着、SurfaceFlinger 却照旧报 `powerMode=On`（用户 10-11）。
 */
const screenIsOff = computed(() => panelIsOff(powerState.value))
async function toggleScreenPower() {
  if (screenBusy.value) return
  screenBusy.value = true
  const turnOn = screenIsOff.value
  try {
    // 「恢复亮屏」分两条路（判据 `needsRealWake`，那边有真机实测的来龙去脉）：
    // 设备本身在 `Asleep` / `Dozing` / `Hangup` 这些**电源管理**的灭屏态里时，
    // `setDisplayPower(Normal)` 只改 SurfaceFlinger、唤不动它（实测 Hangup 下发后 8 秒仍是 Hangup），
    // 按钮会亮着却点不动 ⇒ 走真唤醒那条（与横幅「继续使用」同一条，失败原因要说清）。
    // 设备醒着时屏是我们自己关的，回 `Normal` 就对。
    if (turnOn && needsRealWake(powerState.value)) {
      const result = await wakeScreen()
      if (!result?.ok) {
        showNotice(result?.message || '唤醒失败')
        return
      }
    } else {
      await setScreenPower(turnOn)
    }
    // 同上：**不乐观改读数**，只 kick。图标/横幅一律等设备自己的 `mWakefulness` 报上来，
    // 否则页面会显示一个"已经亮了"的假状态（那颗按钮也就跟着说谎）。
    kickSleepWatch()
  } catch (error) {
    // 失败别改状态：按钮点了没反应要说清为什么（同「唤醒失败」那条）。
    showNotice(error?.message || (turnOn ? '恢复亮屏失败' : '关屏失败'))
  } finally {
    screenBusy.value = false
  }
}
/**
 * 视频的宽高比（CSS `aspect-ratio` 的写法），全屏那一屏拿它把黑框收成手机那一块。
 * ⚠️ **只能由 `syncCanvasBox()` 喂**：`meta.width/height` 是会话建立那一刻的快照，实测那时
 * 上游的 `AdbScrcpyVideoStream` 尺寸还没填上（拿到 0）⇒ 比例永远算不出来，满屏的黑框收不拢。
 * 首帧之前它是 `auto`（等于不套比例，黑框先按窗口铺），量到真实尺寸那一拍会自动翻过来。
 */
const screenRatio = ref('auto')
/** CSS 变量：黑框厚度与长条那两档数只有一个出处（`options.js`）。 */
const windowStyle = computed(() => ({
  '--bezel': `${MIRROR_FRAME.bezel}px`,
  '--rail-w': `${MIRROR_RAIL.width}px`,
  '--rail-keys-top': `${MIRROR_RAIL.keysTop}px`,
  '--rail-fade-in': `${MIRROR_RAIL.fadeInMs}ms`,
  '--rail-fade-out': `${MIRROR_RAIL.fadeOutMs}ms`,
  '--screen-ratio': screenRatio.value,
}))
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
let disposeMacCaret = null
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

/**
 * 「使用 Mac 键盘」（G1）：设备默认输入法归谁管，是**主进程那份状态机**说了算，页面不自己猜
 * —— 它每 2 秒对账一次，抢回来或停手都会推过来（`mirror:macKeyboardState`）。
 * 三条反馈文案照竞品 `mirror.ime.feedback.*`。
 * ⚠️ 输入法是设备级的：同一台手机的多个镜像窗口共用同一份归属，所以这颗开关亮灭不代表"这个窗口"，
 * 代表"这台手机现在用我们的输入法"。
 */
const macKeyboard = ref('off')
/** 用户**想要**的状态，与"实际归属"分开记：抢不过时归属是 `switched_away`，但用户仍然想开着，
 *  这时再点一次是"关掉"，不是"再试一次"——两个都塞进一个布尔里就会点一下变成重试。 */
const macKeyboardWanted = ref(false)
const macKeyboardBusy = ref(false)
const MAC_KEYBOARD_TIPS = {
  off: '用 Mac 键盘给手机打字',
  active: 'Mac 键盘输入中（点一下交还手机输入法）',
  switched_away: '设备已切换至其他输入法（点一下关掉这一格）',
  unavailable: '我们的输入法未在设备上处于激活状态',
  parked: '已在手机上关闭 Mac 键盘输入（点这一格恢复）',
}
watchMacKeyboardState(applyMacKeyboardState)

/** @param {{ state?: string, token?: string, socket?: string } | null} payload */
function applyMacKeyboardState(payload) {
  const state = payload?.state ?? 'off'
  const next = MAC_KEYBOARD_TIPS[state] ? state : 'off'
  const changed = next !== macKeyboard.value
  macKeyboard.value = next
  if (next === 'active') macKeyboardWanted.value = true
  else if (next === 'off') macKeyboardWanted.value = false
  // 桥跟着归属走：`active`/`parked` 连着，`off` 断开（token 换了会重建）。
  syncMacKeyboard(payload)
  // 只在"我们想开着却拿不回来"那两种情况下打断用户，别为正常的 off 弹条。
  if (changed && (next === 'switched_away' || next === 'unavailable')) showNotice(MAC_KEYBOARD_TIPS[next])
}

async function toggleMacKeyboard() {
  if (macKeyboardBusy.value) return
  // `parked`（用户在手机上按了 ×）那一下是「恢复」，不是「关掉」：意图本来就想开着，
  // 按 toggle 语义翻一次会变成关掉，而 tooltip 写的是「点这一格恢复」——两者得一致。
  if (macKeyboard.value === 'parked') {
    macKeyboardWanted.value = true
    macKeyboardBusy.value = true
    try {
      applyMacKeyboardState(await setMacKeyboard('on'))
    } catch (error) {
      showNotice(error?.message || '恢复 Mac 键盘失败')
    } finally {
      macKeyboardBusy.value = false
    }
    return
  }
  macKeyboardWanted.value = !macKeyboardWanted.value
  macKeyboardBusy.value = true
  try {
    applyMacKeyboardState(await setMacKeyboard(macKeyboardWanted.value ? 'on' : 'off'))
  } catch (error) {
    showNotice(error?.message || '切换输入法失败')
    macKeyboardWanted.value = macKeyboard.value === 'active'
  } finally {
    macKeyboardBusy.value = false
  }
}

/**
 * Mac 输入法收字的那个隐藏字段（Slice 4）：页面里 1×1、看不见、不接鼠标，
 * 只为了有东西可聚焦 —— 没有聚焦的可编辑元素，macOS 输入法根本不给候选窗。
 * 事件怎么翻成"要送出去的文本"全在 `macTextSink.js`（合成期间不送字，提交那一刻整串送一次）。
 */
const macTextInput = ref(null)
const macSink = createMacTextSink({
  // 桥连着就走输入法（中文整串不丢字）；没连着退回 `injectText`（ASCII 还能用，
  // 中文会丢是那条路本来的样子 —— 见 NATIVE_MIRROR §G1 那两组单变量实测）。
  // 记账放在**送之前**且只放这一处：`fallback` 是"桥没连上时补发"，在那里再记一遍就是双份。
  commit: (text) => {
    noteMacTextCommit(text)
    return commitViaMacKeyboard(text)
  },
  fallback: (text) => sendControl({ kind: 'text', text }),
  /**
   * ⚠️ 合成串**只记在 Mac 上**（`.mirror-mactext-capsule`），**不送手机**。
   * 竞品就是这么做的：拼音只在它自己画的胶囊里出现，手机上那一行看不到拼音。
   * 早先这里是 `return composeViaMacKeyboard(text)`（手机侧 `setComposingText` 画下划线拼音），
   * 那是 10-11 的误读 —— 用户说的"输入法文字显示在光标后"指的是 **Mac 上的胶囊**，不是手机。
   * 两边都画就是同一串出现两次（10-11 用户拿截图说「不对」，指的就是这个）。
   */
  compose: (text) => {
    noteMacTextComposing(text)
  },
})
/** 只有归属在 `active` 时才收字：`parked`（用户在手机上按了 ×）还往里送就是跟他抢键盘。 */
function macTextCapturing() {
  return macKeyboard.value === 'active'
}
/**
 * 收字字段**当前有没有拿到焦点** —— 这才是"按键归谁"的判据。
 * ⚠️ 不能拿 `macTextCapturing()` 当它：状态是 active 但焦点在别处（用户刚点了长条上的键、
 * 或窗口刚切回来）时，`useMirrorInput` 那边会以为"有人收"而不发 `kind:'text'`，
 * 隐藏字段又收不到事件 ⇒ 两边都不发，按键凭空消失（10-11 真机撞到的：敲进去一个字符都没落地）。
 */
const macTextFocused = ref(false)

/**
 * 候选窗锚点（G1 续）：macOS 摆放输入法候选窗**只认宿主交给它的 caret 矩形**。
 * 原生应用（竞品）自己实现 `NSTextInputClient.firstRectForCharacterRange:`，把手机光标
 * 换算成屏幕坐标返回回去；Electron 里这条方法改不了 —— Chromium 拿**聚焦元素的 DOM caret
 * 矩形**充当它。所以"候选窗贴哪"在渲染层只有一条路：**把收字字段摆成那个矩形**。
 *
 * ⚠️ 设备侧**报得出手机光标的屏幕矩形**（Slice 4c，已真机验证）—— 2026-10-11 走完了全程：
 * 第一轮误判成"Android 没有这条路"；第二轮从竞品身上挖出 `requestCursorUpdates`（**不是不下发，
 * 是要输入法先要**，我们没要 `mCursorRect` 才恒为 `0,0-0,0`）；第三轮真机验证发现回调会来、
 * 但坐标对不上 —— 原因不是平台不行，而是漏了 `getMatrix()`（`getInsertionMarker*` 是**编辑器
 * 本地坐标**，官方那句 "in the screen coordinates" 说的是过矩阵之后的结果）。补上变换后
 * 两类编辑器都精确吻合，详见 `docs/NATIVE_MIRROR.md` §G1 Slice 4c。
 *
 * 所以：**设备报的那条优先**（`TRUST_DEVICE_CARET`，现在开着）；下面这套"自己攒"的估计只在
 * 设备没报时兜底（编辑器不支持、或光标没了）。
 *
 * 三个量缺一个观感就不对：
 * - `x` = 基准 x + 已送文本的推进宽度（不然打几个字候选窗就落在光标后面）；
 * - `y` = 基准 y；
 * - `height` = **一个行高** —— 1px 高的矩形会被 macOS 摆在那个点上、压在文字行上；
 *   一个行高、且以锚点为中心，候选窗才落在文字行**下方**。
 */

/**
 * 要不要采信设备报来的光标矩形（Slice 4c）。**开**。
 *
 * 2026-10-11 这条走过一段弯路，记下来免得再踩：设备侧 `getInsertionMarker*` 报的是
 * **编辑器本地坐标**，不是屏幕坐标 —— 而 `CursorAnchorInfo` 的**类摘要**写的是
 * "in the screen coordinates"，那句话说的是**过 `getMatrix()` 之后**的结果。当时漏了那一步，
 * 于是把"本地坐标"误判成"平台给不出屏幕坐标"，一度把这条路整个关掉。
 *
 * 补上 `matrix.mapPoints()` 后，真机实测两类编辑器都对得上（`docs/NATIVE_MIRROR.md` §G1 Slice 4c）：
 * MIUI 原生 EditText 的矩阵是纯平移（= 控件屏幕原点），WebView 的矩阵是缩放 2.75 + Y 平移 244
 * （= 设备像素比 + WebView 顶部），变换后的值都精确落在控件真实边界内。
 *
 * 设备侧已经做完变换、报的就是**屏幕坐标（设备 px）**，所以这里直接采信。
 * 若哪天遇到某类编辑器又不对，先查它的 `getMatrix()` 有没有被正确设置，再考虑按应用放行。
 */
const TRUST_DEVICE_CARET = true

const macTextAnchorBase = ref(null)
/** 自基准以来**已提交**的文本（退格往回删一个字符）。 */
const macTextCommitted = ref('')
/** 当前合成串（拼音）。合成结束并入上面那串 —— 期间它顶替光标，所以也要算进推进宽度。 */
const macTextComposing = ref('')
/** 设备报来的手机光标矩形（设备坐标）。**有它就以它为准**，上面那套估计整个让位。 */
const macTextDeviceCaret = ref(null)

/** 换算结果：`.mirror-screen` 内的 CSS px，绑给字段的 `left/top/height`。 */
const macTextAnchorCss = ref(null)

/**
 * `.mirror-screen` 的宽（CSS px）—— 胶囊**固定宽度**要按它夹取，免得顶出画面右缘。
 * 与 `macTextAnchorCss` 同一个出处（`syncMacTextAnchor()` 里那次 `getBoundingClientRect()`），
 * 所以是同一个 ref 家族：一起更新，不会出现"位置是新的、宽度是旧的"。
 * 拿不到就是 0（= 未知），`capsuleRect` 那时**不夹**。
 */
const macTextScreenWidth = ref(0)

/**
 * 拼音胶囊：把"正在输入的拼音"画在 Mac 上（竞品同款形状）。
 * 为什么要自己画见 `macTextCapsule.js` 顶部 —— 一句话：macOS 不代画 marked text，
 * 而我们的收字字段是 1×1 全透明，Chromium 画在里面等于看不见。
 *
 * ⚠️ 竞品是**三层**：正文行 → 胶囊 → 系统候选条。所以胶囊**不骑在正文行上**，
 * 而是自己占正文行**下面**那一格；交给 macOS 的 caret 矩形也跟着下移成这一格
 * （见 `macTextAnchorStyle`），系统候选条才会落在胶囊**下面**而不是压着胶囊。
 * 两个矩形的关系与取值依据在 `macTextCapsule.js` 的 `capsuleRect`。
 *
 * ⚠️ 胶囊**固定宽度**且**夹在画面内**（第四轮，用户：「拼音框不要无限长，固定宽度，
 * 而且不要超出屏幕」）：宽度与夹取都在 `capsuleRect` 里算，所以**字段位置跟着一起夹** ——
 * 两层同源，不会一个夹了一个没夹。
 */
const macTextCapsuleState = computed(() =>
  macTextCapsule({
    capturing: macTextCapturing(),
    focused: macTextFocused.value,
    composing: macTextComposing.value,
  }),
)
/** 胶囊矩形 = 交给 macOS 的那一格。字段位置与胶囊样式**同源**，两层不会错开。 */
const macTextCapsuleRect = computed(() => capsuleRect(macTextAnchorCss.value, macTextScreenWidth.value))
const macTextCapsuleStyle = computed(() => capsuleBox(macTextAnchorCss.value, macTextScreenWidth.value))

function macTextCanvasRect() {
  return canvasHost.value?.querySelector?.('canvas')?.getBoundingClientRect?.() ?? null
}

/** 一个 em 有多少设备像素（1sp = dpi/160 px）。密度取自设备（`wm density`，会话启动时那份）。 */
function macTextEmPx() {
  const size = getVideoSize()
  const info = getSessionInfo()
  const dpi = scaleDisplayDpi(info?.screenSize, info?.screenDpi, size)
  // 密度拿不到就按长边等比估：1080×2340 / 440dpi 的机器上 16sp ≈ 44px ≈ 长边的 1.9%。
  return dpi > 0 ? emSizePx(dpi) : (size?.height ?? 0) * 0.019
}

/** 设备报来的光标矩形 —— 只在 `TRUST_DEVICE_CARET` 打开时才认（原因见那个常量）。 */
function reportedDeviceCaret() {
  return TRUST_DEVICE_CARET ? caretRectToAnchor(macTextDeviceCaret.value) : null
}

/** 锚点（设备坐标）：采信设备报的光标时以它为准，否则用「基准 + 已送文本推进宽度」。 */
const macTextAnchor = computed(() => {
  const reported = reportedDeviceCaret()
  if (reported) return { x: reported.x, y: reported.y }
  const base = macTextAnchorBase.value
  if (!base) return null
  const advance = estimateAdvancePx(macTextCommitted.value + macTextComposing.value, macTextEmPx())
  return { x: base.x + advance, y: base.y }
})

/** caret 矩形的高度（设备 px）：设备报了且被采信就照抄，否则按一个行高估。 */
function macTextCaretHeightPx() {
  const reported = reportedDeviceCaret()
  return reported?.height > 0 ? reported.height : macTextEmPx() * LINE_HEIGHT_RATIO
}

/**
 * 设备坐标 → 交给 macOS 的 caret 矩形。纯换算在 `macTextAnchor.js`，这里只负责取矩形。
 *
 * ⚠️ 定位祖先的矩形**只量一次**、两个用途：`deviceToScreen` 拿它换算坐标，
 * `macTextScreenWidth` 拿它的宽夹取固定宽度胶囊。分两次量不但多一次布局读，
 * 还可能量到两帧之间的不同值（位置是新的、宽度是旧的）。
 */
function syncMacTextAnchor() {
  const screenRect = macTextInput.value?.parentElement?.getBoundingClientRect?.() ?? null
  macTextScreenWidth.value = screenRect?.width ?? 0
  macTextAnchorCss.value = deviceToScreen({
    point: macTextAnchor.value,
    rect: macTextCanvasRect(),
    size: getVideoSize(),
    screenRect,
    caretHeightPx: macTextCaretHeightPx(),
  })
}

/** 把窗口里的一个点定成**新基准**（设备坐标），并把已送文本清零。 */
function anchorMacTextAt(clientX, clientY) {
  if (!macTextCapturing()) return
  macTextAnchorBase.value = clientToDevice({ clientX, clientY, rect: macTextCanvasRect(), size: getVideoSize() })
  macTextCommitted.value = ''
  macTextComposing.value = ''
  syncMacTextAnchor()
}

/** 还没点过画面时的兜底：画面正中。比留在左上角好 —— 至少不跟手机光标差半屏。 */
function anchorMacTextToVideoCenter() {
  const size = getVideoSize()
  if (!size?.width || !size?.height) return
  macTextAnchorBase.value = { x: size.width / 2, y: size.height / 2 }
  macTextCommitted.value = ''
  macTextComposing.value = ''
  syncMacTextAnchor()
}

/**
 * 送出去一段文本 = 手机光标往前走了那么多。记账要发生在**送之前**、且只发生一次
 * （`createMacTextSink` 的 `fallback` 是"桥没连上时补发"，不能在那里再记一遍）。
 */
function noteMacTextCommit(text) {
  macTextCommitted.value += text
  macTextComposing.value = ''
  syncMacTextAnchor()
}

/** 合成串每敲一个字母来一条，**顶替**上一条（不是追加）。空串 = 结束合成。 */
function noteMacTextComposing(text) {
  macTextComposing.value = text
  syncMacTextAnchor()
}

/** 退格：手机把光标左边的字删掉了，我们跟着退。合成中的退格只撤合成，不动已提交那串。 */
function onMacTextBackspace() {
  if (!macTextCapturing()) return
  if (macTextComposing.value) macTextComposing.value = ''
  else macTextCommitted.value = macTextCommitted.value.slice(0, -1)
  syncMacTextAnchor()
}

/** 退格/删除键。`useMirrorInput` 那条路只负责把按键送给手机，光标这笔账要在这边跟着记。 */
function onMacTextKeyDown(event) {
  if (event.key === 'Backspace' || event.key === 'Delete') onMacTextBackspace()
}

/**
 * 收字字段的位置 = **交给 macOS 的 caret 矩形**。
 *
 * ⚠️ 用的是**胶囊矩形**，不是正文行矩形（`macTextCapsuleRect`，几何见 `macTextCapsule.js`）：
 * macOS 把系统候选条摆在 caret 矩形的下沿，所以矩形落在哪一格，候选条就贴在哪一格下面。
 * 竞品是「正文行 → 胶囊 → 候选条」，我们把矩形放到胶囊那一格才复现得了；
 * 放在正文行那一格的话，候选条会压在胶囊上（10-11 旧版就是这样）。
 *
 * `font-size` / `line-height` 决定 DOM caret 的高度 —— 必须跟盒子一样高，否则 Chromium
 * 报给 macOS 的还是那条 1px 的线，候选条会压在胶囊中间。
 */
const macTextAnchorStyle = computed(() => {
  const rect = macTextCapsuleRect.value
  if (!rect) {
    // 退化（高度拿不到）：只给位置，不给高度 —— 宁可退回"1px 的线"，也不要编一个假高度。
    const css = macTextAnchorCss.value
    return css ? { left: `${css.left}px`, top: `${css.top}px` } : {}
  }
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    height: `${rect.height}px`,
    fontSize: `${rect.height}px`,
    lineHeight: `${rect.height}px`,
  }
})

/** 点画面 = 用户把手机光标放到了那里，收字字段跟过去，候选窗才会贴在光标下。 */
function onMirrorScreenPointerDown(event) {
  anchorMacTextAt(event.clientX, event.clientY)
}

function focusMacText() {
  if (!macTextCapturing()) return
  if (!macTextAnchor.value) anchorMacTextToVideoCenter()
  macTextInput.value?.focus({ preventScroll: true })
}
function onMacCompositionEnd(event) {
  // 合成串的清理由 `macSink.onCompositionEnd` 里的 `compose("")` 负责（那里才看得全：
  // 提交、Esc 取消、收成空串三种走法都要收起胶囊），这里只管把字段自己清干净。
  macSink.onCompositionEnd(event)
  if (macTextInput.value) macTextInput.value.value = ''
}
function onMacInput(event) {
  macSink.onInput(event)
  if (!macSink.composing && macTextInput.value) macTextInput.value.value = ''
}
/**
 * 设备送回来的坏消息：字发出去了但没落进任何输入框（手机上没聚焦的编辑器）。
 * 以前这是静默丢的 —— 用户只看"打了没上屏"，什么都查不到（10-11）。
 */
onMacKeyboardFeedback(({ reason }) => {
  showNotice(reason === 'no-editor' ? '手机上没有正在输入的输入框' : `Mac 键盘没送进去（${reason}）`)
})
// 归属一变成 active 就把焦点落到收字字段上，否则用户得先点一下画面才能打字。
// ⚠️ 必须等一拍：`:disabled` 与这个 watcher 同一次更新里改，字段这会儿还是 disabled，focus() 会被忽略。
watch(macKeyboard, () => nextTick(focusMacText))

/** 指针 / 滚轮 / 键盘 → 控制消息（直写本进程 control socket）。 */
useMirrorInput({
  target: canvasHost,
  getVideoSize,
  // 可打印字符归谁：收字字段真的拿到焦点才归它，否则照旧走 `kind:'text'`（ASCII 不回归）。
  captureText: () => macTextFocused.value && macKeyboard.value === 'active',
})

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
 * 长条那颗「桌面模式」（用户 2026-10-11 点单）：把手机主屏上**正在用的应用**抽到一块独立虚拟屏
 * 窗口里 —— 与首页「点应用」同一条路（虚拟显示 + 把 task 搬过去，不重启应用），只是包名由主进程
 * 现问设备。已在播的应用会复用那个窗口（主进程 `findAppSession`），所以 `reused` 要单独给一句话。
 *
 * 该不该出这颗按钮由主进程判好随启动参数带来（`desktopModeAvailable` = 采主屏的会话 + Android 14+），
 * 页面**不自己判版本**：判据两处各写一遍就会漂（同 `deviceMirror` 那条规矩）。
 */
const desktopModeAvailable = ref(false)
const desktopBusy = ref(false)
async function openDesktopModeWindow() {
  if (desktopBusy.value) return
  desktopBusy.value = true
  try {
    const result = await openDesktopMode()
    const name = result?.label || result?.packageName || '这个应用'
    showNotice(result?.reused ? `${name}已经单独开着窗口了` : `已把${name}放到独立窗口`)
  } catch (error) {
    // 失败要说清为什么（手机上停在桌面时主进程抛的就是那句「没有打开的应用」）。
    showNotice(error?.message || '打开桌面模式失败')
  } finally {
    desktopBusy.value = false
  }
}

const waking = ref(false)

async function continueAfterSleep() {
  if (waking.value) return
  waking.value = true
  try {
    const result = await wakeScreen()
    // 失败只回一行文案：MIUI 上这条吃「USB 调试（安全设置）」那道闸，被拒要说清为什么。
    if (!result?.ok) {
      showNotice(result?.message || '唤醒失败')
      return
    }
    // ⚠️ 成功**不改 `wakefulness`**：命令被接受 ≠ 设备真醒了（屏亮起到 `mWakefulness` 翻成 `Awake`
    // 有几百毫秒，锁屏还会把它按回 Dozing）。上一轮在这里乐观写了 `Awake`，横幅当场消失、
    // 画面却还定着，而且轮询的基线被我们写歪之后再也不会来纠 —— 就是用户 10-10 报的
    // 「点亮屏幕已休眠按钮就消失了，但其实手机无法操作」。
    // 灵敏度靠快轮询拿：kick 之后 300ms 一拍，设备真醒了立刻撤横幅。
    kickSleepWatch()
  } finally {
    waking.value = false
  }
}

function syncCanvasBox() {
  const host = canvasHost.value
  const canvas = renderer.value?.canvas
  if (!host || !canvas) return
  const size = getVideoSize()
  if (size?.width && size?.height) {
    frameRatio = size.width / size.height
    // 全屏那一屏的黑框按这个比例收（见上面 `screenRatio` 那条为什么不能取 meta）。
    screenRatio.value = `${size.width} / ${size.height}`
  }
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
      onFullscreen: (value) => {
        fullscreen.value = value
        // 进满屏：长条常驻 ⇒ 三颗一起放出来（落点由 `resize` 按新窗口宽重贴）。
        // 出满屏：交回 hover 那套，此刻长条没收就顺手藏掉。
        setWindowButtons(value || railShown.value)
      },
      onSleepChange: (_asleep, state) => {
        // 存原始读数：横幅与那颗图标都从它派生，页面自己不另记状态。
        // 某一项这拍没读到就留上一项（面板与设备两条 dumpsys 各自都可能失败）。
        powerState.value = {
          wakefulness: state.wakefulness ?? powerState.value.wakefulness,
          screen: state.screen ?? powerState.value.screen,
        }
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
    // 启动参数到手才知道那颗「桌面模式」该不该出（主进程判好了，见 `desktopModeAvailable`）。
    desktopModeAvailable.value = getSessionInfo()?.desktopModeAvailable === true
  }).catch((error) => {
    status.value = `镜像连接失败：${error?.message || error}`
  })
}

onMounted(() => {
  // 虚拟显示按**画面区**算（见 direct-session 的 contentCss）：dev 右侧那条 HUD 边栏
  // 不算进画面区，否则显示比例与画面比例对不上。必须在 bootstrap 之前设好。
  setContentElement(canvasHost.value)
  hostResize = new ResizeObserver(() => {
    syncCanvasBox()
    // 锚点存的是设备坐标：画面矩形一变就得重算显示位置，否则候选窗会跟手机光标错开。
    syncMacTextAnchor()
  })
  if (canvasHost.value) hostResize.observe(canvasHost.value)
  // 退格只走按键那条路（`kind:'key'`），收字字段的 `input` 事件里 `data` 是 null，翻不成文本 ——
  // 所以光标账要在这里跟着记，不然退几个字之后候选窗就停在原地了。
  window.addEventListener('keydown', onMacTextKeyDown)
  // 设备侧报来的**手机光标矩形**（Slice 4c）：有它候选窗就贴真实光标，没有才退回上面那套估计。
  disposeMacCaret = onMacKeyboardCaret((rect) => {
    macTextDeviceCaret.value = rect
    syncMacTextAnchor()
  })
  // 输入法归属是主进程记着的，页面重载（HMR / 接回）后不能自己回到「关」——问一句。
  setMacKeyboard('state').then(applyMacKeyboardState).catch(() => {})
  void booted()
})

onBeforeUnmount(() => {
  if (statsTimer) clearInterval(statsTimer)
  hostResize?.disconnect()
  window.removeEventListener('keydown', onMacTextKeyDown)
  disposeMacCaret?.()
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
  <div class="h-full mirror-window text-white" :class="{ 'is-fullscreen': fullscreen }" :style="windowStyle">
    <!-- 画面区：dev 时右侧让出一条 HUD 边栏（`aside` 与它左右排），画面上的覆盖层（遮罩/接回/提示/
         长条）都只盖画面那一块，这样调试信息永远不被盖住，也不会压在镜像画面上。 -->
    <div class="mirror-main">
      <!-- 画面：位置与尺寸固定（= 窗口减掉那圈黑框与右边那条长条，两边同一个出处 `mirrorScreenInsets()`）。 -->
      <div class="mirror-frame" @pointerdown="focusMacText()">
        <!-- 屏内各层在同一格里叠，压在画面上的是后面的兄弟节点；`attachCanvas()` 会清空
             `mirror-canvas`，所以覆盖层都是它的兄弟，不放进去。 -->
        <div class="mirror-screen" @pointerdown="onMirrorScreenPointerDown($event)">
          <div ref="canvasHost" class="mirror-canvas"></div>

          <!-- Mac 键盘收字的隐藏字段（Slice 4）：1×1、不接鼠标，只为让 macOS 输入法有可聚焦的
               宿主肯出候选窗。它是 `.mirror-canvas` 的兄弟（`attachCanvas()` 会清空 canvasHost）。
               `left/top` 绑的是**胶囊那一格**（G1 续）：macOS 的系统候选条跟着宿主的 DOM caret 走，
               摆在这个矩形下沿；字段不动，候选条就会落在画面左上角。 -->
          <input ref="macTextInput" class="mirror-mactext" aria-label="Mac 键盘输入" autocomplete="off"
            :style="macTextAnchorStyle" :disabled="!macTextCapturing()" @compositionstart="macSink.onCompositionStart()"
            @compositionupdate="macSink.onCompositionUpdate($event)" @compositionend="onMacCompositionEnd($event)"
            @input="onMacInput($event)" @focus="macTextFocused = true" @blur="macTextFocused = false" />

          <!-- dev 探针（G1 续）：**交给 macOS 的那个 caret 矩形本身**（1px 宽、一个胶囊高）。
               ⚠️ **默认不画** —— 用户 10-11：「我不要自定义光标，输入选择框位置对就行」。
               它只是给我们自己看锚点对不对的诊断，不是产品的一部分，所以挂在 dev 调试面板
               （`tools` 按钮，默认收起）底下；打包版里 `devTools` 为假，元素压根不存在。
               判据：它跟**胶囊**重合 ⇒ 矩形对；候选条紧贴它下边 ⇒ 高度对；
               打字后它落在手机光标后面 ⇒ 推进宽度估小了。 -->
          <div v-if="devTools && showHud && macTextCapsuleRect && macTextCapturing()" class="mirror-mactext-probe"
            :style="macTextAnchorStyle" aria-hidden="true"></div>

          <!-- 拼音胶囊（G1 续）：**正在输入的拼音**画在 Mac 上（竞品同款形状）。
               macOS 不代画 marked text，收字字段又是 1×1 全透明 ⇒ 不画这个，Mac 上就什么都看不到。
               它占**正文行下面那一格**（与交给 macOS 的矩形同源）；系统候选条再贴在它下面，
               于是形成竞品那三层「正文行 → 胶囊 → 候选条」。
               ⚠️ **固定宽度**（`capsuleBox()` 给死，不随合成串变）、且被夹在画面内
               （用户 10-11：「拼音框不要无限长，固定宽度，而且不要超出屏幕」）；装不下的合成串
               在内部**从头部裁**，光标那一段永远留着。
               ⚠️ 不接指针、不参与输入 —— 锚点仍由收字字段决定，这里只是显示器。 -->
          <div v-if="macTextCapsuleState.visible" class="mirror-mactext-capsule"
            :style="macTextCapsuleStyle" aria-hidden="true">
            <span class="mirror-mactext-capsule__text">{{ macTextCapsuleState.text }}</span>
            <span class="mirror-mactext-capsule__caret"></span>
          </div>

          <!-- 设备睡下了：给一个「继续使用」点亮屏幕（照竞品的「已休眠」那一格）。
               不自动弹醒 —— 手按电源键是用户的决定，程序不该抢。 -->
          <div v-if="asleep" class="mirror-sleep" style="-webkit-app-region: no-drag">
            <p class="mirror-sleep__title">已休眠</p>
            <button type="button" class="mirror-sleep__button" :disabled="waking" @click="continueAfterSleep">
              {{ waking ? '唤醒中…' : '继续使用' }}
            </button>
          </div>

          <!-- 应用被别的显示拿走时，画面中间给一个接回入口（带应用图标）。
               平时不显示：没被抢就不该有多余控件压在画面上。 -->
          <div v-if="stolen" class="mirror-reclaim" style="-webkit-app-region: no-drag">
            <img v-if="appIcon" :src="appIcon" class="mirror-reclaim__icon" alt="" />
            <span v-else class="mirror-reclaim__icon mirror-reclaim__icon--letter">{{ (appTitle || '?').slice(0, 1)
            }}</span>
            <button type="button" class="mirror-reclaim__button" :disabled="reclaiming" @click="reclaim">
              {{ reclaiming ? '接回中…' : '接回画面' }}
            </button>
          </div>

          <p v-if="notice" class="mirror-notice">{{ notice }}</p>

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

          <p v-if="status" class="mirror-status">{{ status }}</p>
        </div>

        <!-- 拖窗口的条：这扇窗口没有标题栏可抓，只能靠它。它压在画面顶部 24px 上，
             代价是手机画面最顶那一条点不到（先落窗口拖动）。 -->
        <div class="mirror-dragstrip"></div>
      </div>

      <!-- 长条的**格子**：手机右边外面那 74px，永远占着（画面那块矩形才不动）。
           它自己不画东西，只负责收 poke —— 鼠标一进这一格就弹，不用按坐标筛。
           poke 挂在格子上而不是面板上：面板收起时 `pointer-events: none`，显形时又盖住格子，
           挂格子上两种状态都由同一条 `pointermove`（冒泡上来）接住。 -->
      <div class="mirror-rail" ref="railSlot" @pointermove="reveal.poke()" @pointerleave="onRailLeave($event)">
        <!-- 面板：顶部那条 `--rail-keys-top` 以下才排按键 —— 上面那截是红绿灯的位置
             （系统画的，CSS 盖不住，落点由主进程按 `MIRROR_RAIL` 贴进来）。 -->
        <div class="mirror-rail__panel" :class="{ 'is-shown': railShown }">
          <!-- 顶部这一截是红绿灯的地盘：窗口态那三颗是系统画的（CSS 盖不住，落点由主进程按
               `MIRROR_RAIL` 贴进来）。**全屏里它们钉不住**（实测见 `session.js` 的 `enter-full-screen`）
               ⇒ 这一档改由我们自己画三颗一样的，主进程同时把系统那三颗关掉，免得鼠标移到顶边时两套重叠。 -->
          <!-- 顶部这一截是红绿灯的地盘：那三颗是系统画的（CSS 盖不住，落点由主进程按 `MIRROR_RAIL`
               贴进来），窗口态与满屏态都一样 —— 满屏用的是 zoom 撑满的普通窗口，三颗归窗口管、常驻。 -->
          <div class="mirror-rail__lights"></div>
          <!-- 按键说明：reka-ui 的 Tooltip（与主窗口 `PageHeader.vue` 同一套写法）。
               `delay-duration=0` = 一移上就出；`side="left"` = 往按键左边展开（用户 10-10 点名）。
               所以按钮上**不再挂 `title`** —— 两个都留着会同时弹系统气泡和这个气泡。
               Provider 是纯上下文组件，不产生元素，长条的 flex 排布不受影响。 -->
          <TooltipProvider :delay-duration="0">
            <!-- 关屏使用：紧贴在红绿灯那一截**下面**的第一格（用户 10-10 点名放最上）。
                 按下去关手机屏，再点一次恢复亮屏。
                 ⚠️ 图标与高亮画的是**现在的状态**（亮着 = 正常显示器；灭着 = 带斜杠那台 + `is-active`），
                 不是"点下去会发生什么" —— 上一版反着标，他报「明明是亮着屏幕，息屏图标却展示息屏」。 -->
            <TooltipRoot>
              <TooltipTrigger as-child>
                <button type="button" class="mirror-rail__key" :class="{ 'is-active': screenIsOff }"
                  :disabled="screenBusy" :aria-label="screenIsOff ? '恢复亮屏' : '关屏使用'" :aria-pressed="screenIsOff"
                  @click="toggleScreenPower">
                  <Icon :icon="screenIsOff ? 'lucide:monitor-off' : 'lucide:monitor'" :width="18" :height="18" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent side="left" :side-offset="12" :class="TIP_CLASS">{{
                  screenIsOff ? '恢复手机亮屏' : '关掉手机屏，镜像继续'
                }}</TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <!-- 桌面模式（用户 2026-10-11 点单）：把手机主屏上正在用的应用抽到一块独立虚拟屏窗口里
                 —— 与首页「点应用」同一条路。只有**采主屏**的会话（整机镜像）在 Android 14+ 才出这颗：
                 虚拟显示那条路本身就是桌面模式，13 及以下建出来的显示拿不到焦点（判据在主进程）。 -->
            <TooltipRoot v-if="desktopModeAvailable">
              <TooltipTrigger as-child>
                <button type="button" class="mirror-rail__key" :disabled="desktopBusy" aria-label="桌面模式"
                  @click="openDesktopModeWindow">
                  <Icon icon="lucide:app-window" :width="18" :height="18" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent side="left" :side-offset="12" :class="TIP_CLASS">把手机上正在用的应用移进独立窗口</TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <!-- 长条**常驻**（2026-10-11 用户点单：「侧边悬浮按钮栏加一个始终显示悬浮的按钮」）：
                 按下去这条不再自动收（鼠标移到哪它都在），再按一次回到「进格子才弹、离开 1 秒后收」。
                 ⚠️ 高亮画的是**现在的状态**（常驻 = `is-active`），与上面那颗关屏同一条规矩 ——
                 10-10 他报过「图标跟状态反着标」，别再来一次。
                 ⚠️ 不持久化：换一扇窗口 / 重启应用回到非常驻（要跨会话记住得动 `prefs`）。 -->
            <TooltipRoot>
              <TooltipTrigger as-child>
                <button type="button" class="mirror-rail__key" :class="{ 'is-active': railPinned }"
                  :aria-label="railPinned ? '恢复自动收起' : '一直显示悬浮栏'" :aria-pressed="railPinned"
                  @click="toggleRailPinned">
                  <Icon icon="lucide:pin" :width="18" :height="18" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent side="left" :side-offset="12" :class="TIP_CLASS">{{
                  railPinned ? '恢复自动收起' : '让这条一直显示'
                }}</TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <!-- Mac 键盘（G1）：把设备默认输入法切到我们那条，Mac 的输入法才能往手机里打字。
                 亮 = 这台手机现在归我们；抢不过别人时主进程推 `switched_away`，这颗不亮并在画面下方给一句话。
                 ⚠️ 归属是**设备级**的：同一台手机的多个窗口共用它，别按窗口理解。 -->
            <TooltipRoot>
              <TooltipTrigger as-child>
                <button type="button" class="mirror-rail__key" :class="{ 'is-active': macKeyboard === 'active' }"
                  :disabled="macKeyboardBusy" aria-label="使用 Mac 键盘" :aria-pressed="macKeyboard === 'active'"
                  @click="toggleMacKeyboard">
                  <Icon icon="lucide:keyboard" :width="18" :height="18" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent side="left" :side-offset="12" :class="TIP_CLASS">{{
                  MAC_KEYBOARD_TIPS[macKeyboard]
                }}</TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <!-- dev 专用：开合调试面板。 -->
            <TooltipRoot v-if="devTools">
              <TooltipTrigger as-child>
                <button type="button" class="mirror-rail__dev" :aria-expanded="showHud" aria-label="调试信息"
                  @click="showHud = !showHud">tools</button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent side="left" :side-offset="12" :class="TIP_CLASS">调试信息（dev）</TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <!-- 安卓的返回 / 桌面 / 多任务：贴到长条**最底部**（用户 2026-10-10）。 -->
            <div class="mirror-rail__keys">
              <TooltipRoot v-for="key in RAIL_KEYS" :key="key.name">
                <TooltipTrigger as-child>
                  <button type="button" class="mirror-rail__key" :aria-label="key.label"
                    @click="pressRailKey(key.keyCode)">
                    <Icon :icon="key.icon" :width="18" :height="18" />
                  </button>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent side="left" :side-offset="12" :class="TIP_CLASS">{{ key.hint }}</TooltipContent>
                </TooltipPortal>
              </TooltipRoot>
            </div>
          </TooltipProvider>
        </div>
      </div>
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
/* 全局样式（`src/styles/index.css`）给 `#app` 刷了一层 `--color-canvas` 浅色底；镜像页共用这一份
   全局样式，于是整扇窗口被铺成一块浅色板 —— 那才是用户看到的「一直在展示的框框」，不是右侧那条长条。
   窗口本体是 `transparent` + `backgroundColor:#00000000`，这层必须抹掉才真的透明。
   只写在镜像页自己的组件里（`App.vue` 只被 `src/mirror/main.js` 引），主窗口不受影响。
   ⚠️ **选择器要写成 `body #app` 而不是 `#app`**：`main.js` 先 import 组件、后 import 全局样式，
   同特异度时后注入的那条赢（10-10 第一版就栽在顺序上，看着没生效）。 */
:global(body #app) {
  background-color: transparent;
}

/* 布局不靠 `position`：根是左右两栏（画面区 / dev 边栏）用 flex 排，
   每一栏内部要叠的层放进 grid 的**同一格**里 —— 同格按模板里的先后绘制，后面的盖住前面的，
   所以谁在上面看 DOM 顺序就够，连 z-index 都不写。 */
.mirror-window {
  display: flex;
  align-items: stretch;
}

/* 画面区：手机（黑框 + 画面）与右边那条长条左右排。生产中它占满整个视口；
   dev 时再让出右侧的 HUD 边栏（也是 flex 排的），所以覆盖层只盖画面、不盖调试信息。 */
.mirror-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
}

/* 叠层的容器：画面框（屏 + 拖窗口带）、屏内各层、长条格子（面板），各自只有一格。
   `minmax(0, 1fr)` 而不是 `1fr`：格子的下限压到 0，窗口缩小才收得回去 ——
   canvas 上写着死像素，否则 min-content 会把它顶住，ResizeObserver 也就不会触发。 */
.mirror-frame,
.mirror-screen,
.mirror-rail {
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
}

.mirror-frame>*,
.mirror-screen>*,
.mirror-rail>* {
  grid-area: 1 / 1;
  min-width: 0;
  min-height: 0;
}

/* 手机那块：黑框画在这一层的 `border` 上（用户 2026-10-10：黑框永远在，跟着鼠标动的只有右边那条长条）。
   全局 `box-sizing: border-box` ⇒ 内容盒 = 再往里缩 `--bezel`，正好等于主进程 `mirrorScreenInsets()`
   算的那块画面矩形；圆角比里面 `.mirror-screen` 的 `--radius` 多一圈边框厚度，两层才同心。
   宽度 = 画面区减掉长条，剩下全给它（长条那 74px 由 `.mirror-rail` 自己钉死）。 */
.mirror-frame {
  --radius: 40px;
  flex: 1;
  min-width: 0;
  border: var(--bezel) solid #0b0b0d;
  border-radius: calc(var(--radius) + var(--bezel));
}

.mirror-screen {
  /* 收字字段要 `position: absolute` 才挪得到手机光标上（G1 续），它得有个定位祖先。 */
  position: relative;
  overflow: hidden;
  border-radius: var(--radius);
  background: #000;
}

/* Mac 键盘收字的隐藏字段（Slice 4）：要能聚焦、要能出候选窗，但视觉上必须不存在。
   靠 1×1 + 全透明 + 不接指针事件收掉；`left/top` 由 `macTextAnchorStyle` 绑到**胶囊那一格**
   （G1 续）—— 这一个点是它唯一的布局职责，其余各层仍照旧靠 grid 同格叠。
   ⚠️ 不能用 `display:none` / `visibility:hidden` / 零尺寸收掉：那样 DOM caret 矩形不存在，
   macOS 会把候选窗丢回窗口左上角，正是这次要修的现象。 */
.mirror-mactext {
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  font-size: 1px;
  pointer-events: none;
}

/* dev 探针（G1 续）：**交给 macOS 的那个 caret 矩形本身**（= 胶囊那一格），不接指针、不参与输入。
   ⚠️ 只在 dev 且调试面板打开时才渲染（见模板里的 `v-if`）—— 它不是产品的"光标"，
   别让它默认出现在画面上。判据：它跟**胶囊**重合 ⇒ 矩形对；候选条紧贴它下边出现 ⇒ 高度对；
   打字/退格时它跟着走 ⇒ 账记上了；停在原地说明账没记上。 */
.mirror-mactext-probe {
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  background: #ff5a5a;
  pointer-events: none;
}

/* 拼音胶囊（G1 续）：正在输入的拼音画在 Mac 上，形状照竞品（白底圆角胶囊 + 下划线拼音 + 光标）。
   位置、**固定宽度**与高度由 `capsuleBox()` 给（横向贴锚点并夹进画面、**顶边贴在正文行下沿**、
   高 ≈1.3 个行高、宽 ≈3.4 个胶囊高），⚠️ 这里不再有 `translateY(-50%)` —— 胶囊不骑在正文行上，
   而是自己占正文行下面那一格。
   ⚠️ 宽度**不随合成串变**（用户 10-11：「拼音框不要无限长，固定宽度，而且不要超出屏幕」）：
   旧版没有 `width`、内容又把盒子撑开，长拼音会顶出画面右缘被 `overflow: hidden` 裁掉半截。
   ⚠️ 它只是显示器：不接指针、不参与输入、不进无障碍树；锚点仍由收字字段决定。
   系统候选条是 macOS 画的，会按同一个矩形落在它**下面**，所以两层不会打架。 */
.mirror-mactext-capsule {
  position: absolute;
  /* `flex`（不是 `inline-flex`）：宽度由 `capsuleBox()` 定死，内容不许再撑它。 */
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 0.5em;
  border: 1px solid rgb(0 0 0 / 14%);
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 2px 8px rgb(0 0 0 / 16%);
  color: #111;
  line-height: 1;
  /* 固定宽度装不下时不许溢出圆角外（真正裁的是下面那两处）。 */
  overflow: hidden;
  pointer-events: none;
}

.mirror-mactext-capsule__text {
  /* 下划线 = marked text 的语义（这一段还没定下来），与竞品一致。 */
  text-decoration: underline;
  text-underline-offset: 0.15em;
  letter-spacing: 0.06em;
  /* 合成串长了只压这一段（`flex-shrink` + `min-width: 0`），光标那一段永不被压缩。 */
  flex: 0 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  /* 装不下时**从头部裁**（保住靠近光标的那一端）：`direction: rtl` 让 LTR 文本在盒内右对齐、
     溢出裁在左边。字符顺序不变 —— 拼音是纯 LTR 强字符，不会触发双向重排。 */
  direction: rtl;
}

.mirror-mactext-capsule__caret {
  /* `flex: none` —— 光标是这一段里最不能丢的东西：合成串再长它也得留在胶囊内。 */
  flex: none;
  align-self: stretch;
  width: 1.5px;
  margin: 0.25em 0 0.25em 0.08em;
  background: #111;
}

/* 画面容器（`canvasHost`）：解码出的 canvas 居中放在这块矩形里，虚拟显示也按它算尺寸。 */
.mirror-canvas {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
}

/* 长条的**格子**：手机右边外面那 86px，永远占着布局（画面那块矩形才不因显隐而动），自己不画东西。
   poke 挂在这一格上（见模板）—— 面板收起时它是命中层，显形时面板盖住它、move 冒泡上来还是它接住，
   两种状态同一条判据，不用按坐标筛。 */
.mirror-rail {
  flex: none;
  width: var(--rail-w);
}

/* 面板：**淡入淡出**，不滑（用户 2026-10-10：「不要从右侧往左展示，直接过渡展示出来就行」）。
   与手机同高（顶到窗口顶与底，10-10 又点「浮动条跟手机一个高度」）、贴窗口右边，只留左右各 6px。
   顶部不留白 —— 那一截归 `.mirror-rail__lights`（红绿灯的地盘）。 */
.mirror-rail__panel {
  /* 面板宽度**从格子推导**：格子左右各留 6px ⇒ 面板与红绿灯（在格子里居中）同一根中线，
     以后只改 `MIRROR_RAIL.width` 一个数，面板与落点会一起跟着走。 */
  --rail-side-gap: 6px;
  /* 开关按键"开着"时的填充色（见下面 `.mirror-rail__key.is-active`）。
     ⚠️ **必须写死，不能用 `var(--color-accent)`**：镜像页是**另一份 CSS 产物**，Tailwind 的
     `@theme` 只把它**真正用到**的令牌发出来 —— 镜像页一个 `accent` 工具类都没有 ⇒ 那段 `:root`
     在产物里压根不存在（`grep -- '--color-accent:' dist/assets/mirror-*.css` = 0 命中），
     `var()` 取不到值就是"背景透明 + 白图标"，在白面板上等于消失。
     色值取浅色主题那个蓝（`src/styles/index.css` 的 `--color-accent` / `-press`），与面板底色
     `#fbfbfb` 同一个道理：**这块 chrome 不跟主题走**。 */
  --rail-accent: #007aff;
  --rail-accent-press: #0064d2;
  justify-self: end;
  width: calc(var(--rail-w) - 2 * var(--rail-side-gap));
  margin: 0 var(--rail-side-gap) 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 0 0 14px;
  border-radius: 26px;
  background: #fbfbfb;
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
  opacity: 0;
  pointer-events: none;
  /* 收得比出来慢一档（用户 10-10「消失的时候感觉不太协调」）：进来跟手，出去收干净。
     红绿灯那边另有 `MIRROR_RAIL.fadeOutMs` 的延后藏起来，两边共用这一个数。 */
  transition: opacity var(--rail-fade-out) ease-in;
}

.mirror-rail__panel.is-shown {
  opacity: 1;
  pointer-events: auto;
  transition: opacity var(--rail-fade-in) ease-out;
}

/* 红绿灯那一截：从窗口顶占到 `--rail-keys-top`，下沿一条分隔线把它与按键区分开。
   里面什么都不放 —— 三颗圆点是系统画在这一块上面的（居中位置见 `MIRROR_RAIL.lightTop`）。 */
.mirror-rail__lights {
  align-self: stretch;
  height: var(--rail-keys-top);
  border-bottom: 1px solid rgb(0 0 0 / 7%);
}


/* ── 全屏那一屏（`.is-fullscreen`，判据由主进程 `mirror:fullscreen` 推过来）────────────────
   照 AndroMeld 那个样子：一块明亮的底、手机在正中央、右侧那条常驻。
   常态那 86px 长条是**从窗口右边挖走一块宽度**的（画面那块矩形才等于设备比例），放到满屏里它把画面
   顶得偏左半条 ⇒ 这一档让长条与画面**同格叠放**（还是 grid 那套，不写 `position`）：格子收到面板
   自己那一小块、贴右上角。 */
.mirror-window.is-fullscreen {
  /* ⚠️ macOS 全屏那一屏背后**不是桌面**：窗口本体透明，在那儿就是一块黑（用户 10-10「背景不要黑色」）。
     所以这一档自己铺亮底，数取竞品那张图四周那圈浅薄荷（在它截图上多点采样 = `#d1e4e4`）。
     窗口态仍然透明 —— 那才是「就是个手机样子」靠的东西。 */
  background: #d1e4e4;
}

.mirror-window.is-fullscreen .mirror-main {
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  /* 顶天立地会贴住屏幕上下沿，留一点呼吸。 */
  padding: 12px;
}

.mirror-window.is-fullscreen .mirror-main>* {
  grid-area: 1 / 1;
  min-width: 0;
  min-height: 0;
}

.mirror-window.is-fullscreen .mirror-rail {
  justify-self: end;
  align-self: start;
}

/* 黑框要**跟着画面收成手机那一块**：常态下窗口本身就是手机形状（`.mirror-frame` 铺满 = 手机），
   满屏时窗口是横的，铺满就成一块 16:9 的黑板 —— 竞品那张图四周露的是桌面，差的就是这一步。
   比例用视频自己的（`--screen-ratio`，由 `syncCanvasBox` 量到真实尺寸那一拍喂进来）：按高铺满、宽由比例定 ⇒ 顶天立地的一块手机。
   横屏视频会撞上 `max-width:100%`，那时退回铺满、画面在里面 letterbox，不会溢出。 */
.mirror-window.is-fullscreen .mirror-frame {
  justify-self: center;
  align-self: center;
  height: 100%;
  width: auto;
  max-width: 100%;
  aspect-ratio: var(--screen-ratio);
  /* ⚠️ 这一档黑框**不再用 `border`**：`aspect-ratio` 管的是**含边框那个盒**（全局 `box-sizing: border-box`），
     边框吃掉的 4px 让里面那块内容盒比视频窄一圈（实测内容盒 442x968 = 0.4566，视频 1080x2340 = 0.4615）
     ⇒ contain 之后上下各露 ~5px 黑（用户 10-11「全屏画面有点黑边」）。改成往外画的 `box-shadow` 那一圈
     不吃布局，盒本身正好等于视频比例。窗口态照旧用 `border`（那边的内容盒由主进程按
     `mirrorScreenInsets()` 定死，正好等于画面矩形，没有这个问题）。
     圆角这里只写内圈 `--radius`：阴影沿元素圆角往外扩 `--bezel` ⇒ 外沿自动是 `radius + bezel`，与窗口态同心。 */
  border: none;
  border-radius: var(--radius);
  box-shadow: 0 0 0 var(--bezel) #0b0b0d;
}

/* 满屏里没用的两样一起撤：拖窗条（那一屏没人会去拖它，留着只压在画面顶上），
   以及红绿灯那一截 —— 真全屏里那三颗归系统收放（顶边才浮出），在他眼里那就是长条顶部一块**空白区域**
   （用户 10-11：「全屏右侧悬浮红绿灯区域要去掉」）。顶边留白改由面板自己的 `padding-top` 给。 */
.mirror-window.is-fullscreen .mirror-dragstrip,
.mirror-window.is-fullscreen .mirror-rail__lights {
  display: none;
}

/* 右侧长条**一直显示**（用户 10-10）：hover 那套显隐只在窗口态有意义。
   特异度高于 `.mirror-rail__panel.is-shown` ⇒ 不用管 JS 那个类，也不用改 `chromeReveal` 的状态机。
   `padding-top` 补回红绿灯那一截撤掉后缺的顶边留白。 */
.mirror-window.is-fullscreen .mirror-rail__panel {
  padding-top: 10px;
  opacity: 1;
  pointer-events: auto;
}

/* 长条上的按键：浅底 ⇒ 图标要压深，不然看不见。 */
.mirror-rail__key {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: none;
  border-radius: 50%;
  background: rgb(0 0 0 / 5%);
  color: rgb(0 0 0 / 62%);
  cursor: pointer;
}

.mirror-rail__key:hover {
  background: rgb(0 0 0 / 9%);
  color: rgb(0 0 0 / 82%);
}

.mirror-rail__key:active {
  background: rgb(0 0 0 / 14%);
}

/* 开关型按键（关屏 / 常驻 / Mac 键盘）**按下去要一眼看得出来**（用户 10-11：
   「悬浮窗按钮选中状态不明显」）。原来只是把灰底从 5% 压到 14% —— 在 `#fbfbfb` 那块面板上
   几乎分不出来。改成**填实的主色**（与主窗口那颗主按钮同一个蓝）+ 白图标：深浅对调，扫一眼
   就知道哪几颗开着。色值出处与"为什么不能写 `var(--color-accent)`"见上面 `--rail-accent`。
   ⚠️ 这三条必须排在 `:hover` / `:active` **后面**：特异性都是两个选择器，靠源码顺序决胜，
   否则鼠标压上去时高亮会被灰底盖掉。 */
.mirror-rail__key.is-active {
  background: var(--rail-accent);
  color: #fff;
}

/* 填实之后悬停/按下照主窗口那颗主按钮的规矩（`BaseButton`：hover 用 `accent-press`、
   按下再压一档亮度），否则鼠标压上去一点反馈都没有。 */
.mirror-rail__key.is-active:hover {
  background: var(--rail-accent-press);
}

.mirror-rail__key.is-active:active {
  filter: brightness(0.9);
}

.mirror-rail__key:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 导航键那一组：贴到长条最底部（`margin-top: auto` 吃掉中间所有余量，不用绝对定位）。
   按键的说明走 `title` 系统 tooltip —— 条里不留文字行（占位标签那一版他说没原来好看）。 */
.mirror-rail__keys {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

/* dev 专用那一格（`tools`）：小一号，别跟功能键抢视觉。 */
.mirror-rail__dev {
  margin-top: 4px;
  padding: 2px 9px;
  border: none;
  border-radius: 999px;
  background: rgb(0 0 0 / 6%);
  color: rgb(0 0 0 / 52%);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.04em;
  cursor: pointer;
}

/* 拖窗口的条：这扇窗口没有标题栏可抓，只能靠它。它是 `.mirror-frame` 那格里的第二层，
   所以只压在**画面顶部 24px** 上（右边那条长条不受它影响），代价是手机画面最顶那一条点不到。 */
.mirror-dragstrip {
  align-self: start;
  height: 24px;
  -webkit-app-region: drag;
}

/* dev 调试信息边栏：**与长条同一套外观**（用户 10-10「风格跟操作栏一样」）—— 浅色圆角、四周留白浮着，
   不再是贴在窗口边上的深色侧栏。它在 `mirror-main` **外面**，窗口由主进程按同样宽度撑开
   （`mirror:windowHud`），所以展开它不会挤小画面、不会让手机重排。 */
.mirror-hud {
  flex: none;
  margin: 6px 6px 6px 0;
  padding: 12px 14px 16px;
  overflow-y: auto;
  border-radius: 26px;
  background: #fbfbfb;
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 1.45;
  color: rgb(0 0 0 / 62%);
}

.mirror-hud__title {
  overflow: hidden;
  font-size: 11px;
  color: rgb(0 0 0 / 82%);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mirror-hud__sub {
  color: rgb(0 0 0 / 45%);
}

.mirror-hud__group {
  margin-top: 9px;
  margin-bottom: 3px;
  font-size: 9px;
  letter-spacing: 0.08em;
  color: rgb(0 0 0 / 32%);
}

.mirror-hud__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.mirror-hud__row span {
  color: rgb(0 0 0 / 45%);
}

.mirror-hud__row b {
  font-weight: 400;
  color: rgb(0 0 0 / 78%);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.mirror-hud__issue {
  margin-top: 8px;
  color: #9a5b06;
  word-break: break-all;
}

.mirror-cover {
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

/* 一次性反馈：贴在画面底边中间（`place-self` 两值 = 垂直靠底、水平居中）。 */
.mirror-notice {
  place-self: end center;
  margin-bottom: 18px;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgb(20 20 22 / 84%);
  color: rgb(255 255 255 / 78%);
  font-size: 11px;
}

/* 还没连上 / 连不上时铺在画面上的那句话（原来用 Tailwind 的 `absolute inset-0`）。 */
.mirror-status {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
  text-align: center;
  font-size: 12px;
  color: rgb(255 255 255 / 60%);
  pointer-events: none;
}
</style>
