import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { IPC } from '../shared/ipcContract.js'
import * as adb from './adb/adbClient.js'
import { normalizeDisconnectSerial } from './adb/adbDisconnect.js'
import * as deviceMonitor from './adb/deviceMonitor.js'
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

/** 事件广播：设备增减与 mDNS 服务发现即时推送渲染层（回调驱动，无轮询）。 */
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}
deviceMonitor.onDevicesChanged((devices) => broadcast(IPC.devicesChangedEvent, devices))
discovery.onDiscovered((target) => broadcast(IPC.discoveredTargetEvent, target))

/**
 * 等待任一在线设备（优先与配对同 IP），全程事件驱动：
 * - deviceMonitor 变更推送（覆盖 adb 自带 mdns 自动连接路径）
 * - 发现 tls-connect 服务时主动 connect 加速上线
 * 兜底超时仅防"永不成功"的挂起，不参与流程推进。
 * @param {string} preferHost
 * @returns {Promise<string>} 上线设备的 serial
 */
function onceDeviceOnline(preferHost, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const pick = (devices) => {
      const online = devices.filter((device) => device.state === 'device')
      return online.find((d) => d.serial.startsWith(`${preferHost}:`)) || online[0]
    }
    const finish = (fn) => {
      if (settled) return
      settled = true
      offDevices()
      offTargets()
      clearTimeout(guard)
      fn()
    }
    const offDevices = deviceMonitor.onDevicesChanged((devices) => {
      const hit = pick(devices)
      if (hit) finish(() => resolve(hit.serial))
    })
    const offTargets = discovery.onDiscovered((target) => {
      if (target.kind !== 'connect') return
      // 只主动连接配对目标本身，避免误连局域网内其他已配对设备
      if (!target.address.startsWith(`${preferHost}:`)) return
      const [host, port] = target.address.split(':')
      adb.connect(host, Number(port)).catch(() => {}) // 失败等后续事件；成功后 monitor 即推
    })
    const guard = setTimeout(
      () => finish(() => reject(new Error('等待设备上线超时，请确认手机亮屏且无线调试已开启'))),
      timeoutMs,
    )
    // 订阅前可能已经连上：立即查一次快照
    adb
      .listDevices()
      .then((devices) => {
        const hit = pick(devices)
        if (hit) finish(() => resolve(hit.serial))
      })
      .catch(() => {})
  })
}

/**
 * 配对编排：pair → 等待设备上线 → 按需安装 Helper，进度经 pairing-event 推送。
 * 每步完成即刻通知；任一步失败整体 reject，由渲染层展示。
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {string} host
 * @param {number} port
 * @param {string} code
 */
async function pairDevice(event, host, port, code) {
  const notify = (phase) => event.sender.send(IPC.pairingEvent, { phase })
  notify('pairing')
  await adb.pair(host, port, code)
  notify('paired')
  notify('connecting')
  const serial = await onceDeviceOnline(String(host))
  notify('connected')
  if (!(await helper.isInstalled(serial))) {
    notify('installing')
    await helper.install(serial)
    notify('installed')
  }
  return serial
}

// IPC handlers：channel 名以 shared/ipcContract.js 为唯一事实来源
for (const [channel, handler] of Object.entries({
  [IPC.pairDevice]: pairDevice,
  [IPC.startDiscovery]: () => {
    discovery.startDiscovery()
    return true
  },
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
