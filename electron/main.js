import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { IPC } from '../shared/ipcContract.js'
import * as adb from './adb/adbClient.js'
import { normalizeDisconnectSerial } from './adb/adbDisconnect.js'
import * as deviceMonitor from './adb/deviceMonitor.js'
import * as discovery from './adb/discoveryService.js'
import { listenDeviceBroadcast, runDiagnostics } from './diagnostics.js'
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
 * 用户主动断开即彻底断开：终止并抑制一切后台重连尝试（直到下次配对成功）。
 * @param {string} rawSerial
 */
async function disconnectDevice(rawSerial) {
  restoreCancelled = true
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

/**
 * 等待任一可用设备上线（全程事件驱动 + mDNS 视图主动 connect）。
 * @param {string|null} preferHost 优先匹配的配对来源 IP；null 表示任意设备
 * @param {number} timeoutMs 总护栏；恢复场景用短超时快速失败
 * @param {number} fallbackMs mDNS 视图兜底轮询间隔
 * @param {() => boolean} isStopped 外部取消谓词；返回 true 时安静收场（resolve null）
 * @returns {Promise<string>} 上线设备的 serial
 */
function onceDeviceOnline(
  preferHost = null,
  timeoutMs = 30000,
  fallbackMs = 3000,
  isStopped = () => false,
) {
  return new Promise((resolve, reject) => {
    let settled = false
    let busy = false
    const rejected = new Set()
    const matchHost = (serial) => !preferHost || serial.startsWith(`${preferHost}:`)
    const pick = (devices) => {
      const online = devices.filter((device) => device.state === 'device')
      return online.find((d) => matchHost(d.serial)) || null
    }
    const finish = (fn) => {
      if (settled) return
      settled = true
      offDevices()
      offConnectTarget()
      clearInterval(offMdnsFallback)
      clearTimeout(guard)
      fn()
    }
    /** 校验候选：探测通过才算上线；僵尸传输顺手清理。 */
    const consider = async (serial) => {
      if (settled || !serial || busy || rejected.has(serial) || isStopped()) return
      busy = true
      try {
        if (!(await adb.isReachable(serial))) {
          rejected.add(serial)
          await adb.disconnect(serial).catch(() => {}) // 清理僵尸，避免污染后续列表
          return
        }
        finish(() => resolve(serial))
      } finally {
        busy = false
      }
    }
    /** 清理离线传输后，用 adb 自带 mDNS 视图找到连接端口显式重连。 */
    const reconnectViaAdbMdns = async () => {
      for (const target of await adb.listMdnsConnectTargets().catch(() => [])) {
        if (!matchHost(target)) continue
        const [host, port] = target.split(':')
        await adb.connect(host, Number(port)).catch(() => {}) // 失败等下一轮事件
      }
    }
    /** 在线候选经探测才算可用；offline 传输等待手机端授权后自行翻转。 */
    const evaluate = async (devices) => {
      if (settled || busy || !Array.isArray(devices)) return
      const hit = pick(devices)?.serial
      if (hit) await consider(hit)
    }
    const offDevices = deviceMonitor.onDevicesChanged((devices) => {
      void evaluate(devices)
    })
    // offline 传输可能正在等手机端授权（MIUI 等每条新连接都要确认），
    // 断开它会掐掉弹窗、逼出第二次提示——所以只等待翻转，不动它。
    // 兜底轮询 adb 自带 mDNS 视图主动 connect：让授权弹窗尽快出现，
    // 而不是被动等 adb 隔轮重试。30s 护栏内有效。
    const offMdnsFallback = setInterval(() => {
      if (settled || busy) return
      if (isStopped()) return finish(() => resolve(null))
      void reconnectViaAdbMdns()
    }, fallbackMs)
    void reconnectViaAdbMdns() // 立即查一次：手机在广播时毫秒级就能拿到端口
    // 配对后密钥同步存在竞态，自动连接常以 offline 收场。
    // tls-connect 端口一已知就立刻显式 connect（重复 connect 幂等），
    // 成功后 track-devices 即推事件——不被动等 adb 自己重试。
    const offConnectTarget = discovery.onConnectTarget((address) => {
      if (!matchHost(address) || isStopped()) return
      const [host, port] = address.split(':')
      adb.connect(host, Number(port)).catch(() => {})
    })
    const guard = setTimeout(
      () => finish(() => reject(new Error('等待设备上线超时，请确认手机亮屏且无线调试已开启'))),
      timeoutMs,
    )
    // 订阅前可能已经连上或已有离线残留：立即评估一次快照
    adb
      .listDevices()
      .then(evaluate)
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
  // 配对成功即恢复后台自动恢复的资格（用户可能再次手动断开）
  restoreCancelled = false
  return serial
}

/**
 * 启动恢复：主动经 adb 自带 mDNS 视图重连已配对设备。
 * mDNS 自动连接已被禁用（断开后不得静默重连），恢复连接必须显式发起。
 * 设计为后台长任务：渲染层不等待它，设备上线经 devices-changed 推送驱动 UI。
 * @returns {Promise<string | null>} 上线设备的 serial；窗口期结束仍未发现返回 null
 */
const RESTORE_WINDOW_MS = 60000
/** 用户显式断开后置位：终止后台恢复并抑制再次发起，直到下次配对成功 */
let restoreCancelled = false
let restoreRunning = false
async function restoreDevice() {
  if (restoreRunning || restoreCancelled) return null
  restoreRunning = true
  try {
    return await onceDeviceOnline(null, RESTORE_WINDOW_MS, 2000, () => restoreCancelled).catch(
      () => null,
    )
  } finally {
    restoreRunning = false
  }
}

// IPC handlers：channel 名以 shared/ipcContract.js 为唯一事实来源
for (const [channel, handler] of Object.entries({
  [IPC.pairDevice]: pairDevice,
  [IPC.restoreDevice]: () => restoreDevice(),
  [IPC.startDiscovery]: () => {
    discovery.startDiscovery()
    return true
  },
  [IPC.stopDiscovery]: () => {
    discovery.stopDiscovery()
    return true
  },
  [IPC.getDevices]: () => adb.pruneWirelessTransports(),
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
  [IPC.diagnosticsRun]: () => runDiagnostics(),
  [IPC.diagnosticsListenPairing]: (_, windowMs) => listenDeviceBroadcast(windowMs),
})) {
  ipcMain.handle(channel, handler)
}

app.whenReady().then(async () => {
  // 先以受管配置重启 adb server（禁用 mDNS 自动连接），再启动事件监听与窗口
  await adb.restartManagedServer()
  deviceMonitor.onDevicesChanged((devices) => broadcast(IPC.devicesChangedEvent, devices))
  discovery.onDiscovered((target) => broadcast(IPC.discoveredTargetEvent, target))
  createWindow()
})
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
