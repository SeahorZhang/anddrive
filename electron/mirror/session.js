import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { CHANNELS } from "../ipcContract.js";
import { onDeviceTeardown } from "../adb.js";
import { acquireDeviceAdb, pushScrcpyServer, releaseDeviceAdb, startScrcpyClient, codecName } from "./client.js";
import { resolveRuntimePrefs } from "./options.js";
import { applyControl } from "./control.js";

// ---------------------------------------------------------------------------
// 自研镜像会话（mirror）
//
// 每个会话一个独立 Electron 窗口：视频包经 IPC 送到渲染层，由 WebCodecs
// 解码并画在 canvas 上；右侧操作栏是窗口内自绘 UI。
// 会话只存在于主进程，渲染层通过 IPC 拿快照。
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
 * @property {number} codec
 * @property {import("electron").BrowserWindow | null} win
 * @property {{ close(): Promise<void> } | null} client
 * @property {boolean} stopped
 * @property {boolean} begin
 */

function preloadPath() {
  return path.join(process.env.APP_ROOT, "dist-electron/preload.mjs");
}

/** 页面就绪后发一次初始化信息，并开始转发视频流（保证只执行一次）。 */
function beginVideo(session, video) {
  if (session.begin) return;
  session.begin = true;
  session.win?.webContents.send(CHANNELS.mirrorInit, {
    id: session.id,
    label: session.label,
    packageName: session.packageName,
    codec: session.codec,
    codecName: codecName(session.codec),
    width: video.width,
    height: video.height,
  });
  void pumpVideo(session, video.stream);
}

function loadMirrorPage(win) {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) return win.loadURL(`${devServer}/mirror.html`);
  return win.loadFile(path.join(process.env.APP_ROOT, "dist", "mirror.html"));
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
    webPreferences: { preload: preloadPath(), backgroundThrottling: false },
  });
  win.once("ready-to-show", () => win.show());
  void loadMirrorPage(win);
  // DevTools 对视频窗口性能影响很大，默认不自动打开，需要时用环境变量开启。
  if (process.env.ANDRIVE_MIRROR_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }
  return win;
}

/**
 * 把 Tango 媒体包转成可结构化克隆的普通对象。
 * `data` 直接传 Uint8Array：结构化克隆按 byteOffset/byteLength 复制视图范围，
 * 不要再自己 slice（`Buffer.slice()` 会共享内存池，曾导致 Annex B 数据错位）。
 */
function encodePacket(packet) {
  if (packet.type === "configuration") {
    return { type: "configuration", data: packet.data };
  }
  if (packet.type === "session") {
    return {
      type: "session",
      isClientResize: packet.isClientResize === true,
      width: packet.width,
      height: packet.height,
    };
  }
  return {
    type: "data",
    keyframe: packet.keyframe === true,
    pts: packet.pts,
    data: packet.data,
  };
}

/** 读取视频流并转发到渲染层；会话结束/窗口关闭时退出。 */
async function pumpVideo(session, stream) {
  const reader = stream.getReader();
  try {
    while (!session.stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      const contents = session.win?.webContents;
      if (!contents || contents.isDestroyed()) break;
      contents.send(CHANNELS.mirrorVideo, encodePacket(value));
    }
  } catch (error) {
    if (session.stopped) return;
    const message = error?.message || "视频流已中断";
    console.warn(`[mirror] ${session.id} 视频流异常：`, message);
    session.win?.webContents.send(CHANNELS.mirrorError, { id: session.id, message });
  }
}

function snapshot(session) {
  return {
    id: session.id,
    serial: session.serial,
    packageName: session.packageName,
    label: session.label,
    startedAt: session.startedAt,
    codec: session.codec,
    codecName: codecName(session.codec),
  };
}

/** 会话被用户 / 断开流程之外的意外退出时，通知主窗口。 */
function notifyExit(session) {
  const payload = {
    id: session.id,
    label: session.label,
    packageName: session.packageName,
    message: "scrcpy 服务意外退出，镜像已结束",
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === session.win || win.isDestroyed()) continue;
    win.webContents.send(CHANNELS.mirrorExit, payload);
  }
}

/**
 * 启动一次原生镜像会话。
 * @param {{ serial: string, packageName: string, label?: string, config?: unknown }} request
 */
export async function startMirrorSession(request) {
  const serial = typeof request?.serial === "string" ? request.serial.trim() : "";
  const packageName = typeof request?.packageName === "string" ? request.packageName.trim() : "";
  if (!serial) throw new Error("设备序列号无效");
  if (!packageName) throw new Error("应用包名无效");
  const label = typeof request?.label === "string" && request.label.trim() ? request.label.trim() : packageName;
  const prefs = resolveRuntimePrefs(request?.config);

  const adb = await acquireDeviceAdb(serial);
  let client = null;
  try {
    await pushScrcpyServer(adb);
    client = await startScrcpyClient({ adb, config: request?.config });
    const video = await client.videoStream;
    if (!video) throw new Error("scrcpy 未返回视频流");

    /** @type {MirrorSession} */
    const session = {
      id: `mirror-${++sessionSeq}`,
      serial,
      packageName,
      label,
      startedAt: Date.now(),
      codec: video.metadata.codec,
      win: null,
      client,
      stopped: false,
      begin: false,
    };
    sessions.set(session.id, session);
    session.win = createMirrorWindow(session, prefs);

    session.win.webContents.on("did-finish-load", () => beginVideo(session, video));
    // 页面可能在 server 启动完成前就已加载完，此时事件已经错过，直接补发。
    if (!session.win.webContents.isLoading()) beginVideo(session, video);

    session.win.on("closed", () => void stopMirrorSession(session.id));
    client.exited
      .then(() => {
        if (!session.stopped) notifyExit(session);
        void stopMirrorSession(session.id);
      })
      .catch(() => {});

    // 启动目标应用（控制通道），并同步息屏等运行时偏好。
    const controller = client.controller;
    await controller?.startApp(packageName).catch(() => {});
    if (prefs.turnScreenOff) await controller?.setDisplayPower(false).catch(() => {});

    console.log(`[mirror] ${session.id} 已启动 ${label}（${codecName(session.codec)}）`);
    return snapshot(session);
  } catch (error) {
    await client?.close().catch(() => {});
    releaseDeviceAdb(serial);
    throw error;
  }
}

/** @param {string} id */
export async function stopMirrorSession(id) {
  const session = sessions.get(id);
  if (!session || session.stopped) return false;
  session.stopped = true;
  sessions.delete(id);
  if (session.win && !session.win.isDestroyed()) session.win.close();
  await session.client?.close().catch(() => {});
  releaseDeviceAdb(session.serial);
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
ipcMain.handle(CHANNELS.mirrorList, () => listMirrorSessions());
ipcMain.handle(CHANNELS.mirrorStop, (_, id) => stopMirrorSession(id));
ipcMain.handle(CHANNELS.mirrorStopAll, () => stopAllMirrorSessions());
ipcMain.handle(CHANNELS.mirrorFocus, (_, id) => focusMirrorSession(id));

// 输入控制：fire-and-forget，避免高频触控事件走 invoke 往返。
ipcMain.on(CHANNELS.mirrorControl, (_event, message) => {
  const session = sessions.get(message?.id);
  if (!session || session.stopped) return;
  const controller = session.client?.controller;
  if (!controller) return;
  void applyControl(controller, message).catch((error) => {
    console.warn(`[mirror] 控制消息失败（${message?.kind}）：`, error?.message || error);
  });
});

// 断开设备或退出时，结束对应设备的自研镜像会话。
onDeviceTeardown((serial) => {
  const ids = [...sessions.values()]
    .filter((session) => !serial || session.serial === serial)
    .map((session) => session.id);
  return Promise.all(ids.map((id) => stopMirrorSession(id)));
});
