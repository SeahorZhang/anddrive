import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CHANNELS } from './ipcContract.js'
import * as adbClient from './adb/adbClient.js'
import * as discovery from './adb/discoveryService.js'
import { normalizeDisconnectSerial } from './adb/errors.js'
import { deleteAppCache, getCachedInstalledApps } from './cache/appCache.js'
import { cleanupDevice, cancelInstalledAppsLoad, loadInstalledApps } from './helper/appLoader.js'
import { installHelper, uninstallHelper } from './helper/helperApk.js'
import { startScrcpy, stopScrcpy } from './scrcpy/scrcpyService.js'
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

/**
 * Full disconnect flow for one device: stop its mirrors, release helper
 * resources, then drop the wireless transport.
 * @param {string} rawSerial
 */
async function disconnectDevice(rawSerial) {
  const serial = normalizeDisconnectSerial(rawSerial)
  await adbClient.ensureServer()
  await cleanupDevice(serial)
  return adbClient.disconnectTransport(serial)
}

// IPC handlers: thin composition over the split services.
for (const [channel, handler] of Object.entries({
  [CHANNELS.adbPair]: (_, h, p, c) => adbClient.pair(h, p, c),
  [CHANNELS.adbStartDiscovery]: () => {
    discovery.startDiscovery()
    return true
  },
  [CHANNELS.adbGetDiscoveredDevices]: () => discovery.getDiscoveredDevices(),
  [CHANNELS.adbStopDiscovery]: () => {
    discovery.stopDiscovery()
    return true
  },
  [CHANNELS.adbGetActiveSession]: async () => resolveSession(await adbClient.listDevices()),
  [CHANNELS.adbDisconnect]: async (_, serial) => {
    stopScrcpy(serial)
    return disconnectDevice(serial)
  },
  [CHANNELS.adbGetDeviceInfo]: (_, serial) => adbClient.getDeviceInfo(serial),
  [CHANNELS.adbGetCachedInstalledApps]: (_, serial) => getCachedInstalledApps(serial),
  [CHANNELS.adbDeleteAppCache]: (_, serial) => deleteAppCache(normalizeDisconnectSerial(serial)),
  [CHANNELS.adbInstallHelper]: (_, serial) => installHelper(normalizeDisconnectSerial(serial)),
  [CHANNELS.adbUninstallHelper]: (_, serial) => uninstallHelper(normalizeDisconnectSerial(serial)),
  [CHANNELS.adbLoadInstalledApps]: (event, serial, loadId) =>
    loadInstalledApps(serial, loadId, (payload) =>
      event.sender.send(CHANNELS.installedAppEvent, payload),
    ),
  [CHANNELS.adbCancelInstalledAppsLoad]: (_, loadId) => {
    cancelInstalledAppsLoad(loadId)
    return true
  },
  [CHANNELS.scrcpyStart]: (_, options) => {
    const request = buildScrcpyRequest(options)
    return startScrcpy(request.args, request.iconDataUrl)
  },
})) {
  ipcMain.handle(channel, handler)
}

app.whenReady().then(createWindow)
app.on('before-quit', () => stopScrcpy())
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
