import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import * as adb from './adb.js'
import { getCachedInstalledApps } from './appCache.js'
import { startScrcpy, stopScrcpy } from './scrcpy.js'
import { validateScrcpyRequest } from './scrcpyRequest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

if (process.platform === 'win32' && os.release().startsWith('6.1'))
  app.disableHardwareAcceleration()
if (process.platform === 'win32') app.setAppUserModelId(app.getName())
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

function startScrcpyRequest(options) {
  const request = validateScrcpyRequest(options)
  return startScrcpy(request.args, request.iconDataUrl)
}

// ADB IPC handlers
for (const [channel, handler] of Object.entries({
  'adb:pair': (_, h, p, c) => adb.pair(h, p, c),
  'adb:startDiscovery': () => {
    adb.startDiscovery()
    return true
  },
  'adb:getDiscoveredDevices': () => adb.getDiscoveredDevices(),
  'adb:stopDiscovery': () => {
    adb.stopDiscovery()
    return true
  },
  'adb:getDevices': () => adb.getDevices(),
  'adb:getDeviceInfo': (_, serial) => adb.getDeviceInfo(serial),
  'adb:getCachedInstalledApps': (_, serial) => getCachedInstalledApps(serial),
  'adb:loadInstalledApps': (event, serial, loadId) =>
    adb.loadInstalledApps(serial, loadId, event.sender),
  'adb:cancelInstalledAppsLoad': (_, loadId) => {
    adb.cancelInstalledAppsLoad(loadId)
    return true
  },
  start_scrcpy: (_, options) => startScrcpyRequest(options),
})) {
  ipcMain.handle(channel, handler)
}

app.whenReady().then(createWindow)
app.on('before-quit', stopScrcpy)
app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
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
