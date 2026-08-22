import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { nativeImage } from 'electron'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HELPER_KEEPALIVE_PORT, HELPER_PORT, helperKeepAliveUrl } from '../helper/helperProtocol.js'
import { request as helperRequest } from '../helper/helperClient.js'
import { getAdbPath, getScrcpyPath, getScrcpyServerPath } from '../resourceResolver.js'
import { buildScrcpyArgs } from './scrcpyRequest.js'

// scrcpy 进程管理：以 serial 关联进程，统一启动/停止与临时图标目录清理。
// 资源路径全部来自 resourceResolver；CLI args 由 buildScrcpyArgs 构建。

/** @type {Map<string, { child: import('node:child_process').ChildProcess, iconDir: string }>} */
const processesBySerial = new Map()

// 投屏保活：镜像期间让设备端 helper 持有唤醒锁/WiFi 锁，
// 否则手机息屏后 CPU 挂起、WiFi 进省电模式，无线视频流几秒即卡死。
// 走独立转发端口（18924），与 app 加载的 18923 forward 会话互不干扰。
/** @type {Map<string, number>} 保活代次：旧会话迟到的异步清理不得拆掉新会话刚建立的转发 */
const keepAliveEpochs = new Map()

// 心跳：投屏期间定期 ping helper，保持 TCP 连接活跃并在连接断开时自动恢复。
// 部分安卓厂商（小米/OPPO/华为等）息屏后会激进断开后台网络连接，
// 单次 acquireWakeLock 无法防御，需要周期性重试。
const KEEPALIVE_HEARTBEAT_MS = 3_000
/** @type {Map<string, ReturnType<typeof setInterval>>} */
const heartbeatTimers = new Map()

// ADB 传输层保活：投屏期间保持一条独立的 adb shell 连接，
// 持续产生流量防止 MIUI 等系统在息屏后断开 ADB 传输层。
// scrcpy 视频流走独立 ADB 连接，此保活通过维持底层传输活跃间接保护视频流。
/** @type {Map<string, import('node:child_process').ChildProcess>} */
const adbKeepAliveProcesses = new Map()

/**
 * @param {string} serial
 * @param {...string} args
 */
function runAdb(serial, ...args) {
  return new Promise((resolve, reject) => {
    execFile(getAdbPath(), ['-s', serial, ...args], (err) => (err ? reject(err) : resolve()))
  })
}

async function acquireKeepAlive(serial) {
  const epoch = (keepAliveEpochs.get(serial) ?? 0) + 1
  keepAliveEpochs.set(serial, epoch)
  await runAdb(serial, 'forward', `tcp:${HELPER_KEEPALIVE_PORT}`, `tcp:${HELPER_PORT}`)
  // 老版本 helper 无此端点（404/连接失败）：静默降级，仅失去息屏保活能力
  await helperRequest(helperKeepAliveUrl('/wake-lock/acquire'), { timeout: 3000 }).catch(() => {})
  return epoch
}

async function releaseKeepAlive(serial, epoch) {
  if (keepAliveEpochs.get(serial) !== epoch) return
  await helperRequest(helperKeepAliveUrl('/wake-lock/release'), { timeout: 2000 }).catch(() => {})
  // await 期间可能已有新会话建立转发，此时转发归新会话所有
  if (keepAliveEpochs.get(serial) !== epoch) return
  keepAliveEpochs.delete(serial)
  await runAdb(serial, 'forward', '--remove', `tcp:${HELPER_KEEPALIVE_PORT}`).catch(() => {})
}

/**
 * 投屏心跳：定期 ping helper 并重试 acquireWakeLock，
 * 确保部分安卓厂商息屏后激进回收 WakeLock / 断开 WiFi 时能自动恢复。
 */
function startHeartbeat(serial, epoch) {
  stopHeartbeat(serial)
  const timer = setInterval(async () => {
    if (keepAliveEpochs.get(serial) !== epoch) {
      stopHeartbeat(serial)
      return
    }
    try {
      await helperRequest(helperKeepAliveUrl('/ping'), { timeout: 3000 })
      // ping 成功但仍无条件续期 wake-lock（MIUI 可能在心跳间隙强制释放锁）
      await helperRequest(helperKeepAliveUrl('/wake-lock/acquire'), { timeout: 3000 }).catch(() => {})
    } catch {
      // ping 失败：转发可能已被系统回收，重建 forward + 重新 acquire
      if (keepAliveEpochs.get(serial) !== epoch) return
      try {
        await runAdb(serial, 'forward', `tcp:${HELPER_KEEPALIVE_PORT}`, `tcp:${HELPER_PORT}`)
        await helperRequest(helperKeepAliveUrl('/wake-lock/acquire'), { timeout: 3000 }).catch(() => {})
      } catch {
        // 重建失败：下次心跳继续重试
      }
    }
  }, KEEPALIVE_HEARTBEAT_MS)
  heartbeatTimers.set(serial, timer)
}

function stopHeartbeat(serial) {
  const timer = heartbeatTimers.get(serial)
  if (timer) {
    clearInterval(timer)
    heartbeatTimers.delete(serial)
  }
}

/**
 * ADB 传输层保活：维持一条 adb shell 常驻连接，
 * 周期性产生流量防止 MIUI 息屏后断开 ADB 传输层（导致 scrcpy 视频流卡死）。
 */
function startAdbKeepAlive(serial) {
  stopAdbKeepAlive(serial)
  try {
    const child = spawn(getAdbPath(), ['-s', serial, 'shell', 'while true; do echo ok; sleep 3; done'], {
      stdio: 'ignore',
    })
    child.on('error', () => {})
    child.on('exit', () => { adbKeepAliveProcesses.delete(serial) })
    adbKeepAliveProcesses.set(serial, child)
  } catch {
    // 启动失败不阻断投屏
  }
}

function stopAdbKeepAlive(serial) {
  const child = adbKeepAliveProcesses.get(serial)
  if (child) {
    child.kill('SIGKILL')
    adbKeepAliveProcesses.delete(serial)
  }
}

async function removeIconDirectory(iconDir) {
  await rm(iconDir, { recursive: true, force: true }).catch(() => {})
}

function killEntry(serial, entry) {
  entry.child.kill('SIGKILL')
  void removeIconDirectory(entry.iconDir)
}

/** 停止指定设备的 scrcpy 进程。 */
export function stopForSerial(serial) {
  stopHeartbeat(serial)
  stopAdbKeepAlive(serial)
  const entry = processesBySerial.get(serial)
  if (!entry) return
  processesBySerial.delete(serial)
  killEntry(serial, entry)
}

/** 停止所有 scrcpy 进程（退出/全局清理用）。 */
export function stopAll() {
  for (const [serial, entry] of processesBySerial) {
    stopHeartbeat(serial)
    stopAdbKeepAlive(serial)
    processesBySerial.delete(serial)
    killEntry(serial, entry)
  }
}

async function prepareIcon(iconDataUrl) {
  if (!iconDataUrl?.startsWith('data:image/png;base64,')) {
    throw new Error('应用图标不可用')
  }

  const image = nativeImage.createFromDataURL(iconDataUrl)
  if (image.isEmpty()) {
    throw new Error('应用图标无效')
  }

  const iconDir = await mkdtemp(path.join(tmpdir(), 'anddrive-scrcpy-'))
  try {
    await writeFile(path.join(iconDir, 'scrcpy.png'), image.toPNG(), { mode: 0o600 })
    return iconDir
  } catch (error) {
    await removeIconDirectory(iconDir)
    throw error
  }
}

/**
 * 启动 scrcpy 镜像指定设备上的应用。同 serial 的旧进程会被先停止。
 * @param {import('../../shared/types.js').ScrcpyLaunchInput} request 已通过 validateScrcpyRequest 校验的领域数据
 * @returns {Promise<boolean>} spawn 成功即 resolve
 */
export async function start(request) {
  const { serial, iconDataUrl } = request
  // 单设备模型：同一设备的旧镜像直接替换
  if (processesBySerial.has(serial)) stopForSerial(serial)

  const iconDir = await prepareIcon(iconDataUrl)
  // 投屏前先拿保活锁，保证从头到尾都有息屏保护；失败不阻断投屏
  let keepAliveEpoch = null
  try {
    keepAliveEpoch = await acquireKeepAlive(serial)
  } catch {
    // 老版本 helper 或转发失败：静默降级，仅失去息屏保活能力
  }
  const releaseKeepAliveSafe = () => {
    if (keepAliveEpoch != null) void releaseKeepAlive(serial, keepAliveEpoch).catch(() => {})
  }
  const env = {
    ...process.env,
    ADB: getAdbPath(),
    SCRCPY_SERVER_PATH: getScrcpyServerPath(),
    SCRCPY_ICON_DIR: iconDir,
  }
  const args = buildScrcpyArgs(request)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(getScrcpyPath(), args, {
        stdio: 'ignore',
        env,
      })
    } catch (error) {
      releaseKeepAliveSafe()
      void removeIconDirectory(iconDir)
      reject(error)
      return
    }

    processesBySerial.set(serial, { child, iconDir })
    child.once('spawn', () => {
      if (keepAliveEpoch != null) {
        startHeartbeat(serial, keepAliveEpoch)
        startAdbKeepAlive(serial)
      }
      resolve(true)
    })
    child.once('error', (error) => {
      stopHeartbeat(serial)
      stopAdbKeepAlive(serial)
      if (processesBySerial.get(serial)?.child === child) processesBySerial.delete(serial)
      releaseKeepAliveSafe()
      void removeIconDirectory(iconDir)
      reject(error)
    })
    child.once('exit', () => {
      stopHeartbeat(serial)
      stopAdbKeepAlive(serial)
      if (processesBySerial.get(serial)?.child === child) processesBySerial.delete(serial)
      releaseKeepAliveSafe()
      void removeIconDirectory(iconDir)
    })
  })
}
