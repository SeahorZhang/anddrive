import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { CHANNELS } from "../ipcContract.js";
import {
  ensureServer,
  getDeviceSdk,
  getDeviceVideoCodecs,
  getGlobalNumberSetting,
  getPhysicalScreenSize,
  getPhysicalScreenDensity,
  getWakefulness,
  isMiuiDevice,
  onDeviceTeardown,
  scrcpyServerPath,
  setGlobalNumberSetting,
  setSecureSetting,
  wakeDevice,
} from "../adb.js";
import { sanitizeIcon } from "../iconImage.js";
import { isValidPackageName, isValidSerial } from "../validators.js";
import { findAppSession } from "./appSession.js";
import { startKeepAwake } from "./keepAwake.js";
import { startMiProjection } from "./miProjection.js";
import { mirrorWindowBounds, mirrorsMainDisplay, resolveRuntimePrefs } from "./options.js";

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
 * @property {import("electron").BrowserWindow | null} win
 * @property {Record<string, unknown> | null} pendingInit
 * @property {(() => Promise<void>) | null} miProjectionRestore
 * @property {(() => Promise<void>) | null} keepAwakeRestore
 */

function loadMirrorPage(win) {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) return win.loadURL(`${devServer}/mirror.html`);
  return win.loadFile(path.join(process.env.APP_ROOT, "dist", "mirror.html"));
}

function preloadPath() {
  return path.join(process.env.APP_ROOT, "dist-electron/preload.mjs");
}

function createMirrorWindow(session, prefs, bounds) {
  const win = new BrowserWindow({
    title: session.label || session.packageName,
    // 初始形状跟设备屏幕一致（用户 2026-09-19 要求）：pad 状态下的 app 在竖形显示上排双列、
    // 横形显示上排宽布局，两种都铺满整帧，所以窗口照手机比例开也不会有黑边。
    width: bounds.width,
    height: bounds.height,
    minWidth: 280,
    minHeight: 280,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#000000",
    show: false,
    alwaysOnTop: prefs.alwaysOnTop,
    // **不传 `fullscreen`**：macOS 上「构造参数 fullscreen + show:false」常常落不回全屏
    // （窗口先按普通尺寸显示），要可靠地进全屏得在 show 之后调 `setFullScreen(true)`。
    // 顺带也不再触发另一个坑：显式传 `fullscreen: false` 会把窗口标成不可全屏，
    // macOS 绿色按钮随之退化成 zoom —— 这里靠 `fullscreenable` 表达意图。
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
  win.once("ready-to-show", () => {
    win.show();
    // 「全屏启动」在 show 之后落地（见上面构造参数那条注释）。
    if (prefs.fullscreen) win.setFullScreen(true);
  });
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
  const [screenSize, screenDpi, sdk] = await Promise.all([
    getPhysicalScreenSize(serial).catch(() => null),
    getPhysicalScreenDensity(serial).catch(() => null),
    getDeviceSdk(serial).catch(() => null),
  ]);
  const deviceMirror = wholeDevice || mirrorsMainDisplay(sdk);
  const serverPath = scrcpyServerPath(deviceMirror ? { largeScreenDisplay: false } : undefined);
  const bounds = mirrorWindowBounds(screenSize, screen.getPrimaryDisplay().workArea);
  // 设备能编码哪些：给镜像页落地 `auto`，也顺带进 pendingInit（渲染层不再自己查）。
  const deviceEncoders = await getDeviceVideoCodecs(serial).catch(() => null);

  /** @type {MirrorSession} */
  const session = {
    id: `mirror-${++sessionSeq}`,
    serial,
    packageName,
    label,
    startedAt: Date.now(),
    codec: null,
    codecName: null,
    hasAudio: false,
    win: null,
    pendingInit: null,
    miProjectionRestore: null,
    keepAwakeRestore: null,
  };
  sessions.set(session.id, session);

  try {
    session.win = createMirrorWindow(session, prefs, bounds);
  } catch (error) {
    sessions.delete(session.id);
    throw error;
  }

  // 页面主动 invoke 拉取启动参数（避免 did-finish-load 时序竞态）。
  // `initialCss` = 窗口内容区尺寸：渲染层拿它算第一块虚拟显示。不能让它读 DOM ——
  // 深链冷启动时页面还没排版完，`clientWidth` 会读到 Electron 默认的 512x512，
  // 于是开出一块和窗口完全不符的显示（2026-09-28 实测）。
  const content = session.win.getContentBounds();
  session.pendingInit = {
    id: session.id,
    serial,
    label,
    packageName,
    // 采主屏的判据在这里定一次：渲染层拿它跳过「接回画面」与「跟随窗口」
    // （那些都需要一块我们建的虚拟显示，这一档没有）。`startApp` 不在其列 —— 带着包名时渲染层
    // 照发，服务端把它开到主屏（= 手机屏幕）上，这一档要的正是「手机上打开这个 app，我们看着」。
    deviceMirror,
    serverPath,
    config: request?.config ?? null,
    prefs,
    initialCss: { width: content.width, height: content.height },
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
  // 两条设备侧登记都要还原（关窗 / 断开设备 / ⌘Q 都走这里）。
  const restoreMiProjection = session.miProjectionRestore;
  session.miProjectionRestore = null;
  if (restoreMiProjection) await restoreMiProjection().catch(() => {});
  const restoreKeepAwake = session.keepAwakeRestore;
  session.keepAwakeRestore = null;
  if (restoreKeepAwake) await restoreKeepAwake().catch(() => {});
  if (session.win && !session.win.isDestroyed()) {
    // 渲染层在 beforeunload 里停掉 scrcpy 会话；窗口关闭兜底。
    session.win.close();
  }
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
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.mirrorStart, (_, options) => startMirrorSession(options));
ipcMain.handle(CHANNELS.mirrorInitGet, (event) => {
  for (const session of sessions.values()) {
    if (session.win === BrowserWindow.fromWebContents(event.sender)) return session.pendingInit;
  }
  return null;
});
ipcMain.handle(CHANNELS.mirrorList, () => listMirrorSessions());
ipcMain.handle(CHANNELS.mirrorStop, (_, id) => stopMirrorSession(id));
ipcMain.handle(CHANNELS.mirrorStopAll, () => stopAllMirrorSessions());
ipcMain.handle(CHANNELS.mirrorFocus, (_, id) => focusMirrorSession(id));

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
    sessions.delete(session.id);
    // 会话已经没了（设备断开 / server 挂了），归属要一起放手。这里不 release 的话，
    // 窗口随后 closed → stopMirrorSession 会因为记录已删而什么都做不到。
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
