/* global __APP_CHANNEL__ */
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stopScrcpy, launchMirror, runDeviceTeardown } from "./adb.js";
import {
  MIRROR_SCHEME,
  parseMirrorUrl,
  extractMirrorUrl,
  extractShortcutFile,
} from "./shortcutCore.js";
import { readShortcutFile, ensureFileAssociation } from "./shortcut.js";
import { loadScrcpyConfig } from "./scrcpyConfig.js";
import "./permissions.js";
import "./favorites.js";
import "./mirror/session.js";
import { CHANNELS } from "./ipcContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname, "..");

const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

// 开发模式与 Beta 版使用独立的 userData，避免与正式版共用单实例锁和应用缓存。
if (VITE_DEV_SERVER_URL) {
  app.setPath("userData", path.join(app.getPath("appData"), "anddrive-dev"));
} else if (__APP_CHANNEL__ === "beta") {
  app.setPath("userData", path.join(app.getPath("appData"), "anddrive-beta"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
const preload = path.join(process.env.APP_ROOT, "dist-electron/preload.mjs");

/** 待处理的投屏唤起请求（入队时已解析），窗口就绪前先排队。 */
const pendingMirrorArgs = [];
let drainingMirrorArgs = false;
/** 桌面快捷方式直接启动（argv 传文件路径或 URL）时，先缓存下来。 */
const startupMirrorArg = extractShortcutFile(process.argv) || extractMirrorUrl(process.argv);
/** 桌面快捷方式是文件路径还是 URL。 */
const isMirrorUrlArg = (arg) => typeof arg === "string" && arg.startsWith(`${MIRROR_SCHEME}://`);

function activeWindow() {
  if (win && !win.isDestroyed()) return win;
  return BrowserWindow.getAllWindows()[0] || null;
}

function focusMainWindow() {
  const target = activeWindow();
  if (!target) return null;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

function notifyMirrorResult(request, result) {
  activeWindow()?.webContents.send(CHANNELS.mirrorResult, {
    ok: result.ok,
    message: result.message || "",
    label: request.label,
    packageName: request.packageName,
  });
}

/** 把 `.adr` 文件或 `anddrive://` URL 解析成投屏请求。 */
async function resolveMirrorRequest(arg) {
  if (isMirrorUrlArg(arg)) return parseMirrorUrl(arg);
  return readShortcutFile(arg);
}

/** 处理一次投屏唤起请求。 */
async function handleMirrorArg(request) {
  try {
    await launchMirror(request);
    notifyMirrorResult(request, { ok: true });
  } catch (error) {
    notifyMirrorResult(request, { ok: false, message: error?.message || "启动投屏失败" });
  }
}

/**
 * 入队一个唤起参数（`.adr` 文件路径或 `anddrive://` URL）。open-file 与 argv
 * 可能以不同 Unicode 形式（NFC/NFD）给出同一路径，这里按解析结果去重并缓存，
 * 避免重复触发投屏、也避免处理阶段二次读取文件。
 */
async function enqueueMirrorArg(arg) {
  if (typeof arg !== "string" || !arg) return;
  const request = await resolveMirrorRequest(arg);
  if (!request) return;
  const fingerprint = JSON.stringify(request);
  if (pendingMirrorArgs.some((item) => item.fingerprint === fingerprint)) return;
  pendingMirrorArgs.push({ request, fingerprint });
  void drainMirrorArgs();
}

/** 窗口就绪后逐个处理排队的唤起请求。 */
async function drainMirrorArgs() {
  if (drainingMirrorArgs) return;
  drainingMirrorArgs = true;
  try {
    while (pendingMirrorArgs.length) {
      if (!app.isReady()) return;
      if (!activeWindow()) createWindow();
      await handleMirrorArg(pendingMirrorArgs.shift().request);
    }
  } finally {
    drainingMirrorArgs = false;
  }
}

// macOS 通过该事件把自定义协议 URL 或 `.adr` 文件交给已运行（或刚启动）的实例
app.on("open-url", (event, url) => {
  event.preventDefault();
  enqueueMirrorArg(url);
});
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  enqueueMirrorArg(filePath);
});

function createWindow() {
  win = new BrowserWindow({
    title: "Main window",
    icon: path.join(process.env.VITE_PUBLIC, "favicon.ico"),
    height: 600,
    width: 1000,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#00000000",
    x: 0,
    y: 0,
    webPreferences: { preload },
  });
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

app.whenReady().then(async () => {
  // 快捷方式唤起投屏要用的全局参数先落到位，再开窗口处理队列。
  await loadScrcpyConfig();
  app.setAsDefaultProtocolClient(MIRROR_SCHEME);
  void ensureFileAssociation();
  createWindow();
  if (startupMirrorArg) enqueueMirrorArg(startupMirrorArg);
  drainMirrorArgs();
});
// 退出前先杀掉镜像进程；等待异步清理（最多 TEARDOWN_TIMEOUT_MS）再真正退出，
// 防止清理钩子卡住导致无法退出。
let teardownDone = false;
const TEARDOWN_TIMEOUT_MS = 3000;
app.on("before-quit", (event) => {
  if (teardownDone) return;
  event.preventDefault();
  stopScrcpy();
  void Promise.race([
    runDeviceTeardown(),
    new Promise((resolve) => setTimeout(resolve, TEARDOWN_TIMEOUT_MS)),
  ]).finally(() => {
    teardownDone = true;
    app.quit();
  });
});
app.on("window-all-closed", () => {
  win = null;
});
app.on("second-instance", (_event, commandLine) => {
  const arg = extractShortcutFile(commandLine) || extractMirrorUrl(commandLine);
  if (arg) {
    enqueueMirrorArg(arg);
    return;
  }
  focusMainWindow();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length) {
    BrowserWindow.getAllWindows()[0].focus();
  } else {
    createWindow();
  }
});
