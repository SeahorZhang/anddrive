import { CHANNELS } from "../../electron/ipcContract.js";
import { getServerClient, acquireDeviceAdb, startScrcpy, startAudioScrcpy, codecName } from "./connect.js";
import { computeDisplayMetrics, scaleDisplayDpi } from "../../shared/scrcpyConfig.js";
import { createDisplayFollower } from "./displayFollow.js";
import { createSleepWatcher } from "./sleepWatch.js";
import { createMacKeyboardBridge } from "./macBridge.js";
import { probeLocalCodecs } from "../utils/codecCaps.js";
import { createOpusPlayer } from "./audio.js";
import { applyControl } from "../../electron/mirror/control.js";

// ---------------------------------------------------------------------------
// 直连会话（每窗口一个 scrcpy client）：adb/scrcpy 全用 Tango 官方库建立
// 于本进程；视频/音频/控制流不跨进程。音频失败自动降级纯画面。
// ---------------------------------------------------------------------------

const current = {
  client: null,
  info: null,
  /** 本窗口的 adb（Mac 键盘那条桥要拿它连设备上的抽象 socket）。 */
  adb: null,
  resizeObserver: null,
  follower: null,
  stopping: false,
  /** 本会话虚拟显示的 id（从 server stdout 里解析），未拿到为 null。 */
  displayId: null,
  /** 「应用被别的显示拿走」轮询的停止函数。 */
  stopStolenWatch: null,
  /** 设备电源状态轮询的句柄（`stop` / `kick`）。 */
  sleepWatch: null,
  /**
   * 本窗口是不是这台设备**唯一那条音频会话**的承载者（用户 2026-10-14 第三条）。
   * 由主进程选举（该设备最早的镜像窗口），关窗时移交 —— 见 `ensureAudioCompanion`。
   */
  audioHost: false,
};

/** 设备侧送回执/坏消息时的出口，由 `App.vue` 挂进来（它才知道该往哪句提示上放）。 */
let notifyMacKeyboard = null;
export function onMacKeyboardFeedback(handler) {
  notifyMacKeyboard = typeof handler === "function" ? handler : null;
}

/** 当前窗口的 CSS 尺寸（视口）。用 documentElement 而不是 innerWidth：后者含滚动条/边框口径。 */
function cssViewport() {
  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
}

/** 画面区元素，由镜像页在 `bootstrap()` 之前设好（`App.vue` 的 `canvasHost`）。 */
let contentEl = null;

export function setContentElement(el) {
  contentEl = el;
}

/**
 * **画面区**的 CSS 尺寸 —— 虚拟显示按它算，不按视口。
 *
 * 生产里画面区就是整个视口（两者相等）；dev 的 HUD 在右侧占一条边栏，画面区比窗口窄，
 * 若仍按视口算，画面比例与显示比例对不上，contain 适配会多出黑边、`1dp = 1 CSS px`
 * 的等式也会错位。元素没挂上或还没排版（尺寸为 0）时回落视口。
 */
function contentCss() {
  const width = contentEl?.clientWidth ?? 0;
  const height = contentEl?.clientHeight ?? 0;
  if (width > 0 && height > 0) return { width, height };
  return cssViewport();
}

/** 「大屏模式」这一个判据：尺寸口径、要不要 flex 与跟随器都读它（`buildMirrorOptions` 里同一开关）。 */
function largeScreenMode() {
  return current.info?.config?.largeScreenDisplay === true;
}

/**
 * 虚拟显示尺寸的唯一算法（建显示与后续 `resizeDisplay` 必须同源，否则初始密度与跟随期密度错位）：
 * - **大屏模式**：窗口 CSS × 画质档位倍率，dpi = 160 × 倍率，于是 1dp = 1 CSS px。
 * - **默认（上游原生产物）**：窗口画面区的**物理像素**（CSS × `devicePixelRatio`），密度按主屏长边
 *   等比换算（`scaleDisplayDpi`，与上游非 flex 那条路的 `scaleDpi` 同一个算式）—— 上游对 flex 显示
 *   不允许缺密度（`prepare()` 里 `if (dpi == 0) { assert !flexDisplay }`），所以这份必须我们自己算。
 *   这样两条同时成立：1 显示像素 = 1 屏幕物理像素（按 px 写死的控件不被整帧压小），
 *   长边 dp 数与主屏一致（版式不随窗口漂移）。
 * 档位在主进程给的 config 里，整场不变：`resizeDisplay` 只带宽高、不带 dpi，dpi 在建显示时定死。
 * 主进程没给到设备信息（`screenSize` / `screenDpi`）时不给尺寸：窗口形状与密度都不可信，
 * 退上游默认（主屏尺寸与密度、不开 flex）比猜数字好。
 */
function displayFor(css) {
  if (largeScreenMode()) {
    return computeDisplayMetrics(css.width, css.height, current.info?.config?.quality);
  }
  const dpr = window.devicePixelRatio || 1;
  const size = { width: Math.round(css.width * dpr), height: Math.round(css.height * dpr) };
  const dpi = scaleDisplayDpi(current.info?.screenSize, current.info?.screenDpi, size);
  return dpi ? { ...size, dpi } : size;
}

/**
 * 开会话时用的 CSS：主进程建窗口时就已知道内容区尺寸（`initialCss`），直接拿它，
 * 不等渲染层布局。深链冷启动时镜像页可能还没排版完，读 DOM 会得到一个错误的默认值，
 * 开出一块错尺寸的显示（2026-09-28 实测 512x512/480）。
 * **采主屏（`deviceMirror`）不给尺寸**：那条路上 server 采的是手机那块屏、根本不建显示，
 * 给了会被 `buildMirrorOptions` 抛。
 */
function initialDisplay(info) {
  if (info?.deviceMirror) return undefined;
  if (!info?.screenSize || !(info?.screenDpi > 0)) return undefined;
  const css = info?.initialCss;
  return displayFor(css?.width > 0 && css?.height > 0 ? css : contentCss());
}

/**
 * @param {Record<string, unknown>} info mirror:initGet 的启动参数
 * @param {{
 *   onMeta: (meta: Record<string, unknown>) => void,
 *   onVideoPacket: (packet: unknown) => Promise<void> | void,
 *   onEnded: () => void,
 *   onReflowStart?: (size: { width: number, height: number }) => void,
 *   onReflowAbort?: () => void,
 *   onReflowSent?: () => void,
 *   onStolen?: (stolen: boolean) => void,
 *   onSleepChange?: (asleep: boolean, state: string) => void,
 * }} handlers
 */
export async function startSession(
  info,
  {
    onMeta,
    onVideoPacket,
    onEnded,
    onReflowStart,
    onReflowAbort,
    onReflowSent,
    onStolen,
    onSleepChange,
  },
) {
  current.info = info;
  // `bootstrap()` 可以重复调用（页面重载 / 被顶掉后接回），`stopSession()` 会把这一位立起来，
  // 不在这里落回去的话，重建的会话里 `client.exited` 那条回调会以为已经收摊了。
  current.stopping = false;
  const adb = await acquireDeviceAdb(getServerClient(), info.serial);
  current.adb = adb;
  current.audioHost = info.audioHost === true;
  // 音频与画面**不在同一条会话里**（用户 2026-10-14 第三条报障的修法，机制见
  // `electron/mirror/options.js` 的 `buildMirrorOptions`）：这台设备的音频由**唯一一条**
  // 纯音频会话负责，它承载在该设备最早的镜像窗口里。两条会话**并行**建 —— 两份 jar 推到不同路径，
  // 实测并行总耗时与推一份相同（~1.28s），音频首包 ~1.72s，与单条视频会话同时。
  const companionPromise = wantsAudioCompanion() ? ensureAudioCompanion() : null;
  const { client, display: createdDisplay } = await startScrcpy({
    adb,
    serverPath: info.serverPath,
    config: info.config,
    display: initialDisplay(info),
    deviceMirror: info.deviceMirror === true,
    // `auto` 在这里落地：设备能编哪些由主进程探好随启动参数带来，本机能不能解现场探测。
    caps: { device: info.deviceCodecs ?? null, local: await probeLocalCodecs() },
  });
  current.client = client;

  const video = await client.videoStream;
  if (!video) throw new Error("scrcpy 未返回视频流");

  // 采集 scrcpy server 的 stdout（stderr 会并入），异常退出时可供排查/上报。
  const serverErrors = new Set();
  try {
    const outputReader = client.output.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await outputReader.read();
          if (done) break;
          // `New display: 812x1766/320 (id=145)` —— 本会话这块虚拟显示的 id 只在这里能拿到，
          // 「接回画面」要拿它判断应用是不是被别的显示（别的投屏软件）搬走了。
          const displayMatch = /\(id=(\d+)\)/.exec(value);
          if (displayMatch) current.displayId = Number(displayMatch[1]);
          if (/error|error:|exception|fail/i.test(value)) {
            serverErrors.add(value);
            console.warn(`[mirror] server: ${value}`);
          }
        }
      } catch {
        // 流结束
      }
    })();
  } catch {
    // output 不可用不影响会话
  }

  // 音频（`current.audioHost` 那一档才有）：等它落地再报 `hasAudio`。起不来只降级成纯画面，
  // 不拖住画面 —— scrcpy 4.0 起音频仅支持 Opus，采不到时服务端把流标 `disabled`（不是抛错）。
  // ⚠️ 这一档在建会话时定死：设备投屏期间不出声是服务端 `REMOTE_SUBMIX` 直采的结果，控制协议里
  // 没有任何音频路由消息 ⇒ 运行时改它只能整条会话重来，所以我们不提供「声音在电脑 / 在手机」的切换。
  let audioConfigured = false;
  if (wantsAudioCompanion()) {
    // 起会话期间才收到「音频归你」那一条（`mirror:audioHost`）时 `companionPromise` 还是 null —— 这里补一次。
    audioConfigured = await (companionPromise ?? ensureAudioCompanion()).catch((error) => {
      console.warn("[mirror] 设备音频会话建立失败：", error?.message || error);
      audioIssueSink?.(`设备音频不可用：${error?.message || error}`);
      return false;
    });
  }

  onMeta({
    id: info.id,
    serial: info.serial,
    packageName: info.packageName,
    label: info.label,
    codec: video.metadata.codec,
    codecName: codecName(video.metadata.codec),
    width: video.width,
    height: video.height,
    hasAudio: audioConfigured,
  });

  // scrcpy server 自行退出（设备断开 / 进程被杀）→ 通知主进程并关窗。
  client.exited
    .then(() => {
      if (current.client && !current.stopping) {
        const detail = [...serverErrors].slice(-4).join(" / ");
        onEnded(detail);
      }
    })
    .catch(() => {});

  void pumpLoop(video.stream, onVideoPacket, (detail) => onEnded(detail));

  const controller = client.controller;
  // 拉起目标应用走 scrcpy 的控制消息，服务端把它开到**本次采集的那块显示**上
  // （`Controller.getStartAppDisplayId()`：有 `--new-display` 时等那块虚拟显示的 id，
  // 否则用 `display_id` 的缺省值 0 = 手机主屏）。所以「整机镜像」没有包名可发，
  // 而 Android 13 及以下那档采主屏的会话照发 —— 它就是「在手机屏幕上打开这个 app」。
  if (info.packageName) {
    await controller?.startApp(info.packageName).catch(() => {});
  }
  // 虚拟显示那条路还多出两步「这块显示上的应用」的归属：应用可能已经挂在别的显示上
  // （被别的投屏软件搬走、或本来就在主屏上用着），那种情况下 `startApp` 只会把它留在原处，
  // 本窗口就只剩启动器画面 —— 补一次不重启的搬移；之后仍可能被搬走，只负责把接回入口亮出来。
  // 采主屏时没有这个概念（接回要拿本会话的显示 id 比，这一档没有显示），整块跳过。
  if (!info.deviceMirror) {
    void ensureAppHere();
    current.stopStolenWatch = watchAppStolen(onStolen);
  }

  // 设备睡了没有：睡下（`Asleep`/`Dozing`）时页面要亮「已休眠 + 继续使用」。
  // **这一条不分会话形态**：虚拟显示那档设备睡了同样停帧，而它只是报告 + 等用户点，
  // 不动设备任何设置（防睡是主进程按版本开的，见 `electron/mirror/keepAwake.js`）。
  current.sleepWatch = createSleepWatcher({
    read: () => ipcInvoke(CHANNELS.mirrorPowerState, info.serial),
    onChange: (asleep, state) => onSleepChange?.(asleep, state),
    // 窗口被最小化/在别的 Space 时不去打扰设备（同「接回」轮询那条）。
    shouldSkip: () => document.hidden,
  });

  // 虚拟显示跟随窗口（scrcpy `--flex-display` / -x 语义）：**只要这块显示是带着尺寸建的就有 flex**
  // （`buildMirrorOptions` 里 flex 与 `new_display` 一起下发），两种模式都跟随。
  // 拿不到设备信息时那块显示是上游默认（空串、无 flex），这里就必须整块跳过 ——
  // 服务端 `requestResize` 对非 flex 显示直接抛错。
  //
  // 只在尺寸真的变化时才下发：建显示用的那份尺寸已经定死（`initialDisplay()`），启动阶段再补发一条
  // 完全相同的请求会让服务端白走一次 `virtualDisplay.resize()` → capture reset；而虚拟显示是
  // `VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT`，每次配置变更设备上的应用都会重新决定方向，
  // 表现出来就是镜像画面反复旋转。合并/去重逻辑见 `src/mirror/displayFollow.js`。
  //
  // 尺寸来自**画面区**（dev 时比窗口窄，右侧那条 HUD 边栏不算）的 ResizeObserver，
  // 而不是 window 的 `resize` 事件 + innerWidth：macOS 上窗口被系统缩放/吸附时，resize 事件
  // 可能滞后甚至不触发，innerWidth 会读到旧值，导致宽度不跟随。
  if (createdDisplay) {
    const follower = createDisplayFollower({
      // 手一拖就通知页面盖遮罩（`onIntent` 每次尺寸请求都回调），停手合并完才真正下发；
      // 如果合并下来发现尺寸没变（拖出去又拖回来），用 `onSkip` 让页面把遮罩撤掉。
      onIntent: (size) => onReflowStart?.(size),
      onSkip: () => onReflowAbort?.(),
      onSent: () => onReflowSent?.(),
      // `resizeDisplay` 只带宽高：密度在建显示时定死，所以建显示与这里的尺寸必须同源（`displayFor`）。
      send: (size) => controller?.resizeDisplay({ width: size.width, height: size.height }),
    });
    // 种子是**服务端真开出来的那块显示**（这条路上就是我们算并传给它的那份），拿错会压掉第一次真实 resize。
    follower.seed(createdDisplay);
    current.follower = follower;

    // observe() 会立即回调一次当前尺寸：窗口在会话建立期间变过的话，这次就会补上。
    // dev 的 HUD 边栏只在渲染层存在，`initialCss`（主进程算的整窗内容区）比画面区宽，
    // 所以首帧往往是一次**真实的尺寸修正** —— 与上面说的「补发完全相同的请求」不是一回事。
    const observer = new ResizeObserver(() => follower.request(displayFor(contentCss())));
    observer.observe(contentEl ?? document.documentElement);
    current.resizeObserver = observer;
  }

  report("ready", {
    codec: video.metadata.codec,
    codecName: codecName(video.metadata.codec),
    hasAudio: audioConfigured,
  });
  return { hasAudio: audioConfigured };
}

function report(kind, payload = {}) {
  const id = current.info?.id ?? "";
  ipc().send(CHANNELS.mirrorState, { id, kind, ...payload });
}

/** 镜像窗口（非隔离 + nodeIntegration）由 preload 注入的 ipcRenderer 句柄。 */
function ipc() {
  return window.__anddriveIpc ?? window.require?.("electron")?.ipcRenderer;
}

/** 要等主进程回话的调用（查应用所在显示、搬移任务、拉启动参数）。 */
function ipcInvoke(channel, ...args) {
  const renderer = ipc();
  if (!renderer) return Promise.reject(new Error("ipc 不可用"));
  return renderer.invoke(channel, ...args);
}

/**
 * chrome（浅灰底 + 标题栏 + 那三颗）显形/收起。系统画的三颗 CSS 盖不住，只能请主进程开关。
 * 不 invoke 只 send：纯表现层，没有要等结果、也没有会失败的地方。
 *
 * ⚠️ **形态一起报过去**（`railFloating`）：三颗的**落点分两档**（窗口态钉在标题栏里、浮动态让开
 * 画面圆角，见 `electron/mirror/options.js` 的 `mirrorTrafficLightPosition`）。主进程拿不到形态
 * 就只能猜，翻转形态那一拍三颗会留在上一档的落点上（浮动态会重新压回圆角里）。
 *
 * @param {boolean} shown
 * @param {boolean} railFloating
 */
export function setWindowButtons(shown, railFloating) {
  ipc()?.send?.(CHANNELS.mirrorWindowButtons, {
    shown: shown === true,
    railFloating: railFloating === true,
  });
}

/**
 * dev 调试边栏要占多宽（0 = 收起）：主进程把**窗口**撑宽同样的量，画面那块才不被挤小。
 * @param {number} px
 */
export function setHudExtra(px) {
  ipc()?.send?.(CHANNELS.mirrorWindowHud, px);
}

/**
 * 右侧那条操作栏现在**浮在画面里没有**（画面够宽时它不再占窗口右边那一格）。
 *
 * 报给主进程是必须的：形态一变，窗口右边那一截**不参与拖拽比例**的余量就差一条长条宽，
 * 主进程要按新余量重设一次 `setAspectRatio`，否则「画面 = 设备比例」当场破掉。
 * 判据只有一处（`options.js` 的 `mirrorRailFloats`），主进程建窗口时也用它。
 * @param {boolean} floating
 */
export function setRailFloating(floating) {
  ipc()?.send?.(CHANNELS.mirrorRailFloat, floating === true);
}

/**
 * 长条那颗「使用 Mac 键盘」：`on` 把设备默认输入法抢过来、`off` 还原、`state` 只问一句当前归属。
 * 回的是主进程那份状态机的状态（`active` / `switched_away` / `unavailable` / `off`），
 * 开关画什么由它说了算 —— 页面自己猜会和夺回循环打架。
 * @param {"on" | "off" | "state"} action
 * @returns {Promise<string>}
 */
export async function setMacKeyboard(action) {
  return ipcInvoke(CHANNELS.mirrorMacKeyboard, action);
}

/**
 * 订阅归属状态变化（主进程那边抢回来或停手时推过来）。`bootstrap()` 可以重复调用，
 * 所以每次都先把上一份监听摘掉（同 `watchFullscreen` 那条理由）。
 * @param {(state: string) => void} onState
 */
export function watchMacKeyboardState(onState) {
  stopMacKeyboardWatch?.();
  const renderer = ipc();
  if (!renderer) return;
  // 原样传：Slice 3 起主进程推的是 `{state, token, socket}` 对象，
  // 这里再 `String()` 一次就把状态压成 "[object Object]"，页面一律读成 off（10-11 的 × 不生效就是它）。
  const listener = (_event, payload) => onState?.(payload);
  renderer.on(CHANNELS.mirrorMacKeyboardState, listener);
  stopMacKeyboardWatch = () => renderer.removeListener(CHANNELS.mirrorMacKeyboardState, listener);
}
let stopMacKeyboardWatch = null;

/**
 * Mac 键盘那条桥（Slice 3）：跟着归属状态对表 —— `active` / `parked` 时保持连着（让出只是不再送字，
 * 输入法还是我们的，连接不必断），`off` / 拿不到 token 时断开。
 * token 每次开启都换 ⇒ 看到新 token 就重建一条桥（旧连接的暗号已经作废）。
 */
let macBridge = null;
let macBridgeToken = null;

/** @param {{ state?: string, token?: string | null, socket?: string } | null} payload */
export function syncMacKeyboard(payload) {
  const state = payload?.state;
  const wantsBridge = (state === "active" || state === "parked") && payload.token && payload.socket;
  if (!wantsBridge) {
    macBridge?.stop();
    macBridge = null;
    macBridgeToken = null;
    return;
  }
  if (macBridge && macBridgeToken === payload.token) return;
  macBridge?.stop();
  macBridge = createMacKeyboardBridge({
    getAdb: () => current.adb,
    socketName: payload.socket,
    token: payload.token,
    // 用户在手机上按了胶囊的 × → 转告主进程去 parked（它此后不再抢、也不再送字）。
    onYield: () => ipc()?.send?.(CHANNELS.mirrorMacKeyboardYield),
    onNack: (reason) => current.info && notifyMacKeyboard?.({ kind: "nack", reason }),
    // 手机光标的屏幕矩形（设备侧 `CursorAnchorInfo` 的插入点）→ 页面据此把候选窗锚到真实光标上。
    onCaret: (rect) => caretListener?.(rect),
  });
  macBridgeToken = payload.token;
  macBridge.start();
}

/**
 * 合成中的拼音经桥送给输入法（那边 `setComposingText`，光标处带下划线）。
 *
 * ⚠️ **当前 UI 没有调用它**（10-11）：合成串改成只在 Mac 上画（`.mirror-mactext-capsule`），
 * 手机上不再显示，否则同一串会出现两次。这条 op 与设备侧实现**都还在**（是桥的能力，
 * 不是死代码）—— 真要恢复"手机上跟着显示拼音"就把它接回 `App.vue` 的 `compose` 里。
 * 决定不再需要时，连同 `MirrorBridge` / `MirrorInputMethodService` 那边一起删（要抬 APK 版本）。
 * @param {string} text
 */
export function composeViaMacKeyboard(text) {
  return macBridge?.compose(text) === true;
}

/** 光标矩形的订阅者（页面那一个）。设备侧随时可能报新的，所以存一份而不是每次传。 */
let caretListener = null;

/**
 * 订阅设备报来的**手机光标矩形**（屏幕坐标、设备 px；null = 现在没有光标）。
 * 这是候选窗能贴住真实光标的唯一数据源 —— 见 `macTextAnchor.js` 的 `caretRectToAnchor`。
 * @param {(rect: { x: number, top: number, bottom: number } | null) => void} listener
 * @returns {() => void} 退订
 */
export function onMacKeyboardCaret(listener) {
  caretListener = listener;
  return () => {
    if (caretListener === listener) caretListener = null;
  };
}

/**
 * 把一段文本经桥送给输入法（输入法那边 `InputConnection.commitText` 整串落地）。
 * @param {string} text
 * @returns {boolean} 有没有真的送出去（没连着就是 false，调用方决定要不要提示）
 */
export function commitViaMacKeyboard(text) {
  return macBridge?.commit(text) === true;
}

/** 通用流泵（Tango 官方流 API）；send 失败只告警。 */
async function pumpLoop(stream, send, onDone) {
  const reader = stream.getReader();
  for (;;) {
    try {
      const next = await reader.read();
      if (next.done) break;
      await send(next.value);
    } catch {
      break;
    }
  }
  onDone?.();
}

/** 本会话的启动参数（镜像页取应用图标等用途）；会话未建立时 null。 */
export function getSessionInfo() {
  return current.info;
}

/** 当前 controller（Tango 的 ScrcpyControlMessageWriter）；未连接返回 null。 */
export function getController() {
  return current.client?.controller ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把目标应用搬回**本窗口**的虚拟显示：`am display move-stack`，不重启应用
 * （真机量过：搬回来 pid 不变，窗口尺寸等于新显示、铺满）。
 *
 * 为什么需要：应用可能已经挂在别的显示上 —— 被另一个投屏软件搬走（它的 agent 常驻、
 * 显示 id 稳定），或本来就在手机主屏上用着。这时 `startApp` 并不会把它搬过来
 * （真机量过 `am start --display` 对已存在的 task 不改显示），本窗口就只剩启动器画面。
 */
export async function reclaimApp() {
  const info = current.info;
  const displayId = current.displayId;
  if (!info || !displayId) return { ok: false, message: "会话还没就绪" };
  const task = await ipcInvoke(CHANNELS.mirrorAppTask, info.serial, info.packageName).catch(() => null);
  if (!task) return { ok: false, message: "应用没在运行" };
  if (task.displayId === displayId) return { ok: true, already: true };
  try {
    await ipcInvoke(CHANNELS.mirrorMoveTask, info.serial, task.taskId, displayId);
    return { ok: true, moved: true, from: task.displayId };
  } catch (error) {
    return { ok: false, message: error?.message || "接回失败" };
  }
}

/**
 * 点亮屏幕（用户点「继续使用」时）。只唤醒、不解密码锁：带锁屏时亮起来的是锁屏画面。
 * 失败要把原因带回 —— MIUI/HyperOS 上这条吃「USB 调试（安全设置）」那道闸（`INJECT_EVENTS`），
 * 被拒时按钮不能像没反应一样。设备原文常是多行 Java 栈，只取第一行。
 */
export async function wakeScreen() {
  const info = current.info;
  if (!info) return { ok: false, message: "会话还没就绪" };
  try {
    await ipcInvoke(CHANNELS.mirrorWake, info.serial);
    return { ok: true };
  } catch (error) {
    const firstLine = String(error?.message || "").split("\n")[0].trim();
    return { ok: false, message: firstLine || "唤醒失败" };
  }
}

/**
 * 长条那颗「桌面模式」：把手机主屏上**正在用的应用**抽到一块独立虚拟屏窗口里
 * （与首页点应用同一条路，包名由主进程现问设备）。
 * 只有整机镜像 + Android 14+ 才出这颗按钮（判据在主进程，见 `pendingInit.desktopModeAvailable`）。
 * @returns {Promise<{ id: string, label?: string, packageName?: string, reused?: boolean }>}
 */
export async function openDesktopMode() {
  return ipcInvoke(CHANNELS.mirrorDesktopMode);
}

/**
 * server 的 stdout 是异步到的，刚建会话时显示 id 可能还没解析出来。
 */
async function waitForDisplayId(timeoutMs = 1500) {
  const until = Date.now() + timeoutMs;
  while (!current.displayId && Date.now() < until) await sleep(100);
  return current.displayId;
}

/** 会话刚建好时用：应用可能在别的显示上，重试到它能被查到为止。 */
async function ensureAppHere(attempts = 4) {
  await waitForDisplayId();
  let last = { ok: false };
  for (let i = 0; i < attempts; i += 1) {
    last = await reclaimApp();
    if (last.ok) return last;
    await sleep(400);
  }
  return last;
}

/** 轮询间隔：一次 `dumpsys window` 的 grep 要几十到几百毫秒，太密会给设备白添负载。 */
const STOLEN_POLL_MS = 2500;

/**
 * 盯住「应用还在不在本窗口这块显示上」，被别的投屏软件搬走时通知页面显示接回入口。
 * 只报告、**不自动搬**：自动搬回去就是两边来回抢，谁也别想用。
 */
function watchAppStolen(onStolen) {
  let last = false;
  const timer = setInterval(async () => {
    if (document.hidden || !current.client || !current.displayId) return;
    const info = current.info;
    if (!info) return;
    const task = await ipcInvoke(CHANNELS.mirrorAppTask, info.serial, info.packageName).catch(() => null);
    const stolen = !!task && task.displayId !== current.displayId;
    if (stolen !== last) {
      last = stolen;
      onStolen?.(stolen);
    }
  }, STOLEN_POLL_MS);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// 设备级音频会话（用户 2026-10-14 第三条：「打开两个镜像声音重叠了，关掉一个镜像，
// 声音又从电脑回到了手机」）
//
// 机制（真机 Mi 10 / 随包 5.0.1，`dumpsys media.audio_policy` 受控实验）：音频在 Android 上
// 是**设备级**的 —— 只有一条 `AUDIO_DEVICE_OUT_REMOTE_SUBMIX`。两条采集同时跑时拿到的是
// **同一份混音**（两个窗口各播一遍 = 声音重叠），而**释放任意一条**会让 AudioPolicy 把那条
// 输出整条拆掉、应用输出回到 `SPEAKER`，剩下那条采集从此静音（声音「回到了手机」）。
//
// ⇒ 同一台设备同时只能有**一条**采集，且它的生命周期不能挂在某一条镜像窗口上。
// 落地：镜像会话恒 `audio: false`；另起一条**纯音频会话**（`startAudioScrcpy`），
// 由该设备**最早打开的镜像窗口**承载（主进程选举，见 `electron/mirror/session.js`），
// 那个窗口关掉时主进程把这一位交给下一个幸存者（`mirror:audioHost`）——
// **只动音频**：重开一条会话就是了，幸存者那边的画面 / 虚拟显示 / 应用归属一律不碰。
// ---------------------------------------------------------------------------

/** 当前承载的那条音频会话（不是宿主时恒为 null）。 */
let audioCompanion = null;
/** 正在建的那条（同一拍可能有两条路进来：`startSession` 与 `mirror:audioHost` 那条推送）。 */
let audioCompanionPending = null;
/** 收到过 `mirror:audioHost`（可能在会话还没起来时到达，`startSession` 结尾会补一次）。 */
let audioHostWanted = false;
/** `bootstrap()` 给进来的音频出口：HUD 计数 + Opus 播放器（`App.vue` 那条接线原样复用）。 */
let audioSink = null;
/** 音频出问题时的出口（页面上那行 `audioIssue`）。 */
let audioIssueSink = null;

function wantsAudioCompanion() {
  return (current.audioHost || audioHostWanted) && !current.stopping;
}

/**
 * 起/复用本窗口承载的那条设备级音频会话。幂等：已经在跑、或**正在建**都直接跟着走 ——
 * 同一拍有两条路会进来（`startSession` 开头那条并行建，与 `mirror:audioHost` 那条推送），
 * 不挡住的话就会在设备上开出**两条采集**（Android 上那是互相破坏的，见文件末尾那段）。
 * @returns {Promise<boolean>} 音频流真的通了才是 true
 */
async function ensureAudioCompanion() {
  if (audioCompanion) return true;
  if (audioCompanionPending) return audioCompanionPending;
  if (!wantsAudioCompanion() || !current.info || !current.adb) return false;
  const pending = startAudioCompanionOnce();
  audioCompanionPending = pending;
  try {
    return await pending;
  } finally {
    if (audioCompanionPending === pending) audioCompanionPending = null;
  }
}

/** 真正建那一条（只由 `ensureAudioCompanion` 调用，去重那一层在它那里）。 */
async function startAudioCompanionOnce() {
  const info = current.info;
  // 起之前先问一句「设备侧那条采集放开了吗」：Android 只有一条 `REMOTE_SUBMIX`，
  // 而释放要 ~1.3s（真机实测），不等它拆干净就起来会让**新起来的这条从此静音**
  // （两条并存时旧的那条被释放 → 新的那条包照收、设备侧输出已被拆掉 = 声音回到手机）。
  // 主进程把轮询做完（要跑设备命令），这里只 await 一次；超时也照起，宁可试一次。
  await ipcInvoke(CHANNELS.mirrorAudioIdle).catch(() => true);
  const client = await startAudioScrcpy({ adb: current.adb, serverPath: info.serverPath });
  // 会话在这中间换了（关窗 / 「接回」重建）：这条已经没有归属，当场收掉，别让它留在设备上采集。
  if (!wantsAudioCompanion() || current.info !== info) {
    await client.close?.().catch?.(() => {});
    return false;
  }
  audioCompanion = { client };
  // 服务端自己退出（设备断开 / 进程被杀）：清掉这一位，别把一条死会话当成还在跑。
  client.exited?.then?.(() => {
    if (audioCompanion?.client === client) audioCompanion = null;
  })?.catch?.(() => {});

  const meta = await client.audioStream;
  if (meta?.type !== "success") {
    // 服务端采不到音频时把流标 `disabled`（**不是抛错**，回来的对象没有 codec/stream）——
    // 要显式认这一档，否则就是「点了没反应」。
    console.warn(`[mirror] 设备音频不可用（${meta?.type ?? "disabled"}），仅转发画面`);
    return false;
  }
  void pumpLoop(meta.stream, (packet) => audioSink?.(packet), null);
  return true;
}

/** 收掉本窗口承载的音频会话（关窗 / 页面卸载 / 让位给别的窗口）。 */
function stopAudioCompanion() {
  const companion = audioCompanion;
  audioCompanion = null;
  audioHostWanted = false;
  // 正在建的那条不在这里等：它建完会自己发现 `wantsAudioCompanion()` 已经是假，当场把会话收掉。
  if (companion) void companion.client?.close?.().catch?.(() => {});
}

/** 关闭当前 scrcpy client（窗口 beforeunload / 主进程 stop 时调用）。 */
export function stopSession() {
  current.stopping = true;
  // 音频那条会话要**先**收掉：Android 上并发采集是互相破坏的，晚一步会让接手那条哑掉。
  stopAudioCompanion();
  // Mac 键盘那条桥挂在 adb 上，会话收摊时一起断（归属由主进程在最后一个会话关掉时还原）。
  syncMacKeyboard(null);
  if (current.resizeObserver) {
    current.resizeObserver.disconnect();
    current.resizeObserver = null;
  }
  if (current.follower) {
    current.follower.dispose();
    current.follower = null;
  }
  if (current.stopStolenWatch) {
    current.stopStolenWatch();
    current.stopStolenWatch = null;
  }
  if (current.sleepWatch) {
    current.sleepWatch.stop();
    current.sleepWatch = null;
  }
  // 虚拟显示随会话一起销毁，设备侧不留任何残留状态。
  if (!current.client) return null;
  const closing = current.client.close?.().catch?.(() => {}) ?? null;
  current.client = null;
  current.info = null;
  // 下一块显示的 id 跟这块无关，留着会让「接回」把自己跟旧显示比。
  current.displayId = null;
  return closing;
}

// ---------------------------------------------------------------------------
// 镜像页接入层：
// - 启动参数通过 invoke 拉取（避免 did-finish-load 时序竞态）
// - 视频包直接写 WebCodecs 解码器，音频包直接送 Opus 播放器
// - 输入控制直接写本进程的 control socket（不经过主进程）
// ---------------------------------------------------------------------------

let player = null;

// 关窗时收摊。注册一次就够：`bootstrap()` 可以重复调用（「接回画面」），
// 挂在它里面会让接管路径每接一次多一份监听。`stopSession()` 自身幂等。
window.addEventListener("beforeunload", () => stopSession());

/**
 * 主进程推来的「这台设备的音频会话改由你承载」（`mirror:audioHost`）—— 原来那条窗口关掉了。
 *
 * **在模块求值时就注册**（不放在 `bootstrap` 里）：主进程是在原宿主窗口 `closed` 之后才发的，
 * 而窗口刚开出来、`bootstrap` 还在路上时也可能撞上；`mirror:initGet` 那一侧会返回**当时的**
 * `audioHost`（主进程先改位再发），所以漏掉这一条也不会真的没声音，这里只是把它做成即时生效。
 * 会话还没起来时 `ensureAudioCompanion()` 会空转，`startSession` 结尾按 `audioHostWanted` 补一次。
 */
{
  const renderer = ipc();
  renderer?.on?.(CHANNELS.mirrorAudioHost, () => {
    audioHostWanted = true;
    void ensureAudioCompanion().catch((error) => {
      console.warn("[mirror] 接管设备音频失败：", error?.message || error);
      audioIssueSink?.(`设备音频不可用：${error?.message || error}`);
    });
  });
}

/**
 * 主进程推来的「进/出 macOS 全屏」（`mirror:fullscreen`）。页面据此换排法：那一屏里长条不再占窗口宽度。
 * 初值直接取启动参数里的 `prefs.fullscreen` —— 「全屏启动」那档一开就是全屏，等第一个事件会晚一拍
 * （长条先按常态排一遍再跳，看着闪一下）。
 * `bootstrap()` 可以重复调用（「接回画面」），所以每次都先把上一份监听摘掉。
 */
let stopFullscreenWatch = null;
function watchFullscreen(onFullscreen, initial) {
  stopFullscreenWatch?.();
  const renderer = ipc();
  if (!renderer) return;
  const listener = (_event, value) => onFullscreen?.(value === true);
  renderer.on(CHANNELS.mirrorFullscreen, listener);
  stopFullscreenWatch = () => renderer.removeListener(CHANNELS.mirrorFullscreen, listener);
  onFullscreen?.(initial === true);
}

/**
 * App.vue 启动入口：拉取启动参数 → 认领应用归属 → 建立直连会话 → 帧数据送解码管线。
 * 可以重复调用（被顶掉后点「接回」就是再来一次，这次换成我们顶掉别人）。
 * @param {{
 *   video: (packet) => Promise<void> | void,
 *   audio: (packet) => void,
 *   audioStats: (stats: Record<string, number>) => void,
 *   hooks: { onMeta?: (meta) => void, onAudioError?: (message: string) => void,
 *            onReflowStart?: (size) => void, onReflowAbort?: () => void,
 *            onReflowSent?: () => void,
 *            onStolen?: (stolen) => void, onSleepChange?: (asleep, state) => void,
 *            onFullscreen?: (fullscreen: boolean) => void },
 * }} apply App 侧管线接线
 */
export async function bootstrap(apply) {
  const info = await ipcInvoke(CHANNELS.mirrorInitGet);
  if (!info) throw new Error("镜像启动参数缺失");
  window.__anddriveMirrorId = info.id;
  watchFullscreen(apply.hooks.onFullscreen, info.prefs?.fullscreen);

  player = createOpusPlayer({
    onStats: (stats) => apply.audioStats?.(stats),
    onError: (message) => apply.hooks.onAudioError?.(String(message)),
  });
  // 音频出口在这里落地（会话那两条路都往它送包）：主会话那条已经不带音频，
  // 只有设备级音频会话（本窗口是宿主时）会调它。HUD 的「收到包」计数与 Opus 播放器是同一份接线。
  audioSink = (packet) => {
    apply.audio?.(packet);
    player?.push(packet);
  };
  audioIssueSink = (message) => apply.hooks.onAudioError?.(String(message));

  return startSession(info, {
    onVideoPacket: apply.video,
    onMeta: (meta) => apply.hooks.onMeta?.(meta),
    onReflowStart: (size) => apply.hooks.onReflowStart?.(size),
    onReflowAbort: () => apply.hooks.onReflowAbort?.(),
    onReflowSent: () => apply.hooks.onReflowSent?.(),
    onStolen: (stolen) => apply.hooks.onStolen?.(stolen),
    onSleepChange: (asleep, state) => apply.hooks.onSleepChange?.(asleep, state),
    onEnded: (detail) => {
      // server 端自发退出（设备断开 / server 异常）。
      if (!window.__anddriveMirrorId) return;
      ipc().send(CHANNELS.mirrorState, {
        id: info.id,
        kind: "exit",
        message: `scrcpy 服务意外退出，镜像已结束${detail ? `：${detail}` : ""}`,
      });
      window.close();
    },
  });
}

/** 触控 / 键盘 → 直接写本进程内的 control socket。 */
export function sendControl(message) {
  const controller = getController();
  if (!controller) return;
  void applyControl(controller, message).catch((error) => {
    console.warn(`[mirror] 控制消息失败（${message?.kind}）：`, error?.message || error);
  });
}

/**
 * 关屏使用 / 恢复亮屏（`setDisplayPower`）。**要等结果、失败要抛** —— 这是用户点按钮的直接后果，
 * 静默失败等于按钮没反应（同「点『继续使用』唤醒失败要说清为什么」那条）。
 * @param {boolean} on true = 恢复亮屏（回系统默认），false = 关屏
 */
export async function setScreenPower(on) {
  const controller = getController();
  if (!controller) throw new Error("镜像还没连上");
  await applyControl(controller, { kind: "screen", on });
}

/**
 * 让电源状态**立刻重读一次并快轮询一阵**（用户 10-10「已休眠、点继续使用不灵敏」：
 * 原来只有慢轮询，点了按钮要等下一拍才撤）。
 * 用的三个时刻：点了「继续使用」、点了「关屏使用 / 恢复亮屏」、长条刚被唤出来。
 */
export function kickSleepWatch() {
  current.sleepWatch?.kick();
}

/** 卸载/关窗：释放播放器与 scrcpy client。 */
export function dispose() {
  player?.dispose();
  player = null;
  window.__anddriveMirrorId = null;
  return stopSession();
}
