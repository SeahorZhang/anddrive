import fs from 'node:fs'
import * as adb from '../adb/adbClient.js'
import { isMissingForwardError } from '../adb/adbDisconnect.js'
import { getHelperApkPath } from '../resourceResolver.js'
import { getJson } from './helperClient.js'
import { HELPER_PORT, HELPER_PROTOCOL_VERSION, helperUrl } from './helperProtocol.js'

// Helper 生命周期：安装、启动、协议升级，以及单 session forward 状态。
// forward 锁保证同一时刻只有一条本地转发会话（app 加载或 device-info）。

export const HELPER_PACKAGE = 'com.anddrive.helper'

const DEVICE_INFO_SESSION = 'device-info'

let activeForward = null
let forwardQueue = Promise.resolve()
const upgradeAttempted = new Set()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 串行化 helper 转发会话；返回释放函数。
 * @returns {Promise<() => void>}
 */
export async function acquireForwardLock() {
  const previous = forwardQueue
  let release
  forwardQueue = new Promise((resolve) => {
    release = resolve
  })
  await previous
  return release
}

/** helper 是否可达。 */
export async function ping() {
  try {
    await getJson(helperUrl('/ping'), 0)
    return true
  } catch {
    return false
  }
}

async function waitForHelper(maxMs = 8000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await ping()) return true
    await sleep(100)
  }
  return false
}

/** @param {string} serial */
export async function isInstalled(serial) {
  try {
    const output = await adb.shell(serial, 'pm', 'list', 'packages', HELPER_PACKAGE)
    return output.includes(HELPER_PACKAGE)
  } catch {
    return false
  }
}

/** @param {string} serial */
export async function install(serial) {
  const apkPath = getHelperApkPath()
  if (!fs.existsSync(apkPath)) throw new Error('Helper APK not found: ' + apkPath)
  await adb.exec('-s', serial, 'install', '-r', apkPath)
}

/** @param {string} serial */
export async function startService(serial) {
  try {
    await adb.shell(
      serial,
      'am',
      'start-foreground-service',
      '-n',
      `${HELPER_PACKAGE}/.HelperService`,
    )
  } catch {
    await adb.shell(serial, 'am', 'start', '-n', `${HELPER_PACKAGE}/.MainActivity`)
  }
}

/**
 * 建立转发会话并确保 helper 可达（不可达时尝试拉起服务）。
 * @param {string} serial
 * @param {string|number} sessionId
 */
export async function ensureReady(serial, sessionId) {
  await adb.exec('-s', serial, 'forward', `tcp:${HELPER_PORT}`, `tcp:${HELPER_PORT}`)
  activeForward = { serial, sessionId }
  if (await ping()) return
  await startService(serial)
  if (!(await waitForHelper())) throw new Error('Helper service failed to start')
}

/**
 * 协议版本不匹配时原地重装一次 helper，保证 /device-info 等新端点可用。
 * @param {string} serial
 */
export async function ensureProtocol(serial) {
  if (upgradeAttempted.has(serial)) return
  const capabilities = await getJson(helperUrl('/ping'), 0).catch(() => ({}))
  if (capabilities?.protocol === HELPER_PROTOCOL_VERSION) return
  upgradeAttempted.add(serial)
  try {
    await install(serial)
    await adb.shell(serial, 'am', 'force-stop', HELPER_PACKAGE)
    await startService(serial)
    await waitForHelper()
  } catch (error) {
    console.warn('In-place helper upgrade failed:', error)
  }
}

function isOwned(serial, sessionId) {
  return activeForward?.serial === serial && activeForward.sessionId === sessionId
}

/**
 * 会话结束时移除自己拥有的转发；转发缺失视为成功。
 * @param {string} serial
 * @param {string|number} sessionId
 */
export async function releaseSession(serial, sessionId) {
  if (!isOwned(serial, sessionId)) return
  activeForward = null
  try {
    await adb.exec('-s', serial, 'forward', '--remove', `tcp:${HELPER_PORT}`)
  } catch (error) {
    if (!isMissingForwardError(error)) throw error
  }
}

/**
 * 设备断开时按 serial 清理转发（无论属于哪个会话）。
 * @param {string} serial
 */
export async function releaseForSerial(serial) {
  if (activeForward?.serial !== serial) return
  activeForward = null
  try {
    await adb.exec('-s', serial, 'forward', '--remove', `tcp:${HELPER_PORT}`)
  } catch (error) {
    if (!isMissingForwardError(error)) throw error
  }
}

/**
 * 经由 helper /device-info 拉取设备信息（本地转发，不受无线 adb 断连影响）。
 * @param {string} serial
 * @returns {Promise<import('../../shared/types.js').DeviceInfo>}
 */
export async function getDeviceInfo(serial) {
  const release = await acquireForwardLock()
  try {
    await adb.ensureServer()
    if (!(await isInstalled(serial))) await install(serial)
    await ensureReady(serial, DEVICE_INFO_SESSION)
    await ensureProtocol(serial)
    const info = await getJson(helperUrl('/device-info'), 0)
    if (info && info.model) return { serial, ...info }
    throw new Error('Helper /device-info returned no model')
  } finally {
    try {
      await releaseSession(serial, DEVICE_INFO_SESSION)
    } catch (error) {
      console.warn('Failed to remove helper forward:', error)
    }
    release()
  }
}
