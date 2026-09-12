/* global __APP_CHANNEL__ */
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stopScrcpy } from "./adb.js";
import "./permissions.js";

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

app.whenReady().then(createWindow);
app.on("before-quit", () => stopScrcpy());
app.on("window-all-closed", () => {
  win = null;
});
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length) {
    BrowserWindow.getAllWindows()[0].focus();
  } else {
    createWindow();
  }
});
