import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { CHANNELS } from "../ipcContract.js";
import { ensureServer, onDeviceTeardown, scrcpyServerPath } from "../adb.js";
import { resolveRuntimePrefs } from "./options.js";

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
 */

function loadMirrorPage(win) {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) return win.loadURL(`${devServer}/mirror.html`);
  return win.loadFile(path.join(process.env.APP_ROOT, "dist", "mirror.html"));
}

function preloadPath() {
  return path.join(process.env.APP_ROOT, "dist-electron/preload.mjs");
}

function createMirrorWindow(session, prefs) {
  const win = new BrowserWindow({
    title: session.label || session.packageName,
    width: 460,
    height: 900,
    minWidth: 320,
    minHeight: 480,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#000000",
    show: false,
    alwaysOnTop: prefs.alwaysOnTop,
    fullscreen: prefs.fullscreen,
    // Electron 里只要显式传了 `fullscreen`（未勾「全屏启动」时就是 false），窗口就被
    // 标成不可全屏，macOS 绿色按钮随之退化成 zoom（最大化）。显式打开它。
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
  win.once("ready-to-show", () => win.show());
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
 * @param {{ serial: string, packageName: string, label?: string, config?: unknown }} request
 */
export async function startMirrorSession(request) {
  const serial = typeof request?.serial === "string" ? request.serial.trim() : "";
  const packageName = typeof request?.packageName === "string" ? request.packageName.trim() : "";
  if (!serial) throw new Error("设备序列号无效");
  if (!packageName) throw new Error("应用包名无效");
  const label = typeof request?.label === "string" && request.label.trim() ? request.label.trim() : packageName;
  await ensureServer();
  const serverPath = scrcpyServerPath();
  const prefs = resolveRuntimePrefs(request?.config);

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
  };
  sessions.set(session.id, session);

  try {
    session.win = createMirrorWindow(session, prefs);
  } catch (error) {
    sessions.delete(session.id);
    throw error;
  }

  // 页面主动 invoke 拉取启动参数（避免 did-finish-load 时序竞态）。
  session.pendingInit = {
    id: session.id,
    serial,
    label,
    packageName,
    serverPath,
    config: request?.config ?? null,
  };

  return { id: session.id, serial, packageName, label, startedAt: session.startedAt };
}

/** @param {string} id */
export async function stopMirrorSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
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
  }
});

// 断开设备或退出时，结束对应设备的自研镜像会话（直接关窗口）。
onDeviceTeardown((serial) => {
  const ids = [...sessions.values()]
    .filter((s) => !serial || s.serial === serial)
    .map((s) => s.id);
  return Promise.all(ids.map((id) => stopMirrorSession(id)));
});
