import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { IPC } from '../shared/ipcContract.js'
import * as adb from './adb/adbClient.js'
import { normalizeDisconnectSerial } from './adb/adbDisconnect.js'
import * as discovery from './adb/discoveryService.js'
import { getCachedInstalledApps } from './cache/appCache.js'
import * as helper from './helper/helperLifecycle.js'
import { createAppLoader } from './helper/appLoader.js'
import { validateScrcpyRequest } from './scrcpy/scrcpyRequest.js'
import * as scrcpyService from './scrcpy/scrcpyService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// 组合根：注入 helper 会话能力，构造单例 app loader
const appLoader = createAppLoader({
  isInstalled: helper.isInstalled,
  install: helper.install,
  ensureReady: helper.ensureReady,
  ensureProtocol: helper.ensureProtocol,
  releaseSession: helper.releaseSession,
  acquireForwardLock: helper.acquireForwardLock,
})

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

/**
 * 断开一台设备：停镜像、取消加载、释放 forward 会话，再断开无线 transport。
 * @param {string} rawSerial
 */
async function disconnectDevice(rawSerial) {
  const serial = normalizeDisconnectSerial(rawSerial)
  scrcpyService.stopForSerial(serial)
  appLoader.cancelForSerial(serial)
  await helper.releaseForSerial(serial)
  return adb.disconnect(serial)
}

// IPC handlers：channel 名以 shared/ipcContract.js 为唯一事实来源
for (const [channel, handler] of Object.entries({
  [IPC.pair]: (_, h, p, c) => adb.pair(h, p, c),
  [IPC.startDiscovery]: () => {
    discovery.startDiscovery()
    return true
  },
  [IPC.getDiscoveredDevices]: () => discovery.getDiscoveredDevices(),
  [IPC.stopDiscovery]: () => {
    discovery.stopDiscovery()
    return true
  },
  [IPC.getDevices]: () => adb.listDevices(),
  [IPC.disconnect]: (_, serial) => disconnectDevice(serial),
  [IPC.getDeviceInfo]: (_, serial) => helper.getDeviceInfo(serial),
  [IPC.getCachedInstalledApps]: (_, serial) => getCachedInstalledApps(serial),
  // 进度经 contract 中定义的 AppLoadEvent 推送；sender 只在组合边界触碰一次
  [IPC.loadInstalledApps]: (event, serial, loadId) =>
    appLoader.load({
      serial,
      loadId,
      emit: (appLoadEvent) => event.sender.send(IPC.installedAppEvent, appLoadEvent),
    }),
  [IPC.cancelInstalledAppsLoad]: (_, loadId) => {
    appLoader.cancelLoad(loadId)
    return true
  },
  // renderer 只提交领域数据；CLI args 与资源路径由 service 构建
  [IPC.startScrcpy]: (_, options) => scrcpyService.start(validateScrcpyRequest(options)),
})) {
  ipcMain.handle(channel, handler)
}

app.whenReady().then(createWindow)
app.on('before-quit', scrcpyService.stopAll)
app.on('window-all-closed', () => {
  // macOS 常规行为：关闭窗口保留应用，激活时重建窗口
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
