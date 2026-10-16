<script setup>
import { AutoCanvasRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'
import { Icon } from '@iconify/vue'
import { useMirrorInput } from './useMirrorInput.js'
import { bootstrap, dispose as disposeSession, reclaimApp, wakeScreen, setWindowButtons, setHudExtra, setRailFloating, getSessionInfo, setContentElement, sendControl, setScreenPower, kickSleepWatch, setMacKeyboard, watchMacKeyboardState, syncMacKeyboard, commitViaMacKeyboard, onMacKeyboardFeedback, onMacKeyboardCaret, openDesktopMode } from './direct-session.js'
import { createMacTextSink } from './macTextSink.js'
import { caretRectToAnchor, clientToDevice, deviceToScreen, emSizePx, estimateAdvancePx, LINE_HEIGHT_RATIO } from './macTextAnchor.js'
import { capsuleBox, capsuleRect, macTextCapsule } from './macTextCapsule.js'
import { scaleDisplayDpi } from '../../shared/scrcpyConfig.js'
import { aspectDiffers, createReflowGate } from './displayFollow.js'
import { createChromeReveal, chromeZone } from './chromeReveal.js'
import { clampRailPos, clampRailTop, railAnchorTop, RAIL_DRAG_THRESHOLD } from './railDock.js'
import { FROZEN_STATES, needsRealWake, panelIsOff } from './sleepWatch.js'
import { KEY_CODES } from '../../shared/keys.js'
import { MIRROR_FRAME, MIRROR_RAIL, MIRROR_TITLEBAR, MIRROR_SCREEN_RADIUS, mirrorRailFloats, mirrorRailTop, mirrorTitlebarNameLeft } from '../../electron/mirror/options.js'

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
 * 操作条（返回/Home/多任务 + 那几颗开关）：平时不画，鼠标进到它的区域才淡入，**离开 1 秒后收回**
 * （状态机在 `chromeReveal.js`）。红绿灯不跟着开关 —— 用户 2026-10-11 定「恢复默认，不要有任何修改」，
 * 落点与显隐全归 AppKit。
 *
 * 条上那颗**「一直显示」**（2026-10-11 用户点单）：按下去常驻、不再自动收，再按一次回到上面那套
 * hover 显隐（状态在 `railPinned`，判据在 `chromeReveal.js` 的 `setPinned`）。
 *
 * **2026-10-16 换成现在这个形态**（用户：「镜像投屏的时候将黑色手机边框去掉，右侧悬浮更改为上方很小
 * 的悬浮，有一种透明玻璃质感」+「浮动到画面顶部右边，跟 mac 3 个彩虹按键对齐」+「鼠标移入到上边悬浮
 * 按钮区域才显示」）：它是**浮在画面顶部右侧的一条横向玻璃胶囊**，纵向与三颗彩虹键中线对齐，
 * 不占布局。前几版都已作废，别照着旧记录找：
 * - 2026-10-10：挪到**画面右边外面**（占窗口宽度、按坐标筛触发）；
 * - 2026-10-14：画面够宽时再换成"浮在画面右侧、上下居中"（`MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH`）。
 * 两者连同"两档形态"一起退场（判据 `mirrorRailFloats` 现在恒真，见 `railFloating`）。
 * 样式在 CSS 里 `.mirror-window.is-rail-float` 那一组，几何出处是 `options.js` 的 `MIRROR_RAIL`。
 */
/**
 * 满屏那一屏（绿色按钮 zoom / 设置里的「满屏启动」）是**另一种形态**：手机要在整块屏幕正中，
 * 常态那条从顶到底、还从窗口右边挖走 86px 宽度的长条在这里两件事都碍事（画面会偏左半条）。
 * 状态由主进程推过来（`mirror:fullscreen`），初值取启动参数里的 `prefs.fullscreen`；
 * 排法全在 CSS（`.mirror-window.is-fullscreen` 那一组）。
 */
const fullscreen = ref(false)
/**
 * 这一档有没有**我们自己建的那块 flex 显示**（桌面模式 / 首页点应用 = 真；整机镜像与 13 及以下
 * 点应用 = 假，那档采的是手机主屏）。只有它有形状可改 —— 尺寸归 `resizeDisplay` 说话。
 */
const virtualDisplay = ref(false)
/** 标题栏那行「app - 设备名」：式子在主进程（`session.windowTitle`），这里只照抄，两处不各写一遍。 */
const windowTitle = ref('')
/**
 * 「桌面模式的全屏」那一屏（用户 2026-10-11：「只把视频全屏，其他什么东西都不要有，
 * 镜像比例跟显示器一样」）= 满屏 **且** 这一块显示是我们建的。
 *
 * 排法见下面 CSS 的 `.is-edge-to-edge` 那一组：画面铺满整屏、黑框/亮底/圆角全去掉。
 * 「比例跟显示器一样」不是把画面拉伸，而是画面区铺满之后 `contentCss()` 就是整屏，
 * 现有那条 ResizeObserver ⇒ `displayFollower` ⇒ `resizeDisplay` 会把虚拟显示**重排成显示器的形状**
 * （退出全屏时同一条路再排回手机形状）。拉伸与裁切都不做 —— 那两条用户 10-10 明确否过。
 */
const edgeToEdge = computed(() => fullscreen.value && virtualDisplay.value)
/**
 * 长条的触发判据。**2026-10-16 起分两条路**（用户这一轮点的显隐方式是「鼠标移入到上边悬浮按钮区域才显示」）：
 *
 * **窗口态**（唯一形态：窗口 = 画面，操作条是浮在画面顶部右侧的一条玻璃胶囊）——
 * 触发区是**两块 DOM**，都由元素自己的 `pointerenter` / `pointerleave` 接，**不走坐标判**：
 * ① 头部那条（`.mirror-float-drag`，整窗宽 × `floatDragHeight`）—— 用户 2026-10-17
 *    「鼠标移动到头部可拖拽的地方就展示出来」；
 * ② 胶囊自己的命中区（`.mirror-rail` = 胶囊 + 一圈外扩）—— 让它"贴着胶囊上下挪"时也保持显形。
 * 理由：胶囊浮在画面上、宽度随内容变（按钮数随条件渲染：桌面模式那颗只在采主屏那档出、
 * dev 那格只在开发时出），它的命中区正是 DOM 自己知道的那个矩形；按坐标另算一套只会两边漂。
 * 这一路**不进** `onScreenPointerMove`（坐标判只服务满屏那两档）。
 *
 * **满屏那两档**仍按坐标判 —— chrome 是一个 **L 形**（右边长条 + 上边那条），两条臂都算触发区
 * （用户 2026-10-12「鼠标移动到右侧和上边都要展示边框」）。进 `fullscreenWidth`（横）/
 * `revealHeight`（竖）才显形，两条臂**都**越出各自 +120 才算离开，中间那一圈保持现状（迟滞，
 * 判据在 `chromeZone`）。上臂只有 `MIRROR_TITLEBAR.revealHeight` 那一截收得到事件（顶条其余是
 * drag 区，drag 里 Chromium 不发指针事件），所以进线就按那一截算；出线仍多给 120px ——
 * 鼠标停在按钮上或稍挪一点就当场收一半再弹回，就是「一闪一闪」。
 *
 * 为什么满屏那两档不改成「挂在长条自己那一格 + 按格子矩形判移出」（2026-10-11 之前的写法，作废过）：
 * - 那一档长条浮在画面上，格子若吃事件就把画面右缘那一截的点按抢走了；
 * - 格子矩形只到面板那么高（约 361px），而想摸条的人是从**任意高度**贴过来的 ⇒ 顺着边缘往下挪一点
 *   就被判「移出格子」，条当场收 —— 用户报的「移过去显示后立马消失」；
 * - 事件挂在格子上还会漏：tooltip portal 到 body，指针压到它上面时事件不经过那棵树 ⇒ 「移几次才出得来」。
 * 按**坐标**判还有一条好处：tooltip 浮在画面上时坐标仍在画面里 ⇒ 不会因为它被判成"出界"。
 */
const CHROME_ENTER = { x: MIRROR_RAIL.fullscreenWidth, y: MIRROR_TITLEBAR.revealHeight }
const CHROME_EXIT = {
  x: MIRROR_RAIL.fullscreenWidth + 120,
  y: MIRROR_TITLEBAR.revealHeight + 120,
}
function onScreenPointerMove(event) {
  // 窗口态：触发区是那条胶囊的命中区，由它自己的 `pointerenter` / `pointerleave` 接（见模板）。
  if (!fullscreen.value) return
  const zone = chromeZone(event, window.innerWidth, window.innerHeight, CHROME_ENTER, CHROME_EXIT)
  if (zone === 'enter') reveal.poke()
  else if (zone === 'leave') reveal.leave()
}
/**
 * `relatedTarget = null` 的 `pointerout` 有**两种**来源，必须分开判：
 * ① 指针**真的离开窗口**（手一快就滑出去了，之后不会再有任何 `pointermove` ⇒ 这里不补一次收线，
 *    条就永远挂着）；
 * ② 指针**踏进 `-webkit-app-region: drag` 那一片**（Chromium 根本不往 DOM 发事件，进来这一下只发一条
 *    pointerout，坐标就是新位置）。
 *
 * ⚠️ **2026-10-16 起这条只服务满屏那两档**：窗口态的显隐完全由那两块 DOM 的
 * `pointerenter` / `pointerleave` 说话（见 `onScreenPointerMove` 上面那段）。
 * 窗口态走到这里是"指针离开了窗口"那一档（`relatedTarget = null`），照旧 `leave` 收线。
 * 满屏那两档仍按老规矩：落在 `MIRROR_TITLEBAR.floatDragHeight` 那一条里就当他"还在 chrome 上"
 * （poke，否则鼠标停在拖窗区上 1 秒后条自己收了），其余位置照旧走 `leave`（延 1 秒收）。
 * ⚠️ 这个界读的是**浮动态**那条的高度（满屏那一档的顶条是 `MIRROR_TITLEBAR.height`），
 * 数值变动会连带挪一点满屏那档的判定带 —— 无害（都是"顶上那一条算 chrome"），先记在这里。
 */
function onScreenPointerOut(event) {
  if (event.relatedTarget) return
  if (fullscreen.value && event.clientY <= MIRROR_TITLEBAR.floatDragHeight) {
    reveal.poke()
    return
  }
  reveal.leave()
}
const railShown = ref(false)
/**
 * 长条**常驻**（2026-10-11，用户：「侧边悬浮按钮栏加一个始终显示悬浮的按钮」）。
 * 真状态在状态机里（`setPinned`），这里只镜像一份给模板绑 `is-active` —— 与 `railShown` 同一套写法。
 *
 * ⚠️ **不持久化**：它是窗口级的一次性开关（与 `railShown` 同类）。要跨会话记住就得进 `prefs`
 * —— 那个口子连着 `shared/scrcpyConfig.js` 与设置界面，用户没要，先不动。
 */
const railPinned = ref(false)
/**
 * 三颗彩虹键什么时候放出来（系统画的，CSS 盖不住，只能请主进程开关）：
 * **跟着长条走** —— 长条显形它们才在，长条收了它们也收（用户 2026-10-17：
 * 「3个彩虹按钮没有跟着右边悬浮栏显示隐藏」）。
 *
 * 历史（别照着旧记录找）：两档形态那会儿写的是「窗口态跟 chrome 显隐、浮动态**常驻**」，
 * 理由是"浮动态窗口里只剩画面，没有'浮在桌面上'这回事"—— 那是**我们自己推的**，不是他点的。
 * 2026-10-16 两档退场之后 `railFloating` 恒真 ⇒ 那句推导把它钉成了**永远显形**，
 * 于是长条收了三颗还在（他这一轮报的就是这个）。现在只有一条规矩：`railShown` 说放就放、说收就收。
 * ⚠️ **落点照旧跟形态走**（`mirrorTrafficLightPosition(railFloating)`），与显隐无关。
 *
 * ⚠️ **收要延 `MIRROR_RAIL.fadeOutMs`（260ms）**：面板是淡出的，而三颗是 AppKit 画的、**没有淡出可跟**
 * —— 立刻收会看到"条还在半透明、三颗已经啪地没了"（10-10 他就报过这个不协调）。这 260ms 里又显形就撤掉这次收。
 * ⚠️ **满屏那两屏一概不碰**：那三颗归系统收放（顶边才浮出），我们插手只会打架。
 */
/** 上一次真正报给主进程的显隐（窗口开出来时系统默认是**显形**，但这里按"收着"起步：第一拍就报一次收）。 */
let buttonsShown = false
/** 延后收三颗的计时器（`fadeOutMs`）。窗口关掉 / 进满屏都要撤掉。 */
let hideButtonsTimer = 0
function syncWindowButtons() {
  window.clearTimeout(hideButtonsTimer)
  hideButtonsTimer = 0
  if (fullscreen.value) return
  if (railShown.value) {
    // 放出来：**跟手**，不等淡入跑完（面板正在淡入，三颗早到一拍没有违和感）。
    buttonsShown = true
    setWindowButtons(true, railFloating.value)
    return
  }
  if (!buttonsShown) {
    // 本来就收着（开窗第一拍）：没有"面板正在淡出"这回事，直接报 —— 否则三颗会先闪 260ms。
    setWindowButtons(false, railFloating.value)
    return
  }
  hideButtonsTimer = window.setTimeout(() => {
    hideButtonsTimer = 0
    buttonsShown = false
    setWindowButtons(false, railFloating.value)
  }, MIRROR_RAIL.fadeOutMs)
}
const reveal = createChromeReveal({
  onShow: (shown) => {
    railShown.value = shown
    syncWindowButtons()
    if (shown) {
      // 他把鼠标移进来就是要看那颗「关屏 / 恢复亮屏」，此刻读一次真状态最划算（顺带快轮询一阵）。
      kickSleepWatch()
    }
  },
})
/**
 * **浮动态顶边那条：拖窗由我们自己实现**（用户 2026-10-17 第八条：「鼠标移动到头部可拖拽的地方
 * 就展示出来 3 个彩虹按钮和悬浮栏」）。
 *
 * 为什么不用 `-webkit-app-region: drag`：那一整片是 Chromium 的**事件黑洞** —— 指针进去一个事件
 * 都不发（2026-10-17 真光标探针实测，三档都试过）：
 * - 进顶边：只发**一条** `pointerout`（`relatedTarget = null`），之后连 `pointermove` 都没有；
 * - 从顶边**滑出窗口**：一个事件都没有（`pointerout` 也没有）⇒ 想靠它做"指针还在不在头上"的判据
 *   会留一个**永久卡住**的状态（探针台实测）。
 * 而这一轮要的是"同一条带既收 hover 又能拖" ⇒ 二选一：留 drag 就收不到 hover。
 * 于是改成渲染层自己拖：`no-drag` 的命中层压在原来那条上（顶层元素的 `app-region` 说了算，
 * 探针实测事件照常送到 DOM），拖动时 `window.moveTo()`。
 *
 * 实测（探针台：真光标 + `win.getBounds()`，窗口参数照抄 `createMirrorWindow`）：
 * - `window.moveTo` 在 Electron 44 里**生效**，位移逐像素一致（(200,200) → (300,340)，拖的是 +100/+140）；
 * - 拖拽期间 client 坐标恒定 ⇒ **跟手**；连续第二次拖不跳（`window.screenX/Y` 与真实 bounds 同步）；
 * - `titleBarStyle: 'hiddenInset'` + `transparent` + `setAspectRatio` 这三样都不影响它。
 *
 * ⚠️ 代价（记在 `docs/TODO.md` §3）：系统给 drag 区的附加行为没了 —— **双击顶边缩放**、
 * 把窗口拖到别的显示器/空间。自己 `moveTo` 只有位移。
 * ⚠️ 三颗彩虹键那一片**只吃掉"按下"**（AppKit 的 NSButton 处理 mouseDown），**移动事件照常进 DOM**
 * （探针台实测 2026-10-17：指针滑到三颗上时 `pointermove` 照发、`pointerleave` 不触发）⇒
 * `floatLightY === floatDragHeight` 那条让位等式**不再是必须的**：2026-10-17 第十一条起三颗压进
 * 这条里 10px，hover 不受影响，只有灯本身那一小块按下是点灯（取舍见 `options.js` 的 `floatDragHeight`）。
 * ⚠️ 胶囊那一格（右上角）在命中层之上，按下去拖的是**胶囊**不是窗口（见 `onRailDragDown`）——
 * 与换实现之前一样（那时那一格是 `no-drag`，本来也不归拖窗区）。
 */
/** 一次顶边拖窗的现场：按下时指针相对**窗口左上角**的偏移（拖起来之后拿它反算窗口该挪到哪）。 */
let floatDrag = null
function onFloatDragDown(event) {
  if (event.button !== 0) return
  floatDrag = {
    pointerId: event.pointerId,
    offsetX: event.screenX - window.screenX,
    offsetY: event.screenY - window.screenY,
  }
  // 捕获：指针滑出窗口也继续跟手（自己拖窗没有系统那套 modal drag loop）。
  // 这一条上没有可点的东西，所以在 `pointerdown` 里捕获是安全的（胶囊那条不能这么干，见 `onRailDragMove`）。
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // 捕获不上也能拖（只是滑出窗口就脱手），不因此吞掉这次拖拽
  }
}
function onFloatDragMove(event) {
  if (!floatDrag || event.pointerId !== floatDrag.pointerId) return
  // 绝对定位（不是"累加位移"）：窗口跟不跟得上都不会漂，松手前后落点都准。
  window.moveTo(event.screenX - floatDrag.offsetX, event.screenY - floatDrag.offsetY)
}
function onFloatDragUp(event) {
  if (floatDrag && event.pointerId === floatDrag.pointerId) floatDrag = null
}
/**
 * 长条上那颗「一直显示」按钮。常驻交给状态机（`setPinned`），这里只镜像一份给模板。
 *
 * ⚠️ 取消常驻要**看指针在哪**：状态机解除"不许收"之后并不会自己排收回计时（鼠标真在条上时，
 * 下一次 `pointermove` 会 poke 回来）。但键盘触发（焦点在按钮上按回车）时指针可能压根不在条上
 * —— 那条路径上**不会再有 `pointermove`**，不补这一下条就一直挂着。
 * `matches(':hover')` 是这里唯一能同步问到"指针在不在这个元素上"的办法。
 */
/**
 * 长条的**纵向落点**（可拖，用户 10-11：「加个可以拖拽功能」）。
 *
 * 只给纵向，横向永远钉在窗口右边缘那一格：窄画面那档它在**画面外面**（10-10 定稿「任何 UI 都不
 * 要在手机里出现」），浮起来那一档与满屏态则浮在画面右上；允许横向拖就等于把条摆到画面中间盖内容。
 * 位移用 `translate` 表达 —— 它不吃布局，画面那块矩形一寸不动，不会白发一条 `resizeDisplay`
 * 让手机重排（判据与夹取见 `railDock.js`）。
 *
 * **初值分两档**：窗口态贴顶（0）—— 那一档面板与手机同高、整格占满，压根没有可落区间；
 * **浮动态是上下居中**（用户 2026-10-14 第二条：「右侧悬浮操作栏上下居中」）⇒ 由 `railAnchorTop`
 * 在"进浮动态"与"窗口改大小"两拍写进来，之后用户照样能拖。
 */
const railTop = ref(0)
const railPanel = ref(null)
/** 一次拖拽的现场：按下点的 y、当时的落点、面板高（拖拽期间不变）。 */
let railDrag = null
function onRailHandleDown(event) {
  const panel = railPanel.value
  if (!panel) return
  // 先记现场再谈捕获：`setPointerCapture` 对某些来源的事件会抛（指针 id 不在当前文档的活跃指针表里），
  // 放在前面一抛就把这次拖拽整个吞掉 —— 表现是"按住把手拖不动"。
  railDrag = { pointerId: event.pointerId, fromY: event.clientY, top: railTop.value, panelHeight: panel.offsetHeight }
  event.preventDefault()
  try {
    // 捕获：鼠标滑出把手那一格也继续跟手，不会拖到一半脱手。
    event.target.setPointerCapture?.(event.pointerId)
  } catch {
    // 捕获不上也能拖，只是滑出把手就得靠下面的 move 继续跟
  }
}
function onRailHandleMove(event) {
  if (!railDrag || event.pointerId !== railDrag.pointerId) return
  railTop.value = clampRailTop(railDrag.top + (event.clientY - railDrag.fromY), railDrag.panelHeight, window.innerHeight)
}
function onRailHandleUp(event) {
  if (railDrag && event.pointerId === railDrag.pointerId) railDrag = null
}
/**
 * 窗口改大小 / 进全屏后重排面板落点。两件事：
 * ① 面板可能比窗口还高 ⇒ 夹回可落区间，别把条丢到抓不回来的地方；
 * ② **浮动态的锚点就是"上下居中"**（`railAnchorTop`）—— 窗口一变中线就变，得跟着重锚。
 *    ⚠️ 代价说清：用户拖出来的位移在这一拍作废。这是"上下居中"这条要求的直接结果（它是**锚点**
 *    不是约束，只在进浮动态与改窗口大小这两拍写），换来的是浮动态永远居中、拖拽只在窗口尺寸不变时生效。
 */
function syncRailDock() {
  const panel = railPanel.value
  if (!panel) return
  const height = panel.offsetHeight
  railTop.value = railFloating.value
    ? railAnchorTop(height, window.innerHeight)
    : clampRailTop(railTop.value, height, window.innerHeight)
  // 窗口态那条胶囊被拖过之后也要跟着重夹：窗口变小 / 被拖窄时它可能已经落在窗口外面。
  if (railPos.value) {
    railPos.value = clampRailPos(
      railPos.value,
      { width: panel.offsetWidth, height },
      { width: window.innerWidth, height: window.innerHeight },
      0,
    )
  }
}

/**
 * **窗口态那条胶囊的落点**（用户 2026-10-16：「右侧操作栏可拖动」）。
 *
 * `null` = 没拖过 ⇒ 用默认位置：贴画面右上、与三颗彩虹键中线对齐（几何在 `options.js` 的
 * `mirrorRailTop()` 与 `MIRROR_RAIL.right`，CSS 用 `inset: 0 0 auto auto` 表达）。
 * **拖起来之后**变成 `{ x, y }` = 胶囊**左上角**在窗口内容区里的坐标，CSS 换成 `left/top + translate`
 * 那一套（见样式里 `.is-moved` 那组）。
 *
 * ⚠️ 写进去的时机是**真的拖起来那一刻**（位移过 `RAIL_DRAG_THRESHOLD`），不是按下：胶囊里几乎全是
 * 按钮，按在按钮上那一下得原样留给按钮（按下就切定位会让它白闪一下）。写的是**按下时量到的矩形**
 * ⇒ 与默认位置逐像素相同，切过去不跳。
 * ⚠️ 拖动**不改窗口尺寸、也不改画面矩形**（胶囊浮在画面上、不占布局）⇒ 不会白发一条 `resizeDisplay`。
 * ⚠️ 不持久化（与 `railPinned` 同类）：换一扇窗口 / 重开应用回到默认位置。要跨会话记住得动 `prefs`。
 */
const railPos = ref(null)
/** 一次胶囊拖拽的现场：按下点、按下时的落点、胶囊尺寸（拖拽期间不变）、有没有真的动过。 */
let railMove = null
/**
 * 拖过之后要吃掉紧随的那一下 `click`。
 * 没有它，在按钮上按住拖一把、松手时会顺手把那个按钮按一下（拖过"返回"键就是返回一次）。
 */
let railClickGuard = false
/**
 * 一次拖拽期间挂在 **`window`** 上的两个监听（不是挂在面板上）。
 * ⚠️ 理由：按下之后指针可能**立刻滑出胶囊**（胶囊只有 3px 边距 + 2px 缝是空白），挂在面板上就再也
 * 收不到 `pointermove` ⇒ 「按住往外拖」当场哑掉、阈值永远迈不过去。挂 `window` 则只要指针还在窗口
 * 里就一直跟手；挪过阈值后再补一条 `setPointerCapture`，连拖出窗口也继续跟。
 * ⚠️ 摘下必须成对（`onBeforeUnmount` 里也摘一次），别留悬空监听。
 */
function attachRailDragWatch() {
  window.addEventListener('pointermove', onRailDragMove)
  window.addEventListener('pointerup', onRailDragUp)
  window.addEventListener('pointercancel', onRailDragUp)
}
function detachRailDragWatch() {
  window.removeEventListener('pointermove', onRailDragMove)
  window.removeEventListener('pointerup', onRailDragUp)
  window.removeEventListener('pointercancel', onRailDragUp)
}
function onRailDragDown(event) {
  // 满屏那两档不归这条路（它们的长条贴窗口右缘、纵向拖拽走把手），可拖的只有窗口态那条胶囊。
  if (fullscreen.value || !railFloating.value) return
  if (event.button !== 0) return
  // 把手自己那套纵向拖拽在隔壁（窗口态不画把手，这条是给满屏那两档留的）。
  if (event.target?.closest?.('.mirror-rail__handle')) return
  const panel = railPanel.value
  if (!panel) return
  const rect = panel.getBoundingClientRect()
  railMove = {
    pointerId: event.pointerId,
    fromX: event.clientX,
    fromY: event.clientY,
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    moved: false,
  }
  // ⚠️ **按下这一拍不写 `railPos`、不 `preventDefault`、也不 `setPointerCapture`** ——
  // 前两条：按在按钮上那一下得原样留给按钮（写了定位会当场把胶囊切成 `left/top` 那套，白闪一下）。
  // 第三条是 2026-10-16 真机报回来的 bug（见下面 move 里那段），这一拍捕获 = 按钮全点不动。
  attachRailDragWatch()
}
function onRailDragMove(event) {
  if (!railMove || event.pointerId !== railMove.pointerId) return
  const dx = event.clientX - railMove.fromX
  const dy = event.clientY - railMove.fromY
  if (!railMove.moved) {
    // 还没到阈值：既不算点、也不算拖，什么都别做（手抖不该把条挪走）。
    if (Math.hypot(dx, dy) < RAIL_DRAG_THRESHOLD) return
    railMove.moved = true
    // 真的拖起来了才切定位，写的是**按下那一刻量到的矩形** ⇒ 与默认位置逐像素相同，不会跳。
    railPos.value = { x: railMove.x, y: railMove.y }
    // ⚠️ **捕获只能在"真的拖起来"这一拍要，绝不能放在 `pointerdown` 里**（2026-10-16 用户报
    // 「悬浮的操作栏按钮不能点了」的根因，最小复现台实测）：
    // Chromium 里 `setPointerCapture` 会把**兼容鼠标事件一起重定向**到捕获元素 ⇒ 在 `pointerdown`
    // 里捕获时，`mousedown` / `mouseup` 都落在面板上，`click` 于是派发到「两者的最近公共祖先」
    // = 面板本身，**按钮一个都收不到**（实测 `clickBtn: []` / `clickPanel: 1`）。
    // 改成挪过阈值才捕获：点 = 点（不捕获，`click` 照常落在按钮上）、拖 = 拖（捕获住、滑出窗口也跟手）。
    // ⚠️ 上一轮"验过按钮还能点"是**假绿**：那次用 `dispatchEvent(new PointerEvent(...))` 合成事件，
    // 指针 id 不在活跃表里 ⇒ `setPointerCapture` 直接抛、走 `catch`，真实鼠标那条路根本没跑到。
    // ⚠️ 捕获之后 `pointermove` 仍会从面板冒泡到 `window` ⇒ 上面那对 window 监听照收，不会打架。
    try {
      railPanel.value?.setPointerCapture?.(event.pointerId)
    } catch {
      // 捕获不上也能拖（window 那对监听兜着），只是拖出窗口外会脱手
    }
  }
  // `pad = 0`：胶囊不许露到窗口外面 —— 它浮在画面上，露出去那截会被窗口裁掉（半个按钮看不见）。
  railPos.value = clampRailPos(
    { x: railMove.x + dx, y: railMove.y + dy },
    { width: railMove.width, height: railMove.height },
    { width: window.innerWidth, height: window.innerHeight },
    0,
  )
}
function onRailDragUp(event) {
  if (!railMove || event.pointerId !== railMove.pointerId) return
  detachRailDragWatch()
  if (railMove.moved) {
    // `click` 紧跟 `pointerup` 派发 ⇒ 下一拍再放开这个闸。
    // ⚠️ 捕获成功时 `click` 本来就会落到面板上（按钮收不到），这条闸是**兜底**：捕获失败 /
    // 指针在按下与捕获之间换了目标那几条路，仍然可能把 `click` 派回按钮上。
    railClickGuard = true
    setTimeout(() => {
      railClickGuard = false
    }, 0)
  }
  railMove = null
}
/** 拖完那一下的 `click` 不许落到按钮上（挂在面板的**捕获**阶段，比按钮先看到）。 */
function onRailClickCapture(event) {
  if (!railClickGuard) return
  event.stopPropagation()
  event.preventDefault()
}
/** 双击胶囊回到默认位置（拖到哪都能收回来；按在按钮上时不算，那是双击那个按钮）。 */
function onRailReset(event) {
  if (event.target?.closest?.('button, .mirror-rail__handle')) return
  railPos.value = null
}

const railSlot = ref(null)
function toggleRailPinned() {
  const next = !railPinned.value
  railPinned.value = next
  reveal.setPinned(next)
  // ⚠️ 「指针在不在条上」要问**面板**：长条浮在画面里时格子与面板都是 `pointer-events: none`
  // （否则画面右缘那 86px 的点按全被它吃掉，见 CSS 那一组），问格子会回 false ⇒ 刚取消常驻就排一个
  // 收回计时，鼠标明明还压在条上却被收走。
  // 面板自己不吃事件、**里面的按键吃**（`pointer-events: auto`）⇒ `:hover` 会顺着命中目标往上传到面板，
  // `matches(':hover')` 照样为真（点这颗按钮时指针必然在某颗按钮上）。
  const hovered = railPanel.value?.matches?.(':hover') || railSlot.value?.matches?.(':hover')
  if (!next && !hovered) reveal.leave()
}

/**
 * 右侧那条操作栏现在是不是**浮在画面里**（用户 2026-10-14：「如果手机投屏宽度足够宽，那就把手机
 * 投屏右侧的操作栏更改为全屏时在投屏里浮动的样子」）。
 *
 * ⚠️ **2026-10-16 起这个判据恒为 `true`**（`mirrorRailFloats` 恒真）：长条从"画面右边那一条
 * （占窗口宽，画面够宽才浮起来）"整个换成"浮在画面顶部右侧的小胶囊"，两档形态的分化随之退场。
 *
 * 状态与下面那条 `watch` 都**保留**：模板与样式还按它挂 `is-rail-float` 那一组（现在恒挂），
 * 三颗彩虹键的落点也要靠它报给主进程（`syncWindowButtons`）。删它要一起动 IPC 链路 ——
 * 这一轮只改外观，没动。
 */
const railFloating = ref(false)
const mirrorMain = ref(null)
let mainResize = null
function syncRailFloating() {
  const main = mirrorMain.value
  if (!main) return
  const next = mirrorRailFloats(main.clientWidth, railFloating.value)
  if (next === railFloating.value) return
  railFloating.value = next
  setRailFloating(next)
}
/**
 * 形态翻转要一起改的两件事，都排在 **DOM 更新之后**（`flush: 'post'`）。
 *
 * ⚠️ 2026-10-16 起判据恒真 ⇒ 这条 watch 只会在**第一拍**跑一次（`false → true`）。留着是因为
 * 满屏那两档仍要 `railTop`（它们的长条可以上下拖），而 `syncWindowButtons` 每次都得把三颗的落点
 * 报给主进程。窗口态的胶囊钉在顶部右侧，那份 `railTop` 被 CSS 的 `translate: none` 压掉。
 */
watch(railFloating, (floating) => {
  const panel = railPanel.value
  railTop.value = floating ? railAnchorTop(panel?.offsetHeight ?? 0, window.innerHeight) : 0
  syncWindowButtons()
}, { flush: 'post' })
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
 *
 * ⚠️ **2026-10-16 收小一档**（用户：「提醒小一点」）：内边距 `3.5/2 → 2.5/1.5`、字号 `12 → 11`、
 * 阴影跟着收。原来的尺寸是照参照图做的，挂在按钮上比按钮本身还大一圈。
 */
const TIP_CLASS =
  'z-50 whitespace-nowrap rounded-full border border-black/10 bg-white px-2.5 py-1.5 text-[11px] font-medium text-black/75 shadow-[0_6px_18px_rgba(0,0,0,0.16),0_1px_2px_rgba(0,0,0,0.08)]'
/**
 * 气泡往哪边展开 + 离按键多远。
 * - **窗口态**（胶囊浮在画面顶部）：`bottom` / 8 —— 从胶囊**下边**出来（用户 2026-10-16：
 *   「…提醒小一点，从下边展示」）。胶囊本来就贴着画面顶边，气泡摆在它上面会顶出窗口。
 * - **满屏那两档**：`left` / 12 —— 长条是贴窗口右缘的纵向一列，往左边展开（用户 10-10 点名）；
 *   改成从下边出来会盖住它自己下面那几颗按钮。
 */
const railTipSide = computed(() => (fullscreen.value ? 'left' : 'bottom'))
const railTipOffset = computed(() => (fullscreen.value ? 12 : 8))
/**
 * 设备的两条电源读数（`wakefulness` = `mWakefulness` 睡没睡，`screen` = SurfaceFlinger 的 `powerMode` 面板亮没亮），
 * 由 `sleepWatch` 轮询 + 我们点按钮时 `kickSleepWatch()` 快轮询喂进来。
 * **页面上所有跟屏有关的状态都从这一条派生**，不再各记各的：
 * - 「已休眠」横幅 = 冻结态（`Asleep`/`Dozing`，画面不再出新帧）；`Hangup` 不算（还在合成，弹了是谎报）。
 * - 长条那颗「关屏使用 / 恢复亮屏」= `panelIsOff(powerState)`（面板读数不是 `ON`，读不到时退回睡没睡）。
 * 醒回来后轮询自己会把横幅撤掉（`onSleepChange(false, state)`）。
 */
const powerState = ref({ wakefulness: 'Awake', screen: 'ON' })
/**
 * 「已休眠」横幅 —— **只给采主屏那一档**。这一档采的是手机那块屏，面板灭了就没帧可采
 * （HyperOS 息屏停止合成，见 `electron/mirror/miProjection.js`），所以必须提示并给「继续使用」。
 *
 * ⚠️ 桌面模式 / 点应用那档**不弹**：那块虚拟显示是我们建的，真机实测（Android 17，
 * `mWakefulness=Dozing`、主屏 `powerMode=Off`）下它 `powerMode=On`、静置 6s 仍出 55 帧、
 * 注入一次点按后 6s 内又 +11 帧 ⇒ 画面是活的。在那一屏中间摆一块「已休眠」是假警报，
 * 还会引导人去点「继续使用」把手机真唤醒。判据哪天若不成立了，要改成按**帧停滞**判，不是按电源读数判。
 */
const asleep = computed(() => FROZEN_STATES.has(powerState.value.wakefulness) && !virtualDisplay.value)
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
/**
 * 同一个比例的**数值**写法（`宽 / 高`），给全屏那一档算 `min()` 用 ——
 * `aspect-ratio` 吃的是比例表达式，而 `calc(可用高 × 比例)` 必须是数，两者不能共用一个变量。
 * 首帧之前取 1（正方形，反正那时没有画面），`syncCanvasBox()` 量到真实尺寸那一拍覆盖掉。
 */
const screenRatioN = ref(1)
/** CSS 变量：黑框厚度与长条那两档数只有一个出处（`options.js`）。 */
const windowStyle = computed(() => ({
  '--bezel': `${MIRROR_FRAME.bezel}px`,
  /* 画面那块矩形的圆角半径：**出处是 `options.js`**（三颗的落点由它推出来，见
     `mirrorTrafficLightPosition`）。CSS 里不再写死这个数。 */
  '--radius': `${MIRROR_SCREEN_RADIUS}px`,
  /* ⚠️ **满屏那一档**长条占的那一格宽（真全屏是「画面一格 + 长条一格」两格排法）。
     窗口态不再用它 —— 那条胶囊浮在画面上、不占布局，宽度由内容撑开。 */
  '--rail-w': `${MIRROR_RAIL.fullscreenWidth}px`,
  /* 窗口态那条**顶部胶囊**的几何（浮在画面上，不进任何布局计算）。 */
  '--rail-capsule-top': `${mirrorRailTop()}px`,
  '--rail-capsule-right': `${MIRROR_RAIL.right}px`,
  '--rail-capsule-height': `${MIRROR_RAIL.height}px`,
  '--rail-hit-pad': `${MIRROR_RAIL.hitPad}px`,
  /* 胶囊被拖过之后的落点（`null` = 没拖过 ⇒ 用上面那两个默认值，CSS 走 `inset: 0 0 auto auto`）。
     ⚠️ 只在根节点带 `is-rail-moved` 时才被读到（见样式里那组），平时这两个变量是死值。 */
  '--rail-x': `${railPos.value?.x ?? 0}px`,
  '--rail-y': `${railPos.value?.y ?? 0}px`,
  '--rail-fade-in': `${MIRROR_RAIL.fadeInMs}ms`,
  '--rail-fade-out': `${MIRROR_RAIL.fadeOutMs}ms`,
  '--titlebar-height': `${MIRROR_TITLEBAR.height}px`,
  '--titlebar-reveal-height': `${MIRROR_TITLEBAR.revealHeight}px`,
  '--titlebar-name-x': `${mirrorTitlebarNameLeft()}px`,
  /* 窗口态没有标题栏 ⇒ 拖窗区改成窗口顶边**整条**看不见的条（见模板里 `.mirror-float-drag`）。 */
  '--float-drag-height': `${MIRROR_TITLEBAR.floatDragHeight}px`,
  '--screen-ratio': screenRatio.value,
  '--screen-ratio-n': String(screenRatioN.value),
  /* 满屏那档长条的纵向拖拽位移（窗口态用不上：胶囊钉在顶部右侧）。 */
  '--rail-top': `${railTop.value}px`,
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

const title = computed(() => windowTitle.value || meta.value?.label || meta.value?.packageName || '镜像')

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
    screenRatioN.value = frameRatio
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
        // 满屏那两屏三颗归系统收放（`syncWindowButtons` 在那一档直接返回）；**出满屏要补一次对账**
        // —— 系统把三颗收走之后，得按"回到哪一档"重新决定放不放（窗口态 = 跟着长条，长条没收就放）。
        syncWindowButtons()
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
    // 这一档是不是**我们自己建的那块 flex 显示**（桌面模式 / 首页点应用）：只有它有形状可改，
    // 采主屏那档（整机镜像、13 及以下点应用）形状归手机，全屏只能收着（见 `edgeToEdge`）。
    virtualDisplay.value = getSessionInfo()?.deviceMirror === false
    windowTitle.value = getSessionInfo()?.windowTitle || ''
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
  // 长条浮没浮（画面够宽就换成浮在画面里那套）：量的是**画面区那一格**（`.mirror-main`）——
  // 它不随长条摆在哪而变，所以这条判据不会被自己的结果推着走（量画面本身就会，见 `syncRailFloating`）。
  mainResize = new ResizeObserver(() => syncRailFloating())
  if (mirrorMain.value) mainResize.observe(mirrorMain.value)
  // 退格只走按键那条路（`kind:'key'`），收字字段的 `input` 事件里 `data` 是 null，翻不成文本 ——
  // 所以光标账要在这里跟着记，不然退几个字之后候选窗就停在原地了。
  window.addEventListener('keydown', onMacTextKeyDown)
  // 满屏那一档的长条触发（挂在 window 上，理由见 `onScreenPointerMove`）。
  window.addEventListener('pointermove', onScreenPointerMove, { passive: true })
  window.addEventListener('pointerout', onScreenPointerOut, { passive: true })
  window.addEventListener('resize', syncRailDock)
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
  // 延后收三颗那一拍还没到就关窗了：撤掉，别让它对着一扇已经没了的窗口发 IPC。
  window.clearTimeout(hideButtonsTimer)
  hideButtonsTimer = 0
  // 顶边拖到一半窗口就关了：把现场丢掉（指针捕获随元素一起没，`moveTo` 不会再被调）。
  floatDrag = null
  hostResize?.disconnect()
  mainResize?.disconnect()
  window.removeEventListener('keydown', onMacTextKeyDown)
  window.removeEventListener('pointermove', onScreenPointerMove)
  window.removeEventListener('pointerout', onScreenPointerOut)
  window.removeEventListener('resize', syncRailDock)
  // 胶囊拖到一半窗口就关了：那对 window 监听得摘掉，别留给下一个（同进程里还有别的镜像窗）。
  detachRailDragWatch()
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
  <div class="h-full mirror-window text-white" :class="{ 'is-fullscreen': fullscreen, 'is-edge-to-edge': edgeToEdge, 'is-chrome': railShown, 'is-rail-float': railFloating, 'is-rail-moved': !!railPos }"
    :style="windowStyle">
    <!-- 画面区：dev 时右侧让出一条 HUD 边栏（`aside` 与它左右排），画面上的覆盖层（遮罩/接回/提示/
         长条）都只盖画面那一块，这样调试信息永远不被盖住，也不会压在镜像画面上。 -->
    <div class="mirror-body">
      <!-- 那层 chrome 涂装：**就这一个 div**（用户 2026-10-13「左上角右上角右下角和上边右边改成一个 div」）。
           它铺满整扇 `.mirror-body`、整块填浅灰，手机（`.mirror-main` 那一层）画在它**上面** ⇒
           手机轮廓自己把中间挖掉，剩下的正好是上臂 + 右臂 + 黑框三个圆角外侧那三块；
           左下角那块用 `clip-path` 挖掉（「左下角不要有边框」）。形状与取舍见样式里 `.mirror-chrome` 那段。
           放在第一个：DOM 顺序 + `z-index` 两条一起保证它压在最底下（只是一层涂装，不接指针）。 -->
      <div class="mirror-chrome" aria-hidden="true"></div>
      <!-- 顶部这一条：三颗彩虹键的地盘 + app 名称（用户 2026-10-12 点单）。
           名称是窗口拖拽区（取代以前画在画面顶上的那条 `.mirror-dragstrip`），但**最上面那 12px 不是** ——
           那是 chrome 的触发条（`__reveal`，见 `MIRROR_TITLEBAR.revealHeight` 那段：drag 区里 Chromium
           一个指针事件都不发，整条都拖 ⇒ "贴上边"永远收不到信号）。三颗是系统画的，落点由主进程按
           `MIRROR_TITLEBAR` 给，名称是我们自己画的、让开三颗。 -->
      <div class="mirror-titlebar">
        <span class="mirror-titlebar__name">{{ title }}</span>
        <div class="mirror-titlebar__reveal" aria-hidden="true"></div>
      </div>
      <div class="mirror-main" ref="mirrorMain">
      <!-- **头部那条**（高 `MIRROR_TITLEBAR.floatDragHeight`，整窗宽）：浮动态整条标题栏不存在
           ⇒ 拖窗区与 chrome 的显形触发区都归它。
           ⚠️ 第一版是左上角 80×28 的小方块（宽 = 三颗 + 名称原本占的那一截），被用户当场打回
           （「app 投屏后不能拖拽了」）：那块地方本来就盖着三颗彩虹键，而三颗是 AppKit 画在网页内容
           **之上**的 ⇒ 方块中间一大块根本抓不到。现在整条铺开、三颗的落点收进 `floatLightX/Y`。
           ⚠️ 2026-10-17 第十一条起三颗**压进这条里**（不再"让开"）：那条让位等式的理由只对了一半
           —— 三颗只吃"按下"、不吃"移动"（探针台实测）⇒ hover 照常，只有灯本身那一小块按下去是点灯。
           ⚠️ **`pointerenter/leave` 挂在这里**（用户 2026-10-17：「鼠标移动到头部可拖拽的地方就展示
           出来」）：进这一条就弹、离开就收。胶囊那一格另有自己的命中区（`.mirror-rail`，在它**上面**），
           所以"贴着胶囊上下挪"也不会被这条判成离开 —— 两边都 poke，谁先谁后都不影响结果。
           ⚠️ **拖窗也是这里自己做的**（`onFloatDragDown` 那一组）：这条**不是** `-webkit-app-region:
           drag`，理由见那组函数上面那段（drag 区一个指针事件都不发，收不到 hover）。 -->
      <div v-if="railFloating && !fullscreen" class="mirror-float-drag" aria-hidden="true"
        @pointerenter="reveal.poke()" @pointerleave="reveal.leave()" @pointerdown="onFloatDragDown"
        @pointermove="onFloatDragMove" @pointerup="onFloatDragUp" @pointercancel="onFloatDragUp"></div>
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
      </div>

      <!-- 长条的**格子**：手机右边外面那 74px，永远占着（画面那块矩形才不动）。
           它自己不画东西，只负责收 poke —— 鼠标一进这一格就弹，不用按坐标筛。
           poke 挂在格子上而不是面板上：面板收起时 `pointer-events: none`，显形时又盖住格子，
           挂格子上两种状态都由同一条 `pointermove`（冒泡上来）接住。 -->
      <!-- 操作条：**命中区 + 胶囊**两层。
           窗口态（唯一形态）它是浮在画面顶部右侧的一条玻璃胶囊（`.is-rail-float` 那一组样式），
           鼠标**移进头部那条或这一块**才淡入：进头部（`.mirror-float-drag`）弹出来是用户 2026-10-17
           点的「鼠标移动到头部可拖拽的地方就展示出来」；这里的命中区（= 胶囊 + 一圈外扩
           `MIRROR_RAIL.hitPad`）接着管"贴着胶囊上下挪"那一段 —— 它比头部那条高，指针压在胶囊上时
           仍算"还在 chrome 上"。它自己不接点按，只有显形的面板与按键接（见样式那两条）。
           两处触发都不走 window 的坐标判据：命中区正是 DOM 自己知道的那个矩形，按坐标另算只会两边漂。
           满屏那两档另有排法（真全屏占一格、桌面模式浮在右上），触发仍走坐标判（`onScreenPointerMove`），
           这里的 `pointerenter/leave` 对它们无害：那一档指针本来就在画面里。 -->
      <div class="mirror-rail" ref="railSlot" @pointerenter="reveal.poke()" @pointerleave="reveal.leave()">
        <!-- 面板：窗口态是**横向一条**（开关组 + 分隔线 + 导航组）；满屏那两档仍是纵向一列。
             红绿灯（那三颗彩虹键）归系统放左上角，不给它留一截。
             窗口态这条胶囊**可拖**（用户 2026-10-16：「右侧操作栏可拖动」）：**按住它挪过 4px** 就拖
             （按在按钮上不动仍是点那个按钮 —— 胶囊里几乎全是按钮，只认"抓空白处"等于没法拖），
             落点写进 `--rail-x/y`；双击空白处回默认位置。满屏那两档不进这条路。 -->
        <div ref="railPanel" class="mirror-rail__panel" :class="{ 'is-shown': railShown }"
          @pointerdown="onRailDragDown" @click.capture="onRailClickCapture" @dblclick="onRailReset">
          <!-- ⚠️ 拖动**不在这里挂 `pointermove/up`**：按下之后指针可能立刻滑出胶囊（空白只有
               3px 边距 + 2px 缝），挂面板上就收不到 move、"按住往外拖"当场哑掉。那两条按需挂到
               `window` 上（`attachRailDragWatch`），松手/取消时摘下。`pointerdown` 只记现场，
               **不捕获**（捕获会让按钮点不动，见 `onRailDragMove` 里那段）。 -->
          <!-- 拖拽把手：**只有满屏那档画**（窗口态的胶囊钉在顶部右侧，纵向没有可落区间 —— 画个把手
               就是骗人抓的假开关）。按住走 pointer capture ⇒ 鼠标滑出把手也继续跟，不会拖到一半脱手。 -->
          <div class="mirror-rail__handle" aria-label="上下拖动这条" role="separator"
            @pointerdown="onRailHandleDown" @pointermove="onRailHandleMove" @pointerup="onRailHandleUp"
            @pointercancel="onRailHandleUp"></div>
          <!-- 按键说明：reka-ui 的 Tooltip（与主窗口 `PageHeader.vue` 同一套写法）。
               `delay-duration=0` = 一移上就出；气泡往哪边展开看 `railTipSide`（窗口态从**下边**出、
               满屏那两档仍往左边，理由见那个 computed 上面那段）。
               所以按钮上**不再挂 `title`** —— 两个都留着会同时弹系统气泡和这个气泡。
               Provider 是纯上下文组件，不产生元素，长条的 flex 排布不受影响。

               ⚠️ **`disable-hoverable-content` 是必须的**（2026-10-17 用户：「胶囊也跟着右侧悬浮栏隐藏」）。
               默认（false）时 reka 走 `TooltipContentHoverable`：它用 `useGraceArea` 把**气泡自己的矩形**
               一起算进"过渡区"，指针落在气泡上就算"还没离开"，气泡一直不收。
               而气泡是 portal 到 `body` 的、落在**命中区之外**（真机读数：胶囊 `[237,5,159,28]`、
               命中区 `[229,0,179,41]`、气泡 `[186,38,132,31]`）⇒ 鼠标从按钮**往下滑到气泡上**这一下
               同时做了两件事：离开命中区（长条开始淡出）+ 落在气泡里（气泡把自己钉住）。
               实测：长条 `opacity` 已到 0，气泡仍 `opacity: 1 / display: block` 挂在画面上。
               打开这一位后 reka 改走 `TooltipContentImpl`（没有过渡区），
               `TooltipRoot.onTriggerLeave()` 直接 `handleClose()` ⇒ 指针一离开按钮气泡就收，
               结构上不可能比长条活得久。气泡里只有一行纯文字、本来也不需要悬停交互。 -->
          <TooltipProvider :delay-duration="0" disable-hoverable-content>
            <!-- 关屏使用：按键区的第一格（用户 10-10 点名放最上）。
                 按下去关手机屏，再点一次恢复亮屏。
                 ⚠️ 图标与高亮画的是**现在的状态**（亮着 = 正常显示器；灭着 = 带斜杠那台 + `is-active`），
                 不是"点下去会发生什么" —— 上一版反着标，他报「明明是亮着屏幕，息屏图标却展示息屏」。 -->
            <TooltipRoot>
              <TooltipTrigger as-child>
                <button type="button" class="mirror-rail__key" :class="{ 'is-active': screenIsOff }"
                  :disabled="screenBusy" :aria-label="screenIsOff ? '恢复亮屏' : '关屏使用'" :aria-pressed="screenIsOff"
                  @click="toggleScreenPower">
                  <Icon :icon="screenIsOff ? 'lucide:monitor-off' : 'lucide:monitor'" :width="16" :height="16" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent :side="railTipSide" :side-offset="railTipOffset" :class="TIP_CLASS">{{
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
                  <Icon icon="lucide:app-window" :width="16" :height="16" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent :side="railTipSide" :side-offset="railTipOffset" :class="TIP_CLASS">把手机上正在用的应用移进独立窗口</TooltipContent>
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
                  <Icon icon="lucide:pin" :width="16" :height="16" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent :side="railTipSide" :side-offset="railTipOffset" :class="TIP_CLASS">{{
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
                  <Icon icon="lucide:keyboard" :width="16" :height="16" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent :side="railTipSide" :side-offset="railTipOffset" :class="TIP_CLASS">{{
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
                <TooltipContent :side="railTipSide" :side-offset="railTipOffset" :class="TIP_CLASS">调试信息（dev）</TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <!-- 安卓的返回 / 桌面 / 多任务：贴到长条**最底部**（用户 2026-10-10）。 -->
            <div class="mirror-rail__keys">
              <TooltipRoot v-for="key in RAIL_KEYS" :key="key.name">
                <TooltipTrigger as-child>
                  <button type="button" class="mirror-rail__key" :aria-label="key.label"
                    @click="pressRailKey(key.keyCode)">
                    <Icon :icon="key.icon" :width="16" :height="16" />
                  </button>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent :side="railTipSide" :side-offset="railTipOffset" :class="TIP_CLASS">{{ key.hint }}</TooltipContent>
                </TooltipPortal>
              </TooltipRoot>
            </div>
          </TooltipProvider>
        </div>
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
  /* 手机那块的两圈圆角：`--radius` 是屏自己那圈（**值来自 `windowStyle`，出处 `options.js` 的
     `MIRROR_SCREEN_RADIUS`** —— 浮动态三颗的落点由它推出来），`--frame-radius` 是黑框**外沿**那圈
     （多一圈边框厚度，两层才同心）。放在根上是因为窗口态补那三块楔形要用同一个数（见下面 `.mirror-main` 那组）。 */
  --frame-radius: calc(var(--radius) + var(--bezel));
}

/* 画面区：手机（黑框 + 画面）与右边那条长条左右排。生产中它占满整个视口；
   dev 时再让出右侧的 HUD 边栏（也是 flex 排的），所以覆盖层只盖画面、不盖调试信息。
   ⚠️ `position: relative; z-index: 1` 是**涂装那一层**（`.mirror-chrome`）需要的：涂装铺满整扇
   `.mirror-body`、压在手机**下面**，靠"手机盖住中间那块"来挖出形状（见 `.mirror-chrome`）。
   这里抬一层，手机与长条才会画在涂装之上；不给它 `position` 的话，绝对定位的涂装会盖住画面。 */
.mirror-main {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  /* 在 `.mirror-body` 那一竖列里，剩余高度才归画面；不留这条下限，窗口缩小时顶不动标题栏。 */
  min-height: 0;
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
  /* 黑框**外沿**那个圆的半径（= 圆角 + 边框宽）：`.mirror-screen` 的圆角 + 一圈边框厚度，两层才同心。
     提到 `.mirror-window` 这一层是因为窗口态补那三块楔形要用同一个数（见下面 `.mirror-main` 那组）。 */
  flex: 1;
  min-width: 0;
  border: var(--bezel) solid #0b0b0d;
  border-radius: var(--frame-radius);
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

/* 长条的**格子**：手机右边外面那 86px，永远占着布局（画面那块矩形才不因显隐而动）。
   窗口态它**自己就是那条 chrome 的右臂**（用户 2026-10-12「右侧操作栏和边框写在一起，不要分成 2 个叠在一起」）
   ⇒ 面板不再画成浮在上面的白胶囊，键直接落在这格上。
   ⚠️ 画面够宽那一档（`.is-rail-float`）这格**不再占位**、改成浮在画面上 —— 那 86px 归画面，
   由主进程按同一档内缩算窗口尺寸，见下面那一组。
   ⚠️ 底色**不在这里画**（10-13 第四稿）：那层浅灰现在整块归 `.mirror-chrome`（一个 div 画完上臂 + 右臂
   + 手机三个圆角外侧那三块），这里只管占位与收 poke。
   poke 挂在这一格上（见模板）—— 面板收起时它是命中层，显形时面板盖住它、move 冒泡上来还是它接住，
   两种状态同一条判据，不用按坐标筛。 */
.mirror-rail {
  flex: none;
  /* ⚠️ 这是**满屏那两档**的布局宽度（真全屏是「画面一格 + 长条一格」的两格排法）。
     窗口态那条胶囊浮在画面上、不占布局，由下面 `.is-rail-float` 那组把宽度改成 `max-content`
     —— 留着这个 86 会把命中区钉得比胶囊还窄。 */
  width: var(--rail-w);
  background-color: transparent;
}

/* 面板：**淡入淡出**，不滑（用户 2026-10-10：「不要从右侧往左展示，直接过渡展示出来就行」）。
   与手机同高（顶到窗口顶与底，10-10 又点「浮动条跟手机一个高度」）、贴窗口右边，只留左右各 6px。
   顶部不留白（红绿灯已归系统左上角，不再占这里的一截）。 */
.mirror-rail__panel {
  /* 面板宽度**从格子推导**：格子左右各留 6px ⇒ 面板在格子里居中，
     以后只改 `MIRROR_RAIL.fullscreenWidth` 一个数，面板与落点会一起跟着走。
     ⚠️ 这是**满屏那两档**用的那套（纵向一列、贴窗口右边）；窗口态是浮在画面上的横向玻璃胶囊，
     由下面 `.is-rail-float` 那一组整个覆盖掉。 */
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
     （以前红绿灯跟着一起藏，所以要算这个延后；现在它归系统，这里只剩面板自己。） */
  /* 拖出来的纵向落点（`--rail-top`，见 `railDock.js`）。translate 不吃布局 ⇒ 画面那块矩形不动。 */
  translate: 0 var(--rail-top, 0px);
  transition: opacity var(--rail-fade-out) ease-in;
}

/* 把手**只在满屏那一档画**（`.is-edge-to-edge` 下面那条）：满屏那档的长条贴窗口右缘、纵向可落，
   画一条灰杠暗示"这里能拖"。窗口态不画 —— 那条胶囊**整条都能抓**（用户 2026-10-16
   「右侧操作栏可拖动」），再画个把手只是骗人抓的假开关。
   把手：面板顶上那一小格。它不是按钮，不接 :hover 高亮。 */
.mirror-rail__handle {
  display: none;
  width: 34px;
  height: 14px;
  margin-top: 8px;
  cursor: grab;
  /* 触摸板上拖拽会被当成滚动手势吞掉，必须自己接管。 */
  touch-action: none;
}

.mirror-window.is-chrome:not(.is-fullscreen) .mirror-titlebar__name {
  opacity: 1;
}

.mirror-window.is-edge-to-edge .mirror-rail__handle {
  display: block;
}

.mirror-rail__handle::after {
  content: "";
  display: block;
  width: 22px;
  height: 3px;
  margin: 6px auto 0;
  border-radius: 2px;
  background: rgb(0 0 0 / 16%);
}

.mirror-rail__handle:active {
  cursor: grabbing;
}

.mirror-rail__panel.is-shown {
  opacity: 1;
  pointer-events: auto;
  transition: opacity var(--rail-fade-in) ease-out;
}

/* ⚠️ 这里原本有一条「窗口态：长条与右边那条边框是同一块 ⇒ 面板铺满整格、底色交给 `.mirror-chrome`」
   （用户 2026-10-12 定）—— **2026-10-16 随「右侧长条改成浮在画面顶部的小胶囊」一起删掉了**：
   那一档的窗口里不再有"右臂"那块地方，面板也不跟涂装走（玻璃胶囊是独立一件，见下面窗口态那一组）。
   满屏那两档从来不走这条（`:not(.is-fullscreen)`），它们照旧用上面 `.mirror-rail__panel` 的基础样式。 */

/* ── 窗口态（`.is-rail-float`，判据现在恒真 ⇒ **唯一的窗口形态**）────────────────────────────
   2026-10-16 用户这一轮把窗口整个改了：「镜像投屏的时候将黑色手机边框去掉，右侧悬浮更改为上方很小
   的悬浮，有一种透明玻璃质感」+「浮动到画面顶部右边，跟 mac 3 个彩虹按键对齐」
   +「鼠标移入到上边悬浮按钮区域才显示」（前几版「右侧一条长条」「画面够宽才浮起来」都已作废）。

   这一档现在只有四件事：
   ① **窗口里只剩画面**：黑框归零（`MIRROR_FRAME.bezel = 0`）、标题栏不画、右侧不再留那一格
      ⇒ 画面铺满 `.mirror-main`，`mirrorScreenInsets()` 因此恒为 0（主进程算窗口尺寸、比例锁余量与
      这里排的 DOM 必须是同一套数，否则圆角里露出 letterbox）。
   ② 三颗彩虹键落进**画面左上角**（落点 `mirrorTrafficLightPosition(true)`，让开画面那圈圆角；
      2026-10-16 晚些时候用户又点了「圆角稍微大点」（12 → 20）与「彩虹见靠左一点」（x 36 → 26）。
   ③ 操作条 = 浮在**画面顶部右侧**的一条横向**玻璃胶囊**，纵向与三颗**中线对齐**（`mirrorRailTop()`）。
   ④ 这条胶囊**可拖**（用户 2026-10-16：「右侧操作栏可拖动」）：默认贴右上，抓它的空白处能拖到
      窗口内任意位置（`--rail-x/y` + 下面 `.is-rail-moved` 那组），双击空白处回默认位置。
   ⑤ **头部那条**（`.mirror-float-drag`，整窗宽 × `floatDragHeight`）既收 hover（进它就弹 chrome，
      用户 2026-10-17）又自己拖窗（`onFloatDragDown` 那组；**不是** `-webkit-app-region: drag`，
      理由见那组函数上面那段）。

   ⚠️ 玻璃这条只有"浮在画面上"才成立：它背后必须有东西可模糊（投屏内容）。摆在画面外（窗口透明处）
   就只能退化成半透明白底 —— 这也是它不占布局的另一个理由（占位那条路第一版就试过）。
   ⚠️ 全部带 `:not(.is-fullscreen)`：满屏那两档有自己的排法（真全屏是「画面一格 + 长条一格」、
   桌面模式是纯画面 + 右上浮条），这一轮**没动它们**。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-main {
  /* 单格：画面铺满，胶囊浮在它上面。 */
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
}

/* 整条标题栏不存在（用户 2026-10-14：「上边头部就去掉……标题去掉」）：名称没了、触发带也没了
   （窗口态的触发改成"指针进头部那条 + 胶囊的命中区"，见 `onScreenPointerMove` 上面那段），
   拖窗也改由头部那条接（自己实现，见 `onFloatDragDown`）。
   ⚠️ 必须与主进程的 `mirrorScreenInsets()`（恒 0，上边没有任何一截）**同时**改 —— 只藏 DOM 不改内缩，
   画面会比主进程算的矮一截，圆角里当场露出 letterbox 黑条。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-titlebar {
  display: none;
}

/* **头部那条**：整窗宽 × `floatDragHeight`，既收 hover（触发 chrome 显形）又自己拖窗。
   `position: absolute` + DOM 排在画面之后 ⇒ 压在画面（`.mirror-screen` 是定位元素）上面；
   `z-index: 2` 只是把这条说死，不靠 DOM 顺序。
   ⚠️ **`no-drag` 是必须的**（2026-10-17）：写着 `drag` 时这一整片是 Chromium 的**事件黑洞**
   —— 指针进去一个事件都不发，`pointerenter` 永远不来、chrome 弹不出来。改成自己拖之后
   （`window.moveTo`，见 `onFloatDragDown` 那组）它才收得到指针。
   ⚠️ `pointer-events` 保持默认（`auto`）：它现在就是那个"鼠标移到头部"的落点。
   ⚠️ 它压在画面顶部这一条上 ⇒ 画面最上面 `floatDragHeight` 那一条点不到（通知栏还有下面一截可拉）。
   胶囊那一格不受影响（`.mirror-rail` 的 `z-index: 3` 在它上面）。 */
.mirror-float-drag {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: var(--float-drag-height);
  z-index: 2;
  -webkit-app-region: no-drag;
}

.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-main>* {
  grid-area: 1 / 1;
}

.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-frame {
  /* 画面铺满那一格：窗口就是画面，右沿与下沿都不再留任何一格。 */
  width: 100%;
  height: 100%;
  justify-self: stretch;
  align-self: stretch;
}

/* 胶囊的**命中区**：贴在窗口右上角，尺寸 = 胶囊 + 一圈外扩（四边由 padding 给）。
   ① 它**吃指针**（`pointer-events: auto`）—— 它必须**自己**收得到 `pointerenter` / `pointerleave`
      （面板收起时是 `pointer-events: none`，接不了事件）。它管的不是"进没进头部"（那是
      `.mirror-float-drag` 的活），而是**贴着胶囊上下挪时别被判成离开**：这一块比头部那条高
      （下沿到胶囊下面 `hitPad` 那圈），指针压在胶囊上时仍算"还在 chrome 上"。
   ② `-webkit-app-region: no-drag`：它压在头部那条上（`z-index: 3` > 2），写 `drag` 就一个指针
      事件都收不到（drag 区里 Chromium 不发事件）—— 头部那条已经不写 `drag` 了，这条照旧钉着。
   ③ **必须自己也是定位元素**才画得到画面上面 —— `.mirror-screen` 带 `position: relative`，
      定位元素在同一个层叠上下文里排在静态兄弟**之后** ⇒ 长条作为静态兄弟会被画面整个盖住
      （DOM 查出来 `opacity:1`、矩形也对，屏幕上却什么都没有，10-11 截图实锤过）。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail {
  position: absolute;
  inset: 0 0 auto auto;
  padding: var(--rail-capsule-top) var(--rail-capsule-right) var(--rail-hit-pad) var(--rail-hit-pad);
  /* ⚠️ 宽度必须在这里改掉：基础样式那条 `width: var(--rail-w)`（= 满屏那档的 86）是**布局宽度**，
     留着它命中区就只有 86 宽、比胶囊还窄（胶囊宽度是内容撑开的，按钮一多就超过 86），
     "命中区 = 胶囊 + 一圈外扩"就不成立了。`max-content` = 胶囊宽 + 左右 padding。
     （`inset: 0 0 auto auto` 是 top 0 / right 0 / bottom auto / left auto —— 贴窗口右上角。） */
  width: max-content;
  z-index: 3;
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

/* 被拖过之后（根节点 `is-rail-moved`）：定位从"贴右上"换成"左上角 + translate"。
   `--rail-x/y` 存的是**胶囊左上角**（`getBoundingClientRect` 量出来的），而这里的 padding 是
   命中区外扩 ⇒ 命中区的左上角要往回退一圈 `hitPad`，胶囊才落在同一个点上。
   ⚠️ 两套写法算出来的默认落点必须逐像素一致（否则按下的那一瞬间胶囊会跳）：贴右上时
   `胶囊左 = 窗口宽 − 胶囊宽 − rail-capsule-right`，而 `--rail-x` 正是按下时量到的这个值。 */
.mirror-window.is-rail-moved.is-rail-float:not(.is-fullscreen) .mirror-rail {
  inset: auto;
  left: 0;
  top: 0;
  padding: var(--rail-hit-pad);
  translate: calc(var(--rail-x) - var(--rail-hit-pad)) calc(var(--rail-y) - var(--rail-hit-pad));
}

/* 胶囊本体：**横向一条 + 玻璃质感**。
   ⚠️ 宽度由内容撑开（`width: auto`）—— 按钮数随条件渲染（桌面模式那颗只在采主屏那档出、dev 那格
   只在开发时出），写死宽度会在那些情况下留一段空壳。
   ⚠️ 底色与边框都是**写死的色值**，不跟主题走：镜像页是另一份 CSS 产物，Tailwind 的 `@theme` 只发
   被用到的令牌（见上面 `--rail-accent` 那段），`var(--color-*)` 在这里取不到值 = 透明。
   ⚠️ `translate: none` 压掉基础样式里那条 `--rail-top`（纵向拖拽位移是满屏那档的东西）。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__panel {
  flex-direction: row;
  align-items: center;
  gap: 2px;
  width: auto;
  height: var(--rail-capsule-height);
  margin: 0;
  padding: 3px;
  border-radius: 999px;
  background: rgb(255 255 255 / 46%);
  /* ⚠️ **只写标准属性，别手写 `-webkit-backdrop-filter`**（真机验收踩到的坑，2026-10-16）：
     手写前缀版会让 lightningcss（Vite 的 CSS 压缩）把它们当成**同一属性的重复声明** ⇒ 留下前缀版、
     删掉标准版；而当前 Electron（Chromium 138）**不认那个前缀版**（实测 `el.style.webkitBackdropFilter
     = 'blur(4px)'` 赋不进去、`getComputedStyle` 读回 `none`，只有标准 `backdrop-filter` 生效）
     ⇒ 玻璃质感当场失效，肉眼就是一块半透明白底（CDP 实测 `backdropFilter: "none"`）。
     只写标准属性时 lightningcss 自己会把前缀版加上、且两条都留（产物实测）—— 交给它。 */
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgb(255 255 255 / 55%);
  box-shadow:
    0 6px 18px rgb(0 0 0 / 20%),
    inset 0 1px 0 rgb(255 255 255 / 55%);
  translate: none;
  /* **可拖**（用户 2026-10-16：「右侧操作栏可拖动」）：空白处是抓手、按住是抓握。
     按钮自己的 `cursor: pointer` 更具体 ⇒ 指针落在按钮上不会显示抓手。
     `touch-action: none` = 触摸板上拖它别被当成滚动手势吞掉；
     `user-select: none` = 拖的过程中不选中里面的文字。 */
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__panel:active {
  cursor: grabbing;
}

/* 窗口态不画把手：胶囊钉在顶部右侧、纵向没有可落区间（`clampRailTop` 只会回 0），
   画个把手就是骗人抓的假开关。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__handle {
  display: none;
}

/* 胶囊上的按键：小一号、不画灰底（玻璃面够浅，灰底会糊成一片），图标压深保证可读。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__key {
  width: 22px;
  height: 22px;
  background: transparent;
}

/* ⚠️ **「开着」那三颗（关屏 / 常驻 / Mac 键盘）必须把填色加回来** —— 用户 2026-10-16 第三条报的
   「悬浮按钮点击后变为白色，和背景同色了」。
   根因是**特异性**，不是值写错：上面那条 `.mirror-rail__key` 是 (0,4,0)，压过了基础样式里的
   `.mirror-rail__key.is-active { background: var(--rail-accent) }`（(0,2,0)），却**没压过**同一组里的
   `color: #fff` ⇒ 真机实测点击后 `bg: rgba(0,0,0,0)` + `color: rgb(255,255,255)`，
   白图标画在 `rgba(255,255,255,0.46)` 的玻璃胶囊上 = 那颗按键当场消失。
   ⇒ 这里按满屏那档同一条规矩把填色补回来（`--rail-accent` = 主窗口那颗主按钮同一个蓝）。
   ⚠️ `:hover` 必须一并写：不写的话鼠标压上去反而又变回透明（基础样式那条 `.is-active:hover` 同样
   被上面 (0,4,0) 压掉）。按下那一下的 `filter: brightness(0.9)` 走基础样式，不受影响。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__key.is-active {
  background: var(--rail-accent);
}

.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__key.is-active:hover {
  background: var(--rail-accent-press);
}

/* 导航键那一组从"贴到长条底部"改成**横向接在后面**，并用一条细分隔线跟开关组分开
   （满屏那两档仍是纵向一列 + `margin-top: auto` 压到底）。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__keys {
  flex-direction: row;
  align-items: center;
  gap: 2px;
  margin-top: 0;
}

.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__keys::before {
  content: "";
  width: 1px;
  height: 14px;
  margin: 0 3px;
  background: rgb(0 0 0 / 14%);
}

/* dev 那一格：基础样式给它的是纵向排布下的 `margin-top`，横向排里会把整条顶歪。 */
.mirror-window.is-rail-float:not(.is-fullscreen) .mirror-rail__dev {
  margin-top: 0;
  padding: 2px 7px;
}


/* ── 全屏那一屏（`.is-fullscreen`，判据由主进程 `mirror:fullscreen` 推过来）────────────────
   照 AndroMeld 那个样子：一块明亮的底、手机在一格、右侧那条常驻在另一格。 */
.mirror-window.is-fullscreen {
  /* ⚠️ macOS 全屏那一屏背后**不是桌面**：窗口本体透明，在那儿就是一块黑（用户 10-10「背景不要黑色」）。
     所以这一档自己铺亮底，数取竞品那张图四周那圈浅薄荷（在它截图上多点采样 = `#d1e4e4`）。
     窗口态仍然透明 —— 那才是「就是个手机样子」靠的东西。 */
  background: #d1e4e4;
}

.mirror-window.is-fullscreen .mirror-main {
  /* **两格**：画面一格（1fr）+ 长条一格（它自己的 86px）。
     之前让两者同格叠放（画面铺满整屏、长条浮在画面右上），代价是横屏时那块黑框一直顶到窗口右沿，
     按钮就压在画面上（用户 10-11「不要覆盖掉右侧操作按钮」）⇒ 现在长条占一格，画面永远不进那一截。
     代价要说清：画面因此居中在「整屏减掉长条那一格」的区域里，中线比屏幕正中左移半条（43px）。 */
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr) auto;
  /* 顶天立地会贴住屏幕上下沿，留一点呼吸。这一截同时是画面与长条之间的间隔（`--fs-pad`，一个数）。 */
  --fs-pad: 12px;
  padding: var(--fs-pad);
  /* 让 `100cq*` 可用：黑框的尺寸要按**这一格真正能用多大**来算（见下面 `.mirror-frame`）。
     `size` 那档要求本元素尺寸不靠内容定 —— 它是 `.mirror-window`（h-full）里 `flex: 1` 的一格，本来就定得死。 */
  container-type: size;
}

.mirror-window.is-fullscreen .mirror-main>* {
  min-width: 0;
  min-height: 0;
}

.mirror-window.is-fullscreen .mirror-frame {
  grid-area: 1 / 1;
  justify-self: center;
  align-self: center;
  /* 黑框要**跟着画面收成手机那一块**：常态下窗口本身就是手机形状（`.mirror-frame` 铺满 = 手机），
     满屏时窗口是横的，铺满就成一块 16:9 的黑板。
     ⚠️ 尺寸必须**两个方向一起判**，不能像之前那样「按高铺满 + `max-width: 100%`」：那条写法在横屏时
     被 `max-width` 掐掉宽度、高度却仍按 100% —— 盒子的比例就不等于视频了（实测 1920x1080 屏上横屏
     视频 2340x1080：盒子 1824x1056 = 1.73，视频 = 2.17），画布在里面 contain ⇒ 上下各一条黑边（用户 10-11
     「全屏横屏画面出现了黑边」）。取「可用宽」与「可用高 × 比例」里小的那个，竖屏落到按高铺满、
     横屏落到按宽铺满，两种都让盒子**正好等于视频比例** ⇒ 画布铺满那一格，不留黑边。
     比例用视频自己的（`--screen-ratio` / 数值那份 `--screen-ratio-n`，都由 `syncCanvasBox` 量到真实尺寸
     那一拍喂进来）。`100cq*` 量的是这一格的可用尺寸（已减 `padding`，但**没减**右边那格），
     所以长条那一格 `--rail-w` 与一格呼吸位 `--fs-pad` 要自己扣掉。 */
  width: min(calc(100cqw - var(--rail-w) - var(--fs-pad)), calc(100cqh * var(--screen-ratio-n)));
  aspect-ratio: var(--screen-ratio);
  height: auto;
  /* ⚠️ 这一档黑框**不再用 `border`**：`aspect-ratio` 管的是**含边框那个盒**（全局 `box-sizing: border-box`），
     边框吃掉的 4px 让里面那块内容盒比视频窄一圈（实测内容盒 442x968 = 0.4566，视频 1080x2340 = 0.4615）
     ⇒ contain 之后上下各露 ~5px 黑。改成往外画的 `box-shadow` 那一圈不吃布局，盒本身正好等于视频比例。
     窗口态照旧用 `border`（那边的内容盒由主进程按 `mirrorScreenInsets()` 定死，正好等于画面矩形，没有这个问题）。
     圆角这里只写内圈 `--radius`：阴影沿元素圆角往外扩 `--bezel` ⇒ 外沿自动是 `radius + bezel`，与窗口态同心。 */
  border: none;
  border-radius: var(--radius);
  box-shadow: 0 0 0 var(--bezel) #0b0b0d;
}

.mirror-window.is-fullscreen .mirror-rail {
  grid-area: 1 / 2;
  align-self: start;
}

/* 满屏里没用的两样一起撤：拖窗条（那一屏没人会去拖它，留着只压在画面顶上），
   以及红绿灯那一截 —— 真全屏里那三颗归系统收放（顶边才浮出），在他眼里那就是长条顶部一块**空白区域**
   （用户 10-11：「全屏右侧悬浮红绿灯区域要去掉」）。顶边留白改由面板自己的 `padding-top` 给。 */
.mirror-window.is-fullscreen .mirror-titlebar {
  /* 满屏那一屏「什么都不要有」（10-11）⇒ 标题栏整条撤掉，画面从窗口顶开始铺。
     主进程的 `mirrorScreenInsets()` 那一截只算在窗口态（`initialCss` 是建窗口那一刻算的），
     全屏后画面区由 CSS 定，所以这里隐藏它不会让虚拟显示尺寸算错。 */
  display: none;
}

/* 右侧长条**一直显示**（用户 10-10）：hover 那套显隐只在窗口态有意义。
   特异度高于 `.mirror-rail__panel.is-shown` ⇒ 不用管 JS 那个类，也不用改 `chromeReveal` 的状态机。
   `padding-top` 补回红绿灯那一截撤掉后缺的顶边留白。
   ⚠️ **桌面模式那一屏除外**（`:not(.is-edge-to-edge)`）：那一屏要「什么都不要有」⇒ 长条回到
   hover 显隐，触发按坐标判（见 `onScreenPointerMove`）。 */
.mirror-window.is-fullscreen:not(.is-edge-to-edge) .mirror-rail__panel {
  padding-top: 10px;
  opacity: 1;
  pointer-events: auto;
}

/* ── 桌面模式那一屏（`.is-edge-to-edge` = 满屏 + 这块显示是我们建的）──────────────────
   用户 2026-10-11：「只把视频全屏，其他什么东西都不要有，镜像比例跟显示器一样」。
   所以这一组只做两件事：① 画面那一格**铺满整屏**（黑框 / 亮底 / 圆角 / 内缩全部撤掉），
   ② 长条**浮在画面右上**、平时不画，指针进右边缘那一条才淡入（离开 1 秒后收，同一套状态机）。
   比例不是拉伸出来的：画面区铺满 ⇒ `contentCss()` = 整屏 ⇒ 现有那条 ResizeObserver 走
   `displayFollower` 发 `resizeDisplay`，**设备把这块显示重排成显示器的形状**；退出全屏同一条路排回去。 */
.mirror-window.is-edge-to-edge {
  /* 全屏那一屏背后不是桌面，透明=黑；重排落地前那一瞬露的也是黑，比亮薄荷底更像「只有视频」。 */
  background: #000;
}

.mirror-window.is-edge-to-edge .mirror-main {
  /* 回到单格：长条与画面同格叠放（画面铺满，长条浮在上面）。 */
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  padding: 0;
}

.mirror-window.is-edge-to-edge .mirror-main>* {
  grid-area: 1 / 1;
}

.mirror-window.is-edge-to-edge .mirror-frame {
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
  justify-self: stretch;
  align-self: stretch;
  box-shadow: none;
  border: none;
  border-radius: 0;
}

.mirror-window.is-edge-to-edge .mirror-screen {
  border-radius: 0;
}

/* 浮在画面上那一格：① 不吃点按（否则画面右缘 86px 的触控全没了），只有显形的面板接；
   ② **必须自己也是定位元素**才画得到视频上面 —— `.mirror-screen` 带 `position: relative`（收字字段的定位祖先），
     定位元素在同一个层叠上下文里排在静态兄弟**之后** ⇒ 长条作为静态兄弟被视频整个盖住：
     DOM 查出来 `opacity:1`、矩形也对（1840,0,74x361），屏幕上却什么都没有（2026-10-11 截图实锤）。
     给它 `position: relative` 后两个都是 z-index:auto 的定位元素 ⇒ 按 DOM 顺序，后面的长条压在视频上，
     不用写一个 z-index。 */
.mirror-window.is-edge-to-edge .mirror-rail {
  position: relative;
  justify-self: end;
  align-self: start;
  pointer-events: none;
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

/* ── 那层 chrome 涂装：**一整块**（2026-10-13 第四稿）────────────────────────────────
   用户 10-13：「上边和右边的边框以及左上角右上角右下角的圆角不协调，不是一个图层」→
   「左上角右上角右下角和上边右边改成一个 div」。他说得对：上一版是**三个元素**在画同一层涂装
   （`.mirror-titlebar` 一条臂、`.mirror-rail` 一条臂、`.mirror-main` 上三层 `radial-gradient` 补三个角），
   连淡入都是两套 —— 两条臂走 `background-color`（可过渡），三块角走 `background-image`（不可过渡，
   "啪"地早到早走）。现在全部归这一个 div。

   形状怎么来的：这一层铺满 `.mirror-body`、整块填 `#dcdfe3`，而**手机画在它上面**
   （`.mirror-main` 抬到 `z-index: 1`）⇒ 手机轮廓自己把中间那块"挖"掉，剩下的正好是三样：
   ① 上臂（标题栏那 28px）、② 右臂（长条那 86px）、③ 手机黑框三个圆角**外侧**那三块
   （黑框是 `--frame-radius` 的圆角矩形，它的**包围盒**在圆角外还有三块没被画到 —— 就是上一版
   要用三层 `radial-gradient` 去补的楔形）。一个 div + 一条 `opacity` 就全有了。

   ⚠️ **左下角那一块必须挖掉**（用户 10-12「左下角不要有边框，只有上边和右边有」）：它是手机黑框
   左下圆角外侧那块，手机盖不住它（它本来就在圆角之外），不挖就是手机左下凭空一块灰。
   挖法 = `clip-path` 上切一个 `--frame-radius` 见方的方口：方口比那块楔形略大，多出来的部分落在
   黑框**里面**、被手机盖住 ⇒ 看不出接缝（不必真按圆弧去裁）。
   ⚠️ **两条臂都不写 `border-radius`**（10-12 连着两刀：「左上右上右下的圆角颜色和边框颜色一样，
   不要现在丑丑的黑色」→「边框圆角加一下」）：**窗口那圈圆角归 macOS 系统**（透明窗口照旧被裁成圆角，
   实测角上 `(1,1)`/`(3,3)` 是桌面、`(6,6)` 起就是灰），我们只管把灰铺到窗口边，圆角就是对的。
   自己再写一圈 CSS 半径 = 在系统那圈**里面**又挖一圈，两圈不重合 ⇒ 中间露出一条桌面，就是他说的黑缺口。
   ⚠️ 也别去主进程加 `roundedCorners: false` 想把灰铺到尖角 —— 那一下**三颗彩虹键整块没了**（10-12 实测，
   理由与取证见 `electron/mirror/session.js` 里那段）。手机轮廓那圈圆弧在 `.mirror-frame` 上（`--radius`），照旧。
   ⚠️ **只换涂装，不动布局** —— 标题栏与右边那一格平时照样占位（`mirrorScreenInsets()` 算的就是占位后的
   画面矩形），否则一显一收画面矩形就变 ⇒ 白发一条 `resizeDisplay` ⇒ 手机当场重排一次。
   平时这一层 `opacity: 0`，看不见，所以"就是个手机样子"仍然成立（用户 10-12 原话）。
   ⚠️ 淡入淡出的两个时长照旧用长条那两个数（`--rail-fade-in/out`）：进来跟手、出去收干净。 */
.mirror-chrome {
  position: absolute;
  inset: 0;
  /* 压在手机下面（`.mirror-main` 是 z-index: 1）——形状就是靠"手机盖住中间那块"挖出来的。 */
  z-index: 0;
  background: #dcdfe3;
  /* 只是涂装：不接指针，拖窗口那条 drag 区照旧。 */
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--rail-fade-out) ease-in;
  /* 左下角那个方口（见上面那段）。`--frame-radius` 是黑框外沿那圈半径（40 + 4 = 44）。 */
  clip-path: polygon(
    0 0,
    100% 0,
    100% 100%,
    var(--frame-radius) 100%,
    var(--frame-radius) calc(100% - var(--frame-radius)),
    0 calc(100% - var(--frame-radius))
  );
}

/* 两档全屏没有这层涂装（满屏那屏铺的是亮底、桌面模式那屏是纯画面），照旧由 `:not(.is-fullscreen)` 挡住。
   ⚠️ **浮动态也没有**（用户 2026-10-14 第二条把这一档的窗口定成"只剩手机"）：那层灰画的是**两条臂**
   （上边标题栏 + 右边长条）与手机三个圆角外侧的楔形，浮动态两条臂都没了、画面铺满整格 ⇒ 只剩三块
   孤零零的灰楔形贴在角上，看着像脏点。这一档窗口里除了手机不该有别的东西。 */
.mirror-window.is-chrome:not(.is-fullscreen):not(.is-rail-float) .mirror-chrome {
  opacity: 1;
  transition: opacity var(--rail-fade-in) ease-out;
}

/* 「标题栏 + 画面」这一竖列，dev 边栏仍在它右边（`.mirror-window` 那一横排）。
   `position: relative` 是给涂装那一层（`.mirror-chrome`，绝对定位铺满这里）当定位祖先用的。 */
.mirror-body {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 顶部标题栏：三颗彩虹键的地盘 + app 名称（用户 2026-10-12 点单）。
   ⚠️ `position: relative; z-index: 1` 与 `.mirror-main` 同一件事：抬到涂装那一层（`.mirror-chrome`）
   上面 —— 那层灰铺满整扇 `.mirror-body`（含这一条的地盘），不抬就被它盖住，名称也看不见了。 */
.mirror-titlebar {
  position: relative;
  z-index: 1;
  flex: none;
  /* ⚠️ 变量名别写成 `--titlebar-h`：lightningcss 1.33 的 minify 会把整个 CSS 判成
     "Unexpected end of input"，而 dev 不压缩 ⇒ 只有 `vite build` 才炸（10-12 撞过一次）。 */
  height: var(--titlebar-height);
  /* 同格叠两层：名称（拖拽区）+ 顶上那一条触发带。这两层自己不用 `position`，谁在上面看 DOM 顺序。 */
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  align-items: center;
  /* 平时不画底色（窗口本体透明 = 手机外面什么都没有）；chrome 显形时那条灰是下面 `.mirror-chrome`
     这一层画的，不归这条（10-13 第四稿）。10-12 先试过把它涂成黑框那个 `#0b0b0d`，
     结果黑条 + 黑框把手机切成两截，更难看。 */
  background-color: transparent;
  /* 整条默认就是窗口拖拽区 —— 取代 10-10 那条压在画面顶上的 `.mirror-dragstrip`
     （那条会吃掉手机画面最顶 24px 的点按，这里不再有这个代价）。 */
  -webkit-app-region: drag;
}

.mirror-titlebar>* {
  grid-area: 1 / 1;
  min-width: 0;
}

/* 顶上那一条**触发带**（`MIRROR_TITLEBAR.revealHeight`）：唯一必须 `no-drag` 的一截。
   为什么要有它 —— `-webkit-app-region: drag` 那一片 Chromium **不把指针事件送进 DOM**
   （10-12 探针：从画面中间一步一步往上移，y≥30 一路都有 `pointermove`，踏进 drag 区那一步起一个都没有），
   而用户 10-12 要「鼠标移动到上边也要展示边框」⇒ 整条都当拖拽区就永远收不到"贴上边"这个信号。
   让出最上面 12px 当触发区，剩下 16px 照样拖窗口（探针实测拖得动，见 `mirror-window-chrome` 文档）。
   自己不画东西，也不接点击以外的行为 —— 它只是把这条带的坐标喂给 `chromeZone`。 */
.mirror-titlebar__reveal {
  align-self: start;
  height: var(--titlebar-reveal-height);
  -webkit-app-region: no-drag;
}

.mirror-titlebar__name {
  align-self: center;
  /* 让开三颗：`--titlebar-name-x` = lightX + 整组宽 + 间距，算式在 `mirrorTitlebarNameLeft()`。 */
  padding-left: var(--titlebar-name-x);
  font-size: 12px;
  line-height: 1;
  letter-spacing: 0.1px;
  /* 浅灰底 ⇒ 深色字（竞品那条就是系统默认的标题色）。 */
  color: rgb(0 0 0 / 62%);
  font-weight: 500;
  /* 平时不画字（chrome 没显形），跟长条同一条淡入淡出。 */
  opacity: 0;
  transition: opacity var(--rail-fade-in) ease-out;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  user-select: none;
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
