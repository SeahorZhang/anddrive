import fs from 'node:fs'
import { adbExec, adbShell } from '../adb/adbClient.js'
import { helperApkPath } from '../paths.js'
import { isMissingForwardError } from '../adb/errors.js'
import { httpGetJSON } from './helperClient.js'
import { HELPER_PORT, HELPER_PROTOCOL_VERSION, helperUrl } from './helperProtocol.js'

export const HELPER_PACKAGE = 'com.andrive.helper'

const helperUpgradeAttempted = new Set()
let activeForward = null
let forwardQueue = Promise.resolve()

export async function acquireForwardLock() {
  const previous = forwardQueue
  let release
  forwardQueue = new Promise((resolve) => {
    release = resolve
  })
  await previous
  return release
}

export async function isHelperInstalled(serial) {
  try {
    const output = await adbShell(serial, 'pm', 'list', 'packages', HELPER_PACKAGE)
    return output.includes(HELPER_PACKAGE)
  } catch {
    return false
  }
}

export async function installHelper(serial) {
  const apkPath = helperApkPath()
  if (!fs.existsSync(apkPath)) {
    throw new Error('Helper APK not found: ' + apkPath)
  }
  await adbExec('-s', serial, 'install', '-r', apkPath)
}

async function startHelperService(serial) {
  try {
    await adbShell(
      serial,
      'am',
      'start-foreground-service',
      '-n',
      `${HELPER_PACKAGE}/.HelperService`,
    )
  } catch {
    await adbShell(serial, 'am', 'start', '-n', `${HELPER_PACKAGE}/.MainActivity`)
  }
}

async function pingHelper() {
  try {
    await httpGetJSON(helperUrl('/ping'), 0)
    return true
  } catch {
    return false
  }
}

async function waitForHelper(maxMs = 8000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await pingHelper()) return true
    await sleep(100)
  }
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Forward the helper port and make sure the service answers /ping,
 * starting it on the device when necessary.
 * @param {string} serial
 * @param {number} loadId
 */
export async function ensureHelperReady(serial, loadId) {
  await adbExec('-s', serial, 'forward', `tcp:${HELPER_PORT}`, `tcp:${HELPER_PORT}`)
  activeForward = { serial, loadId }
  if (await pingHelper()) return

  await startHelperService(serial)
  if (!(await waitForHelper())) {
    throw new Error('Helper service failed to start')
  }
}

/**
 * Fetch /ping capabilities and, once per device, reinstall+restart the helper
 * when its protocol version is stale. Falls back to current capabilities so a
 * failed in-place upgrade keeps the legacy icon endpoint usable.
 * @param {string} serial
 */
export async function ensureCompatibleCapabilities(serial) {
  let capabilities = await httpGetJSON(helperUrl('/ping'), 0).catch(() => ({}))
  if (capabilities.protocol !== HELPER_PROTOCOL_VERSION && !helperUpgradeAttempted.has(serial)) {
    helperUpgradeAttempted.add(serial)
    try {
      await installHelper(serial)
      await adbShell(serial, 'am', 'force-stop', HELPER_PACKAGE)
      await startHelperService(serial)
      if (await waitForHelper()) {
        capabilities = await httpGetJSON(helperUrl('/ping'), 0).catch(() => capabilities)
      }
    } catch {
      // Keep using the legacy icon endpoint when an in-place upgrade fails.
    }
  }
  return capabilities
}

/**
 * Release the helper forward owned by one load. No-op when another load owns it.
 * @param {string} serial
 * @param {number} loadId
 */
export async function removeForward(serial, loadId) {
  if (activeForward?.serial !== serial || activeForward.loadId !== loadId) return
  activeForward = null
  try {
    await adbExec('-s', serial, 'forward', '--remove', `tcp:${HELPER_PORT}`)
  } catch (error) {
    if (!isMissingForwardError(error)) throw error
  }
}

/** Cancel Helper work and remove the forward owned by one device. @param {string} serial */
export async function removeForwardForSerial(serial) {
  if (activeForward?.serial !== serial) return
  activeForward = null
  try {
    await adbExec('-s', serial, 'forward', '--remove', `tcp:${HELPER_PORT}`)
  } catch (error) {
    if (!isMissingForwardError(error)) throw error
  }
}
