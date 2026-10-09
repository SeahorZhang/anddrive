import { CHANNELS } from "../../electron/ipcContract.js";
import { getServerClient, acquireDeviceAdb, startScrcpy, codecName } from "./connect.js";
import { computeDisplayMetrics, scaleDisplayDpi } from "../../shared/scrcpyConfig.js";
import { createDisplayFollower } from "./displayFollow.js";
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
  resizeObserver: null,
  follower: null,
  stopping: false,
  /** 本会话虚拟显示的 id（从 server stdout 里解析），未拿到为 null。 */
  displayId: null,
  /** 「应用被别的显示拿走」轮询的停止函数。 */
  stopStolenWatch: null,
};

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
 *   onAudioPacket: (packet: unknown) => void,
 *   onEnded: () => void,
 *   onReflowStart?: (size: { width: number, height: number }) => void,
 *   onReflowAbort?: () => void,
 *   onReflowSent?: () => void,
 *   onStolen?: (stolen: boolean) => void,
 * }} handlers
 */
export async function startSession(
  info,
  { onMeta, onVideoPacket, onAudioPacket, onEnded, onReflowStart, onReflowAbort, onReflowSent, onStolen },
) {
  current.info = info;
  const adb = await acquireDeviceAdb(getServerClient(), info.serial);
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

  // 音频失败只降级为纯画面（scrcpy 4.0 仅支持 Opus）。
  let audioConfigured = false;
  try {
    const audioMeta = await client.audioStream;
    if (audioMeta?.type === "success") {
      void pumpLoop(audioMeta.stream, onAudioPacket, null);
      audioConfigured = true;
    } else {
      console.warn(`[mirror] 设备音频不可用（${audioMeta?.type ?? "disabled"}），仅转发画面`);
    }
  } catch (error) {
    console.warn("[mirror] 设备音频不可用：", error?.message || error);
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

/** 关闭当前 scrcpy client（窗口 beforeunload / 主进程 stop 时调用）。 */
export function stopSession() {
  current.stopping = true;
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
 * App.vue 启动入口：拉取启动参数 → 认领应用归属 → 建立直连会话 → 帧数据送解码管线。
 * 可以重复调用（被顶掉后点「接回」就是再来一次，这次换成我们顶掉别人）。
 * @param {{
 *   video: (packet) => Promise<void> | void,
 *   audio: (packet) => void,
 *   audioStats: (stats: Record<string, number>) => void,
 *   hooks: { onMeta?: (meta) => void, onAudioError?: (message: string) => void,
 *            onReflowStart?: (size) => void, onReflowAbort?: () => void,
 *            onReflowSent?: () => void,
 *            onStolen?: (stolen) => void },
 * }} apply App 侧管线接线
 */
export async function bootstrap(apply) {
  const info = await ipcInvoke(CHANNELS.mirrorInitGet);
  if (!info) throw new Error("镜像启动参数缺失");
  window.__anddriveMirrorId = info.id;

  player = createOpusPlayer({
    onStats: (stats) => apply.audioStats?.(stats),
    onError: (message) => apply.hooks.onAudioError?.(String(message)),
  });

  return startSession(info, {
    onVideoPacket: apply.video,
    onAudioPacket: (packet) => {
      apply.audio?.(packet);
      player.push(packet);
    },
    onMeta: (meta) => apply.hooks.onMeta?.(meta),
    onReflowStart: (size) => apply.hooks.onReflowStart?.(size),
    onReflowAbort: () => apply.hooks.onReflowAbort?.(),
    onReflowSent: () => apply.hooks.onReflowSent?.(),
    onStolen: (stolen) => apply.hooks.onStolen?.(stolen),
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

/** 卸载/关窗：释放播放器与 scrcpy client。 */
export function dispose() {
  player?.dispose();
  player = null;
  window.__anddriveMirrorId = null;
  return stopSession();
}
