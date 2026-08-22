import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as adb from './adb.js'
import { CHANNELS } from './ipcContract.js'
import { getCachedInstalledApps } from './appCache.js'
import { startScrcpy, stopScrcpy } from './scrcpy.js'
import { buildScrcpyRequest } from './scrcpyRequest.js'
import { resolveSession } from '../shared/deviceSession.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win = null
const preload = path.join(process.env.APP_ROOT, 'dist-electron/preload.mjs')

function createWindow() {
  win = new BrowserWindow({
    title: 'Main window',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    // minWidth: 672,
    // minHeight: 600,
    height: 600,
    width: 1000,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#00000000',
    x: 0,
    y: 0,
    webPreferences: { preload },
  })
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

function startScrcpyFromRequest(options) {
  const request = buildScrcpyRequest(options)
  return startScrcpy(request.args, request.iconDataUrl)
}

// ADB IPC handlers
for (const [channel, handler] of Object.entries({
  [CHANNELS.adbPair]: (_, h, p, c) => adb.pair(h, p, c),
  [CHANNELS.adbStartDiscovery]: () => {
    adb.startDiscovery()
    return true
  },
  [CHANNELS.adbGetDiscoveredDevices]: () => adb.getDiscoveredDevices(),
  [CHANNELS.adbStopDiscovery]: () => {
    adb.stopDiscovery()
    return true
  },
  [CHANNELS.adbGetActiveSession]: async () => resolveSession(await adb.getDevices()),
  [CHANNELS.adbDisconnect]: async (_, serial) => {
    stopScrcpy()
    return adb.disconnectDevice(serial)
  },
  [CHANNELS.adbGetDeviceInfo]: (_, serial) => adb.getDeviceInfo(serial),
  [CHANNELS.adbGetCachedInstalledApps]: (_, serial) => getCachedInstalledApps(serial),
  [CHANNELS.adbLoadInstalledApps]: (event, serial, loadId) =>
    adb.loadInstalledApps(serial, loadId, event.sender),
  [CHANNELS.adbCancelInstalledAppsLoad]: (_, loadId) => {
    adb.cancelInstalledAppsLoad(loadId)
    return true
  },
  [CHANNELS.scrcpyStart]: (_, options) => startScrcpyFromRequest(options),
})) {
  ipcMain.handle(channel, handler)
}

app.whenReady().then(createWindow)
app.on('before-quit', stopScrcpy)
app.on('window-all-closed', () => {
  win = null
})
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length) {
    BrowserWindow.getAllWindows()[0].focus()
  } else {
    createWindow()
  }
})
