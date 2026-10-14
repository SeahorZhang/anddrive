import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { CHANNELS } from "../ipcContract.js";
import {
  deviceDisplayName,
  ensureServer,
  getCachedApps,
  getDeviceSdk,
  getDeviceVideoCodecs,
  getForegroundApp,
  getGlobalNumberSetting,
  getPhysicalScreenSize,
  getPhysicalScreenDensity,
  getSecureSetting,
  goHome,
  isMiuiDevice,
  onDeviceTeardown,
  runDeviceShell,
  scrcpyServerPath,
  setGlobalNumberSetting,
  setSecureSetting,
} from "../adb.js";
import { sanitizeIcon } from "../iconImage.js";
import { isValidPackageName, isValidSerial } from "../validators.js";
import { findAppSession } from "./appSession.js";
import { pickAudioHost } from "./audioHost.js";
import { startKeepAwake } from "./keepAwake.js";
import { BRIDGE_SOCKET, createMacKeyboard, SETTING_DEFAULT_IME } from "./macKeyboard.js";
import { startMiProjection } from "./miProjection.js";
import {
  mirrorAspectRatio,
  mirrorContentExtraSize,
  mirrorRailFloats,
  mirrorTrafficLightPosition,
  mirrorScreenInsets,
  mirrorWindowBounds,
  mirrorsMainDisplay,
  resolveRuntimePrefs,
  supportsDesktopMode,
} from "./options.js";

// ---------------------------------------------------------------------------
// 自研镜像会话（mirror，渲染层直连形态）
//
// 主进程只负责：创建镜像窗口（nodeIntegration 直连）、提供启动参数（渲染层
// invoke 拉取）、维护会话记录（渲染层 ready/exit 时上报）以及断开设备 /
// 退出时的销毁。
// adb 连接（官方 @yume-chan/adb-server-node-tcp）、scrcpy 会话、解码与
// 输入控制在渲染层内完成：帧数据不再经过主进程的任何一层。
// ---------------------------------------------------------------------------

/** @type {Map<string, MirrorSession>} */
const sessions = new Map();
let sessionSeq = 0;

/**
 * @typedef {object} MirrorSession
 * @property {string} id
 * @property {string} serial
 * @property {string} packageName
 * @property {string} label
 * @property {number} startedAt
 * @property {number | null} codec
 * @property {string | null} codecName
 * @property {boolean} hasAudio
 * @property {boolean} audioEnabled 设置页那一项「声音输出」开着没有（关掉时这台设备谁都不承载音频）
 * @property {boolean} audioHost 本窗口是不是这台设备**唯一那条音频会话**的承载者（见 `audioHost.js`）
 * @property {import("electron").BrowserWindow | null} win
 * @property {Record<string, unknown> | null} pendingInit
 * @property {(() => Promise<void>) | null} miProjectionRestore
 * @property {(() => Promise<void>) | null} keepAwakeRestore
 * @property {boolean} returnsHome 关会话时要不要把手机放回桌面（见 `stopMirrorSession`）
 */

function loadMirrorPage(win) {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) return win.loadURL(`${devServer}/mirror.html`);
  return win.loadFile(path.join(process.env.APP_ROOT, "dist", "mirror.html"));
}

function preloadPath() {
  return path.join(process.env.APP_ROOT, "dist-electron/preload.mjs");
}

/**
 * 每扇镜像窗口锁定的**画面比例**（0 = 读不到设备比例，不锁）。
 * dev 调试边栏会把窗口撑宽一截不参与比例的余量，所以那一格开合时要按新余量重设一次。
 */
const aspectRatios = new WeakMap();

/**
 * 每扇镜像窗口右侧那条操作栏现在**浮在画面里没有**（用户 2026-10-14）。
 * 建窗口时按 `mirrorRailFloats` 定一次，之后由渲染层实时上报（`mirror:railFloat`）——
 * 形态决定右边那一截余量（浮起来少一条长条宽），所以每次翻转都要重设一次比例锁。
 */
const railFloatingStates = new WeakMap();

function createMirrorWindow(session, prefs, bounds, ratio, railFloating) {
  const win = new BrowserWindow({
    // 标题栏文字（渲染层那份从 `pendingInit` 组，两边同一个式子）。
    title: session.windowTitle || session.label || session.packageName,
    // 初始形状跟设备屏幕一致（用户 2026-09-19 要求）：pad 状态下的 app 在竖形显示上排双列、
    // 横形显示上排宽布局，两种都铺满整帧，所以窗口照手机比例开也不会有黑边。
    width: bounds.width,
    height: bounds.height,
    minWidth: 280,
    minHeight: 280,
    titleBarStyle: "hiddenInset",
    // 三颗彩虹键钉进**顶部那条标题栏**（用户 2026-10-12：「试试 a 的变体，上边加一条专门放三个按钮和
    // app 名称」；10-11 那条「恢复默认，不要有任何修改」到此为止）。落点与窗口宽无关 ⇒ `resize` 里
    // 什么都不用做（10-10 把它们贴进右侧长条时，落点 = 窗口宽 − 长条宽 + 内缩，每次改大小都得重算，
    // 漏一次就留在旧位置 —— 那条坑这次从根上没有了）。**显隐照样不碰**：常驻，不跟长条 hover 走。
    // 三颗彩虹键的落点**分两档形态**（用户 2026-10-14 第四条）：窗口态钉在顶部标题栏里垂直居中；
    // 长条浮起来那一档标题栏整条不存在、窗口顶就是画面顶 ⇒ 落点要让开画面的圆角（见 `options.js`
    // 的 `floatLightX/Y`）。两档都与窗口宽无关 ⇒ `resize` 里什么都不用做；**翻转形态时要重设一次**
    // （`mirror:windowButtons` 那条）。**显隐照样不碰**：窗口态跟 chrome 显隐、浮动态常驻。
    trafficLightPosition: mirrorTrafficLightPosition(railFloating),
    // **本体仍然透明**（2026-10-09 定稿，10-12 一度照竞品改成不透明浅灰窗，当天被否：
    // 「竞品是鼠标移到边框上才那个样子，没移上去就是个手机样子」）⇒ 那层灰底是**涂装**，
    // 由渲染层跟着长条的 hover 显隐（`.mirror-window.is-chrome`），窗口本体一个字节不改。
    transparent: true,
    backgroundColor: "#00000000",
    // ⚠️ **别加 `roundedCorners: false`**（10-12 试过一整轮）：它确实能把窗口四角的系统圆角去掉、
    // 让渲染层那层浅灰铺到角上，但**同一刻 macOS 那三颗彩虹键整组不画了**（他当场报「mac的三个彩虹按钮没了」）
    // —— 那圈窗角与 AppKit 画标准按钮用的是同一套窗口外形，去掉圆角把按钮也带走了。
    // 想要"边框有圆角 + 三颗在"就别动这个开关：**系统那圈圆角留着，chrome 两条臂自己不再写 `border-radius`**
    // （写了就是在系统那圈里面再挖一圈，中间露出一条桌面 = 他说的「丑丑的黑色」）。
    show: false,
    alwaysOnTop: prefs.alwaysOnTop,
    // 真·全屏（macOS 那个独立 Space）：这种全屏里红绿灯连标题栏一起归系统（顶边才浮出），
    // 我们不去动它（10-11 实测四种救法像素扫描命中数全 0，而且现在压根不定制）。
    // 用户 10-11 明确「我要的是全屏，不是放大按钮」⇒ 保真全屏；
    // 试过的 `fullscreenable: false` + `maximize()`（zoom 撑满）已回退 —— 那只是最大化，不是全屏。
    // 另一条老坑仍在：构造参数传 `fullscreen:true` + `show:false` 常常进不去 ⇒ 靠 show 之后再调。
    fullscreenable: true,
    // 直连形态：Video/Control/audio 在渲染层直连 adb，需要 node 的 ipc 与
    // 同源 socket；自定义页面无第三方内容，安全边界等同于主进程代码。
    webPreferences: {
      preload: preloadPath(),
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });
  // 见上面 `ratio` 那条：采主屏那档按手机比例锁，桌面模式那档给 0 = 不锁（可自定义拖宽高）。
  // 锁用的是上游 `setAspectRatio`（= AppKit 的 `contentAspectRatio`，拖哪条边都系统自己锁），
  // 锁的是**画面那块矩形**：窗口比它多出的黑框与右边长条走 `extraSize` 那参数。
  // 长条浮在画面里时右边那一截不算余量（那 86px 已经归画面了），余量随形态走，见 `railFloatingStates`。
  aspectRatios.set(win, ratio);
  railFloatingStates.set(win, railFloating === true);
  if (ratio) win.setAspectRatio?.(ratio, mirrorContentExtraSize(0, railFloating));
  win.once("ready-to-show", () => {
    win.show();
    // 「全屏启动」在 show 之后落地（构造参数那条路在 macOS 上不可靠，见上面 `fullscreenable` 的注释）。
    if (prefs.fullscreen) win.setFullScreen(true);
  });
  // 全屏那一屏要单独一种排法：手机得在整块屏幕正中，而常态那 86px 长条是从窗口右边
  // **挖走一块宽度**的 ⇒ 画面会偏左。把状态推给渲染层，它那一档让长条常驻、画面收成手机那块。
  // 初值不用推：页面自己从 `pendingInit.prefs.fullscreen` 读（「全屏启动」那条开关）。
  win.on("enter-full-screen", () => win.webContents.send(CHANNELS.mirrorFullscreen, true));
  win.on("leave-full-screen", () => win.webContents.send(CHANNELS.mirrorFullscreen, false));
  // 三颗彩虹键**平时藏起来**（本体透明时它们会浮在桌面上，「就是个手机样子」当场破功）；
  // 鼠标贴边、那层灰底 chrome 显形时由渲染层放出来。落点与窗口宽无关 ⇒ 放出来之后补一次设位
  // 就够了（`setWindowButtonVisibility(true)` 会把三颗打回 AppKit 默认的左上角，10-10 探针实测）。
  win.setWindowButtonVisibility?.(false);
  void loadMirrorPage(win);
  win.on("closed", () => void stopMirrorSession(session.id));

  // DevTools 对视频窗口性能影响很大，默认不自动打开，需要时用环境变量开启。
  if (process.env.ANDRIVE_MIRROR_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }
  return win;
}

function snapshot(session) {
  return {
    id: session.id,
    serial: session.serial,
    packageName: session.packageName,
    label: session.label,
    startedAt: session.startedAt,
    codec: session.codec ?? 0,
    codecName: session.codecName ?? "unknown",
    hasAudio: session.hasAudio ?? false,
  };
}

/**
 * 这台设备**当前**该由哪个窗口承载那条唯一的音频会话（没有候选就返回 null）。
 *
 * 候选 = 同一台设备、设置页开着「声音输出」、且还活着的会话。选举规则见 `audioHost.js`：
 * 固定挑**最早打开**的那一个 —— 判据只看当前活着的集合，主进程与渲染层算的是同一件事。
 * @param {string} serial
 */
function audioHostFor(serial) {
  return pickAudioHost(
    [...sessions.values()]
      .filter((item) => item.serial === serial && item.audioEnabled === true)
      .map((item) => ({ id: item.id, startedAt: item.startedAt })),
  );
}

/**
 * 通知某个窗口「这台设备的音频会话改由你承载」。
 *
 * ⚠️ **顺序要紧**：调用方必须在原来那条窗口 `closed` **之后**才发这一条（见 `stopMirrorSession`）
 * —— Android 上并发采集是互相破坏的，接手那条要是抢在原采集释放之前起来，两边都会哑。
 * 渲染层那条监听在模块求值时就注册好了（早于 `bootstrap`），页面还在加载时漏掉的这一条也有兜底：
 * `mirror:initGet` 返回的是**当时**的 `audioHost`（`startMirrorSession` 已把位改过），不是建窗时那份。
 */
function notifyAudioHost(session) {
  const wc = session.win?.webContents;
  if (!wc || wc.isDestroyed?.() === true) return;
  if (wc.isLoading?.() === true) {
    wc.once("did-finish-load", () => {
      if (wc.isDestroyed?.() !== true) wc.send(CHANNELS.mirrorAudioHost);
    });
    return;
  }
  wc.send(CHANNELS.mirrorAudioHost);
}

/**
 * 承载音频的那个窗口关掉了：把这一位交给这台设备下一个幸存者；没有就什么都不做（自然收摊）。
 *
 * 为什么不在 `stopMirrorSession` 里直接发：那条窗口此刻还在跑自己的音频会话，
 * 接手那条一开就是**两条采集并存**（Android 上会互相破坏，见 `options.js` 那条实测）。
 *
 * 两条路都要覆盖，而**生产走的是第一条**：
 * - **关窗**（用户点红点 / ⌘W）：`closed` 的处理器里调 `stopMirrorSession`（见 `createMirrorWindow`
 *   里那行 `win.on("closed", …)`），那一刻窗口已经销毁 ⇒ 上面 `isDestroyed()` 那条早退**当场交接**。
 *   ⚠️ **这条路上不能再等 `closed`**：我们正处在 `closed` 的派发途中，EventEmitter 对本次 emit
 *   用的是监听器快照，`win.once("closed", hand)` 对这一次**永远不会触发**（去掉那条早退，
 *   交接就只剩 1.5s 兜底定时器 —— `tests/electron/mirrorSession.test.js` 有一条钉着它）。
 *   交得早不要紧：接手那边起采集前会问 `mirror:audioIdle`，由设备侧那条采集**真的放开**把关。
 * - **窗口还活着**（断开设备 / 菜单退出 / `mirrorStop`）：这时才需要真的等 `closed`，
 *   否则两条采集会并存；窗口卡住关不掉时兜一条定时器，别把音频永远吊着。
 * @param {MirrorSession} gone
 */
function handOffAudioHost(gone) {
  const serial = gone.serial;
  let handed = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let fallback = null;
  const hand = () => {
    if (handed) return;
    handed = true;
    if (fallback) clearTimeout(fallback);
    // ⚠️ 在这里现算，不用关窗那一刻的结果：这中间可能已经有新窗口开出来了，
    // 而它按 `startMirrorSession` 的选举本来就是宿主 —— 那时这一条只是幂等确认。
    const nextId = audioHostFor(serial);
    const next = nextId ? sessions.get(nextId) : null;
    if (!next) return;
    next.audioHost = true;
    notifyAudioHost(next);
  };
  const win = gone.win;
  if (!win || win.isDestroyed?.() === true) {
    hand();
    return;
  }
  win.once("closed", hand);
  // 兜底：`beforeunload` 里卡住（或窗口已经不在了但没派发 `closed`）时也不能把音频永远吊着。
  fallback = setTimeout(hand, AUDIO_HANDOFF_FALLBACK_MS);
  fallback?.unref?.();
}

/** 移交的兜底时限：关窗正常是几十毫秒，超过这个数就当它已经走了。 */
const AUDIO_HANDOFF_FALLBACK_MS = 1500;

/**
 * 设备侧那条 `REMOTE_SUBMIX` 采集的探针。
 * `Devices: {AUDIO_DEVICE_OUT_REMOTE_SUBMIX` 只在**采集生效**时出现在 `Outputs` 段
 * （`Audio Patches` 那一段里的同名字符串是静态配置，一直在，所以必须带上 `Devices: {` 前缀）。
 * `grep -c` 没匹配时回 `0` 但退出码是 1 —— 所以判据只看 stdout 里的数字，不看 `ok`。
 */
const AUDIO_CAPTURE_PROBE =
  "dumpsys media.audio_policy | grep -c 'Devices: {AUDIO_DEVICE_OUT_REMOTE_SUBMIX'";
/** 等采集释放的上限与轮询间隔（真机实测释放稳定在 ~1.3s）。 */
const AUDIO_RELEASE_TIMEOUT_MS = 4000;
const AUDIO_RELEASE_POLL_MS = 350;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等设备侧那条采集真的拆掉；返回 true = 现在可以起新采集。
 *
 * **为什么必须等**：Android 只有一条 `AUDIO_DEVICE_OUT_REMOTE_SUBMIX`，而释放**不是瞬时的** ——
 * 真机实测（Mi 10 / 随包 5.0.1）稳定在 1.24~1.30s。这期间新采集要是已经起来了，就是
 * 「两条并存 → 旧的那条被释放 → 新的那条从此静音」：实测「反序」那次新会话一直在收包（461 个），
 * 但设备侧 `Outputs` 从 9 掉回 7、`Devices:` 不再指向 `REMOTE_SUBMIX` ——
 * **声音回到手机、包照收**，正是用户 2026-10-14 报的那个症状。
 *
 * 读不到（设备断开 / 探测失败）就当已经放开：宁可试一次，也不要永远不出声。
 * @param {string} serial
 */
async function waitAudioCaptureReleased(serial) {
  const until = Date.now() + AUDIO_RELEASE_TIMEOUT_MS;
  for (;;) {
    const { stdout } = await runDeviceShell(serial, AUDIO_CAPTURE_PROBE).catch(() => ({ stdout: "" }));
    const active = Number.parseInt(String(stdout ?? "").trim(), 10);
    if (!Number.isFinite(active) || active <= 0) return true;
    if (Date.now() >= until) return false;
    await sleep(AUDIO_RELEASE_POLL_MS);
  }
}

/** 会话被用户 / 断开流程之外的意外退出时，通知主窗口。 */
function notifyExit(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win === payload.win) continue;
    win.webContents.send(CHANNELS.mirrorExit, {
      id: payload.id,
      label: payload.label,
      packageName: payload.packageName,
      message: payload.message || "scrcpy 服务意外退出，镜像已结束",
    });
  }
}

/**
 * 启动一个原生镜像窗口；连接/解码由渲染层完成，主进程轻手笔画。
 * 同一台设备上的同一个应用只开一个窗口：已经有了就把它唤到前台（见 `appSession.js`）。
 *
 * **采主屏、不建虚拟显示（`pendingInit.deviceMirror`）有两档**：
 * - **`packageName` 留空 = 整机镜像**（顶栏「镜像手机」）。
 * - **Android 13 及以下点应用**（`mirrorsMainDisplay`）：照样带着包名，但 app 是**在手机屏幕上打开**的
 *   （`startApp` 那条控制消息在没有新建显示时落到 `display_id` 的缺省值 0 = 主屏），窗口看到的是整台手机。
 *
 * 这一档没有「这块显示上的应用」概念：「接回画面」与「跟随窗口」整块跳过，用的也是**官方那份 server**
 * （补丁产物的效果只作用于新建显示）。
 * @param {{ serial: string, packageName?: string, label?: string, config?: unknown,
 *           iconUrl?: string }} request
 */
export async function startMirrorSession(request) {
  const serial = typeof request?.serial === "string" ? request.serial.trim() : "";
  const packageName = typeof request?.packageName === "string" ? request.packageName.trim() : "";
  const wholeDevice = !packageName;
  if (!isValidSerial(serial)) throw new Error("设备序列号无效");
  if (!wholeDevice && !isValidPackageName(packageName)) throw new Error("应用包名无效");
  const label =
    (typeof request?.label === "string" && request.label.trim()) || (wholeDevice ? "手机镜像" : packageName);

  const existing = findAppSession(sessions.values(), { serial, packageName });
  if (existing) {
    // 虚拟显示那条路再开一块会把应用从旧显示上搬走（旧窗口只剩启动器）；主屏那条路两个窗口
    // 只是同一条画面的两份拷贝。所以这里直接复用。
    try {
      focusMirrorSession(existing.id);
      return { ...snapshot(existing), reused: true };
    } catch {
      // 窗口已经没了但记录还在（关窗事件还没跑完）：往下正常新建。
    }
  }

  await ensureServer();
  const prefs = resolveRuntimePrefs(request?.config);
  // 窗口照**设备画面比例**开：默认模式的虚拟显示尺寸就取自窗口画面区的物理像素，
  // 窗口形状不对会开出一块错比例的显示（横窗 → 横显示 → 竖屏 app 直接换版式）。
  // 密度也取自设备（`wm density`）：flex 显示必须同时带密度（上游 `NewDisplayCapture.prepare()`
  // 对 `dpi == 0` 的 flex 直接断言），渲染层按主屏长边等比换算它。
  // 任一处读不到就退回既有的 850x600，且渲染层不给显示尺寸（`new_display` 退空串、不开 flex）。
  // 版本（API 级别）决定两件事：点应用要不要改走主屏镜像，以及要不要 keepAwake。
  // 与读分辨率/密度并列，不多等一个来回。
  // 设备展示名也在这里一起拿：标题栏要写「日历 - Mi 10」那种「app - 设备名」（对照竞品，用户 10-12）。
  // 它在 adb.js 里按 serial 缓存，所以开窗之后每次都是零成本。
  const [screenSize, screenDpi, sdk, deviceName] = await Promise.all([
    getPhysicalScreenSize(serial).catch(() => null),
    getPhysicalScreenDensity(serial).catch(() => null),
    getDeviceSdk(serial).catch(() => null),
    deviceDisplayName(serial).catch(() => null),
  ]);
  const deviceMirror = wholeDevice || mirrorsMainDisplay(sdk);
  const serverPath = scrcpyServerPath(deviceMirror ? { largeScreenDisplay: false } : undefined);
  const workArea = screen.getPrimaryDisplay().workArea;
  // 长条摆在哪（用户 2026-10-14：「投屏宽度足够宽就改成全屏那种浮在画面里的样子」）：
  // **建窗口时先算一次**，之后由渲染层实时跟着窗口宽改（`mirror:railFloat`）。
  // 判据全项目只有一处（`mirrorRailFloats`），`previous = false` 就是「长条在外面」那套几何 ——
  // 窗口刚开出来正是这个形态，所以这一步与渲染层第一拍量出来的结论同源同值。
  const baseBounds = mirrorWindowBounds(screenSize, workArea);
  const baseInsets = mirrorScreenInsets();
  const railFloating = mirrorRailFloats(baseBounds.width - baseInsets.left - baseInsets.right);
  // 浮起来之后右边那条 86px 归画面 ⇒ 按新内缩重 fit 一次（同一个 `screenSize` / `workArea`）。
  // 窗口不会因此变大：宽不够（横形显示）时是画面吃掉这 86px，宽够（竖形显示）时窗口跟着窄 86px。
  const bounds = railFloating ? mirrorWindowBounds(screenSize, workArea, true) : baseBounds;
  const insets = mirrorScreenInsets(railFloating);
  // 拖拽锁比例用的画面比例：与上面的初始尺寸同源（同一个 `screenSize`），两处各读一次会打架。
  // ⚠️ **只有采主屏那一档锁**（整机镜像、13 及以下点应用）：那块屏的形状归手机，窗口拖成别的比例
  // 只会露黑边或裁切（用户 10-11：「不可以随意更改，只能按手机比例拖拽宽度和高度」）。
  // **桌面模式那档不锁**（用户 10-11 追一条：「桌面模式宽度高度可以自定义拖拽」）：那是我们自己建的
  // flex 显示，画面区一变就走 `resizeDisplay`（见 `src/mirror/direct-session.js` 的 follower），
  // 拖成什么形状设备就重排出什么形状 —— 锁住反而做不成"桌面窗口"。0 = 不锁（上游那档取消）。
  const ratio = deviceMirror ? mirrorAspectRatio(screenSize) : 0;
  // 设备能编码哪些：给镜像页落地 `auto`，也顺带进 pendingInit（渲染层不再自己查）。
  const deviceEncoders = await getDeviceVideoCodecs(serial).catch(() => null);

  /** @type {MirrorSession} */
  const windowTitle = deviceName ? `${label} - ${deviceName}` : label;
  // 这台设备那条**唯一的**音频会话归谁（用户 2026-10-14 第三条）：同一台设备同时只允许一条采集，
  // 所以由**最早打开的那个窗口**承载。此刻 `sessions` 里还没有本会话 ⇒ 这台设备没别的窗口时
  // 算出来的就是「我自己」。关窗时由 `handOffAudioHost` 交出去。
  const audioEnabled = prefs.audio === true;
  const audioHost = audioEnabled && audioHostFor(serial) === null;
  /** @type {MirrorSession} */
  const session = {
    id: `mirror-${++sessionSeq}`,
    serial,
    packageName,
    label,
    // 「app - 设备名」：设备名读不到时只留 app 名，不留 " - "。
    windowTitle,
    startedAt: Date.now(),
    codec: null,
    codecName: null,
    hasAudio: false,
    audioEnabled,
    audioHost,
    win: null,
    pendingInit: null,
    miProjectionRestore: null,
    keepAwakeRestore: null,
    // 「采主屏 + 带着包名」= 这个 app 是我们 `startApp` 到手机屏幕上去的（Android 13 及以下那档），
    // 关掉窗口就该把它放回桌面。虚拟显示那档不动手机（app 在我们那块显示上，会话结束显示就没了）；
    // 整机镜像没有「我们打开的 app」，所以也不动。
    returnsHome: !wholeDevice && mirrorsMainDisplay(sdk),
  };
  sessions.set(session.id, session);

  try {
    session.win = createMirrorWindow(session, prefs, bounds, ratio, railFloating);
  } catch (error) {
    sessions.delete(session.id);
    throw error;
  }

  // 页面主动 invoke 拉取启动参数（避免 did-finish-load 时序竞态）。
  // `initialCss` = **画面那块矩形**（窗口内容区减掉那圈常驻黑框，见 `MIRROR_FRAME`）的尺寸：
  // 渲染层拿它算第一块虚拟显示。黑框只有 6px，但它占着布局，所以不能整窗内容区直接给。
  // 不能让它读 DOM —— 深链冷启动时页面还没排版完，`clientWidth` 会读到 Electron 默认的 512x512，
  // 于是开出一块和窗口完全不符的显示（2026-09-28 实测）。
  // ⚠️ 这里的 `insets` 与上面算窗口尺寸、比例锁用的是**同一份**（含长条浮没浮那一档）。
  const content = session.win.getContentBounds();
  session.pendingInit = {
    id: session.id,
    serial,
    label,
    // 标题栏那行文字（`app - 设备名`）：主进程的窗口标题与渲染层画的那行**必须同一个式子**，
    // 否则两处会漂（Dock / 窗口列表读的是原生标题，屏上读的是我们画的）。
    windowTitle,
    deviceName,
    packageName,
    // 采主屏的判据在这里定一次：渲染层拿它跳过「接回画面」与「跟随窗口」
    // （那些都需要一块我们建的虚拟显示，这一档没有）。`startApp` 不在其列 —— 带着包名时渲染层
    // 照发，服务端把它开到主屏（= 手机屏幕）上，这一档要的正是「手机上打开这个 app，我们看着」。
    deviceMirror,
    // 悬浮栏那颗「桌面模式」该不该出（用户 2026-10-11 点单）。两个条件：
    // - 这是**采主屏**的会话（整机镜像）：虚拟显示那条路本身就是桌面模式，不需要这个入口。
    // - 设备 Android 14+：13 及以下建出来的显示拿不到焦点（`supportsDesktopMode`）。
    // 判据在主进程定一次，渲染层不重复判断 —— 同 `deviceMirror` 那条规矩。
    desktopModeAvailable: deviceMirror && supportsDesktopMode(sdk),
    serverPath,
    config: request?.config ?? null,
    prefs,
    // 这个窗口是不是这台设备**唯一那条音频会话**的承载者（渲染层据此决定要不要起那条会话）。
    // 与 `deviceMirror` 同一条规矩：判据在主进程定一次，渲染层不重复判断。
    audioHost,
    initialCss: {
      width: Math.max(1, content.width - insets.left - insets.right),
      height: Math.max(1, content.height - insets.top - insets.bottom),
    },
    // 设备画面比例（`wm size` 的 Physical）：渲染层据此决定要不要给虚拟显示尺寸 ——
    // 拿不到就不给，`new_display` 退空串走上游默认，不自己编一个比例。
    screenSize,
    // 设备物理密度（`wm density`）：flex 显示的密度由渲染层按长边等比换算，缺它就不开 flex。
    screenDpi,
    // 只把「能用的那几个」带给镜像页落地 auto；全量清单是设置页的事。
    deviceCodecs: deviceEncoders?.usable ?? null,
    // 图标随启动参数一起给：镜像页为「接回」横幅取一个图标，不该去读整台设备的
    // 图标缓存（`.adr` 冷启动那条路径缓存还没建，读了也是空）。渲染层会把它直接当
    // `<img>` 的 src，所以过一道 `sanitizeIcon`，非 PNG data URL 一律丢掉。
    iconUrl: sanitizeIcon(request?.iconUrl) ?? undefined,
  };

  // HyperOS 在息屏时会停止合成我们的采集显示（画面定住，机制见 `miProjection.js`）。
  // 我们不再主动动屏幕，但手机自己睡、用户按电源键都会撞上它，所以每个 MIUI 会话都登记
  // 「投屏中」，关会话时还原。
  void isMiuiDevice(serial)
    .then(async (miui) => {
      if (!miui) return;
      const restore = startMiProjection({ serial, put: setSecureSetting });
      if (sessions.has(session.id)) session.miProjectionRestore = restore;
      else await restore();
    })
    .catch(() => {});

  // Android 13 及以下那档采的是手机那块屏：**面板灭了就没帧可采**，而那个版本没有 HyperOS
  // 的 `Hangup` 门（灭屏仍合成），所以开会话时把「插电不休眠」打开、关会话时还原成它原来的值。
  // 判据与实测见 `keepAwake.js`；同样不等落地，因为置位必须赶在设备睡之前。
  if (mirrorsMainDisplay(sdk)) {
    void startKeepAwake({
      serial,
      read: (key) => getGlobalNumberSetting(serial, key),
      write: (key, mask) => setGlobalNumberSetting(serial, key, mask),
    })
      .then(async (restore) => {
        // 窗口已经关了（用户手快 / 建窗口就失败）：这次登记立即撤销，别把保活留在设备上。
        if (sessions.has(session.id)) session.keepAwakeRestore = restore;
        else await restore();
      })
      .catch(() => {});
  }

  return { id: session.id, serial, packageName, label, startedAt: session.startedAt };
}

/** @param {string} id */
export async function stopMirrorSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  // 这台设备那条唯一的音频会话要是挂在这个窗口上，就交给下一个幸存者（没有就自然收摊）。
  // 放在 `sessions.delete` 之后：选举只看**当前还活着的窗口**。真正发通知要等它关干净
  // （见 `handOffAudioHost`）—— 两条采集并存会让接手那条哑掉。
  if (session.audioHost) handOffAudioHost(session);
  // 两条设备侧登记都要还原（关窗 / 断开设备 / ⌘Q 都走这里）。
  const restoreMiProjection = session.miProjectionRestore;
  session.miProjectionRestore = null;
  if (restoreMiProjection) await restoreMiProjection().catch(() => {});
  const restoreKeepAwake = session.keepAwakeRestore;
  session.keepAwakeRestore = null;
  if (restoreKeepAwake) await restoreKeepAwake().catch(() => {});
  // Mac 键盘是设备级的：这台设备最后一个窗口关掉时才还原用户的输入法。
  await releaseMacKeyboard(session.serial);
  if (session.win && !session.win.isDestroyed()) {
    // 渲染层在 beforeunload 里停掉 scrcpy 会话；窗口关闭兜底。
    session.win.close();
  }
  // 这个 app 是我们 `startApp` 到手机屏幕上去的（13 及以下那档），窗口都关了就把手机放回桌面，
  // 别让它停在一个没人看的界面上。**尽力而为**：设备已经断开时这条必然失败，不该把关窗流程带崩。
  if (session.returnsHome) await goHome(session.serial).catch(() => {});
  return true;
}

export async function stopAllMirrorSessions() {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => stopMirrorSession(id)));
  return ids.length;
}

/**
 * 这个窗口是不是某个镜像会话的窗口。菜单要用它决定 ⌘Q 的语义：
 * 镜像窗口上就是「关掉这个投屏窗口」，不是把整个程序退掉。
 * @param {import("electron").BrowserWindow | null} target
 */
export function isMirrorWindow(target) {
  if (!target || target.isDestroyed()) return false;
  for (const session of sessions.values()) {
    if (session.win === target) return true;
  }
  return false;
}

export function listMirrorSessions() {
  return [...sessions.values()].map(snapshot);
}

export function focusMirrorSession(id) {
  const session = sessions.get(id);
  if (!session?.win || session.win.isDestroyed()) throw new Error("镜像会话不存在或已关闭");
  if (session.win.isMinimized()) session.win.restore();
  session.win.show();
  session.win.focus();
  return true;
}

// ---------------------------------------------------------------------------
// Mac 键盘（G1）：把设备输入法切到我们那条，并盯着归属
// ---------------------------------------------------------------------------

/**
 * 每台设备一份归属管理器。输入法是**设备级**的（一块屏只有一个默认输入法），
 * 而一台设备可以开好几个镜像窗口 ⇒ 不能按窗口一份，否则两个窗口互相夺回。
 * @type {Map<string, ReturnType<typeof createMacKeyboard>>}
 */
const macKeyboards = new Map();

/** @param {string} serial */
function macKeyboardFor(serial) {
  let owner = macKeyboards.get(serial);
  if (owner) return owner;
  owner = createMacKeyboard({
    readIme: () => getSecureSetting(serial, SETTING_DEFAULT_IME),
    writeIme: async (value) => {
      const result = await setSecureSetting(serial, SETTING_DEFAULT_IME, value);
      return result.code === 0;
    },
    runShell: (command) => runDeviceShell(serial, command),
    // 状态一变就推给这台设备上的所有镜像窗口（那颗开关要跟着亮/灭，横幅要跟着出）。
    // 一起带上 token 与 socket 名：镜像页重载（HMR / 接回）后得重新连桥，暗号只有这里知道。
    onState: (state) => {
      const payload = { state, token: owner.getToken(), socket: BRIDGE_SOCKET };
      for (const session of sessions.values()) {
        if (session.serial !== serial || !session.win || session.win.isDestroyed()) continue;
        session.win.webContents.send(CHANNELS.mirrorMacKeyboardState, payload);
      }
    },
  });
  macKeyboards.set(serial, owner);
  return owner;
}

/** 这台设备最后一个镜像窗口关掉时：还原输入法并撤掉那份管理器（含它的定时器）。 */
async function releaseMacKeyboard(serial) {
  for (const session of sessions.values()) {
    if (session.serial === serial) return;
  }
  const owner = macKeyboards.get(serial);
  if (!owner) return;
  macKeyboards.delete(serial);
  await owner.disable().catch(() => {});
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.mirrorStart, (_, options) => startMirrorSession(options));
ipcMain.handle(CHANNELS.mirrorInitGet, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  for (const session of sessions.values()) {
    if (session.win !== win) continue;
    // `audioHost` 用**当时**的值而不是建窗那一刻的快照：窗口刚开出来、页面还在 `bootstrap`
    // 路上时，原宿主可能已经关掉并把这一位交过来了（`mirror:audioHost` 那条推送会漏）。
    return { ...session.pendingInit, audioHost: session.audioHost === true };
  }
  return null;
});
ipcMain.handle(CHANNELS.mirrorList, () => listMirrorSessions());

/**
 * 「现在设备侧那条采集放开了吗」：起新的音频会话之前问一句（见 `waitAudioCaptureReleased`）。
 * 主进程在这里把轮询做完，渲染层只 await 一次 —— 轮询要跑设备命令，不适合放在页面里。
 */
ipcMain.handle(CHANNELS.mirrorAudioIdle, async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const session = [...sessions.values()].find((item) => item.win === win);
  if (!session) return true;
  return waitAudioCaptureReleased(session.serial);
});

/**
 * 长条上那颗「使用 Mac 键盘」：`on` 把设备输入法抢过来、`off` 还原、`state` 只是问一句
 * （镜像页重载后要知道当前状态，别把开关画反）。回的是归属状态，见 `macKeyboard.js`。
 */
ipcMain.handle(CHANNELS.mirrorMacKeyboard, async (event, action) => {
  const owner = macKeyboardOfEvent(event);
  let state;
  if (action === "on") state = await owner.enable();
  else if (action === "off") state = await owner.disable();
  else state = await owner.adopt();   // 顺带认领上一任没还原的残留（见 `adopt`）
  // 一起回 token 与 socket 名：渲染层连那条抽象 socket 要用的暗号只有这里知道，
  // 镜像页重载（HMR / 接回）后靠它重连。
  return { state, token: owner.getToken(), socket: BRIDGE_SOCKET };
});

/** 设备侧按了胶囊上的 ×（渲染层的桥收到 `yield` 转过来）：让出，不再抢也不再送字。 */
/**
 * 渲染层显隐那层 chrome（浅灰底 + 标题栏 + 长条）时，把系统那三颗一起开关。
 * 用 `on` 不用 `handle`：纯表现层的一刀，没有要等结果的地方。
 *
 * 载荷是 `{ shown, railFloating }` 而不是单个布尔 —— 三颗的**落点分两档形态**（窗口态钉在标题栏里、
 * 浮动态让开画面圆角，见 `mirrorTrafficLightPosition`），所以每次开关都要按当时的形态重设一次位置：
 * 只改显隐不重设，翻转形态后三颗会留在上一档的落点上（浮动态就会重新压回圆角里）。
 */
ipcMain.on(CHANNELS.mirrorWindowButtons, (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const visible = payload?.shown === true;
  const railFloating = payload?.railFloating === true;
  win.setWindowButtonVisibility?.(visible);
  // 落点与显隐无关地一起设：放出来之后必须重设（`setWindowButtonVisibility(true)` 会把三颗打回
  // AppKit 默认的左上角），收起来时设了也无害 —— 这样翻转形态那一拍不会漏掉位置更新。
  win.setWindowButtonPosition?.(mirrorTrafficLightPosition(railFloating));
});

ipcMain.on(CHANNELS.mirrorMacKeyboardYield, (event) => {
  macKeyboardOfEvent(event).park();
});

/** IPC 事件 → 发起它的那个镜像会话。发起方一定是镜像窗口，找不到就是编程错误。 */
function sessionOfEvent(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) throw new Error("镜像窗口已关闭");
  const session = [...sessions.values()].find((item) => item.win === win);
  if (!session) throw new Error("镜像会话不存在");
  return session;
}

/** IPC 事件 → 这台设备那份归属管理器。输入法是**设备级**的（一块屏只有一个默认输入法）。 */
function macKeyboardOfEvent(event) {
  return macKeyboardFor(sessionOfEvent(event).serial);
}

ipcMain.handle(CHANNELS.mirrorStop, (_, id) => stopMirrorSession(id));
ipcMain.handle(CHANNELS.mirrorStopAll, () => stopAllMirrorSessions());
ipcMain.handle(CHANNELS.mirrorFocus, (_, id) => focusMirrorSession(id));

/**
 * 长条上那颗「桌面模式」（用户 2026-10-11 点单）：把手机主屏上**正在用的那个应用**抽到一块新的
 * 虚拟屏窗口里。走的就是首页「点应用」那条路 —— `startMirrorSession` 建虚拟显示，渲染层
 * `startApp` 之后由 `ensureAppHere` 用 `am display move-stack` 把 task 搬过去（不重启应用）。
 * 唯一的区别：包名不是用户从列表里点的，而是这里现问设备（`getForegroundApp`）。
 *
 * 名称与图标读**本机那份应用缓存**（`getCachedApps`，不碰设备）：新窗口的「接回画面」横幅要用它们，
 * 而为一格图标去问设备等于白花一轮 IO（同 `startMirrorSession` 的 `iconUrl` 那条注释）。
 * 已经在播的应用由 `findAppSession` 复用，返回里带 `reused`。
 */
ipcMain.handle(CHANNELS.mirrorDesktopMode, async (event) => {
  const session = sessionOfEvent(event);
  const packageName = await getForegroundApp(session.serial);
  // 停在桌面（launcher 自己就是前台）时没有可搬的应用 —— 说清楚比搬走 launcher 好。
  if (!packageName) throw new Error("手机上现在没有打开的应用");
  const cached = await getCachedApps(session.serial).catch(() => []);
  const entry = cached.find((app) => app.packageName === packageName);
  const label = entry?.label || packageName;
  const started = await startMirrorSession({
    serial: session.serial,
    packageName,
    label,
    iconUrl: entry?.iconUrl || undefined,
    // 沿用这个窗口的参数：同一台设备上换个入口不该换掉用户配好的规格。
    config: session.pendingInit?.config ?? null,
  });
  return { ...started, label: started.label || label };
});

/**
 * dev 调试边栏（`tools` 那一格）展开/收起：边栏是**浮在窗口右边的另一栏**，所以撑宽的是**窗口**，
 * 不是从画面那块矩形里切 —— 画面尺寸不变 ⇒ 不会发 `resizeDisplay`、手机上不会重排一次。
 * 渲染层每次只报"现在要占多宽"（0 = 收起），主进程按上一次的量算增量，所以页面重载后
 * 状态自己会纠正（不会重复撑宽）。全屏时不动窗口尺寸。
 */
const hudExtras = new WeakMap();

/**
 * 按当前「dev 边栏占多宽 + 长条浮在画面里没有」重设一次拖拽比例锁。
 * 余量（`mirrorContentExtraSize`）随这两件事变，漏设一次「画面 = 设备比例」这条等式就破了
 * —— 采主屏那档画面会比设备比例宽/窄一截，圆角里当场露出 letterbox 黑条。
 */
function relockAspect(win) {
  const ratio = aspectRatios.get(win) ?? 0;
  if (!ratio) return;
  win.setAspectRatio?.(
    ratio,
    mirrorContentExtraSize(hudExtras.get(win) ?? 0, railFloatingStates.get(win) ?? false),
  );
}

ipcMain.on(CHANNELS.mirrorWindowHud, (event, extra) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  const next = Math.max(0, Number(extra) || 0);
  const delta = next - (hudExtras.get(win) ?? 0);
  if (!delta) return;
  hudExtras.set(win, next);
  const [width, height] = win.getContentSize();
  win.setContentSize(Math.max(1, width + delta), height);
  // 边栏这一截是**窗口**多出来的、不参与比例的余量（跟黑框与长条同一类）：不重设的话，
  // 撑宽之后再拖一次边，系统会按老余量把窗口收回去 —— 边栏那一格当场被挤没。
  relockAspect(win);
});

/**
 * 渲染层报「长条现在浮在画面里没有」（它量 `.mirror-main` 的宽实时判，判据 `mirrorRailFloats`）。
 *
 * 形态一变，窗口右边那一截不参与比例的余量就差一条长条宽（浮起来那 86px 归画面）⇒ 比例锁要按新余量
 * 重设一次，否则「画面 = 设备比例」当场破掉。⚠️ **这里不动窗口尺寸**：窗口宽正是那条判据的输入，
 * 一动它就会在阈值附近自己来回跳（浮起来画面宽 86 ⇒ 又越过阈值 ⇒ 再收回去）。
 */
ipcMain.on(CHANNELS.mirrorRailFloat, (event, railFloating) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const next = railFloating === true;
  if ((railFloatingStates.get(win) ?? false) === next) return;
  railFloatingStates.set(win, next);
  relockAspect(win);
});

/**
 * 渲染层状态上报：ready（回填快照字段）、exit（意外退出 → 通知主窗口）。
 * @param {Record<string, unknown>} payload
 */
ipcMain.on(CHANNELS.mirrorState, (_event, payload) => {
  const session = payload?.id ? sessions.get(String(payload.id)) : null;
  if (!session) return;
  if (payload.kind === "ready") {
    session.codec = Number(payload.codec) || null;
    session.codecName = typeof payload.codecName === "string" ? payload.codecName : null;
    session.hasAudio = payload.hasAudio === true;
  } else if (payload.kind === "exit") {
    notifyExit({ ...payload, label: session.label, packageName: session.packageName, win: session.win });
    // 会话已经没了（设备断开 / server 挂了），**必须走完整收摊**，不能只删记录。
    // ⚠️ 这里原来只 `sessions.delete(session.id)`：`miProjectionRestore` / `keepAwakeRestore` 会**跟着记录
    // 一起被丢掉**，而窗口随后 `closed` 再调 `stopMirrorSession` 时 `sessions.get` 已经拿不到 session
    // （`if (!session) return false`）⇒ 设备的 `synergy_mode` 与 `stay_on_while_plugged_in` **永远停在我们
    // 改过的值上**，Mac 键盘的归属也不会放手。真机证据：`stay_on_while_plugged_in` 停在 7（2026-10-11）。
    // 断开设备那条路上 `onDeviceTeardown` 也会调 `stopMirrorSession`，两边谁先谁后都安全：
    // 后到的那个拿不到记录，自然空转（与「接回 / 关窗 / ⌘Q 走同一个入口」同一条规矩）。
    void stopMirrorSession(session.id);
  }
});

// 断开设备或退出时，结束对应设备的自研镜像会话（直接关窗口）。
// 切换设备带 `keepMirror`：切走的那台不是断开，已经开着的镜像要继续投。
onDeviceTeardown((serial, options) => {
  if (options?.keepMirror) return;
  const ids = [...sessions.values()]
    .filter((s) => !serial || s.serial === serial)
    .map((s) => s.id);
  return Promise.all(ids.map((id) => stopMirrorSession(id)));
});
