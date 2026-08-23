import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { adbExec, adbExecSafe, ensureServer } from '../adb/adbClient.js'
import { normalizeDisconnectSerial } from '../adb/errors.js'
import { writeAppCache } from '../cache/appCache.js'
import { adbPath, helperApkPath } from '../paths.js'

export const HELPER_PACKAGE = 'com.andrive.helper'

/**
 * Message prefix marking failures where the helper cannot be installed or run
 * on the device; the renderer turns these into an actionable install prompt.
 */
export const HELPER_SETUP_ERROR_PREFIX = 'HELPER_SETUP:'

const HELPER_ENTRY_CLASS = 'com.andrive.helper.ListMain'
const LIST_TIMEOUT_MS = 120000
const LIST_MAX_BUFFER_BYTES = 256 * 1024 * 1024

// ---------------------------------------------------------------------------
// Device-side package state
// ---------------------------------------------------------------------------

/**
 * A package may linger in `pm list` as a ghost after user-0 removal while its
 * APK is gone, so trust `pm path` (real APK location) instead.
 */
export async function isHelperInstalled(serial) {
  return (await deviceApkPath(serial)) != null
}

/** @returns {Promise<string | null>} on-device base.apk path of the helper */
export async function deviceApkPath(serial) {
  try {
    const output = await adbExec('-s', serial, 'shell', 'pm', 'path', HELPER_PACKAGE)
    const line = output.split('\n').find((l) => l.startsWith('package:'))
    return line ? line.slice('package:'.length).trim() || null : null
  } catch {
    return null
  }
}

export async function installHelper(serial) {
  const apkPath = helperApkPath()
  if (!fs.existsSync(apkPath)) {
    throw new Error('Helper APK not found: ' + apkPath)
  }
  // `adb install` exiting 0 is the authoritative success signal — the package
  // manager has committed the APK. No post-install polling is needed.
  await adbExec('-s', serial, 'install', '-r', apkPath)
  return true
}

/**
 * Remove the helper from the device with a plain `adb uninstall`.
 * Some ROMs print a spurious `Failure [...]` here while actually succeeding,
 * so the output is not treated as authoritative either way.
 * @param {string} serial
 */
export async function uninstallHelper(serial) {
  // await adbExecSafe('-s', serial, 'uninstall', HELPER_PACKAGE)
  // return true

     execFile(adbPath(), [
          '-s',
          serial,
          'uninstall',
          HELPER_PACKAGE,
        ], (err, stdout, stderr) => {
          console.log(11,err, )
          console.log(22, stdout, )
          console.log(33, stderr)
      // resolve({
      //   code: err ? (err.code ?? 1) : 0,
      //   stdout: stdout?.trim() || '',
      //   stderr: stderr?.trim() || '',
      // })
    })
}

/**
 * Run the one-shot ListMain entry inside app_process as shell (uid 2000) and
 * resolve with its stdout text. The installed helper serves purely as the
 * classpath: no component starts and no permission is granted to the package.
 * @param {string} serial
 */
export function runHelperList(serial) {
  return deviceApkPath(serial).then((apkPath) => {
    if (!apkPath) {
      throw new Error(HELPER_SETUP_ERROR_PREFIX + '设备上未找到 Helper')
    }
    return new Promise((resolve, reject) => {
      execFile(
        adbPath(),
        [
          '-s',
          serial,
          'exec-out',
          `CLASSPATH=${apkPath}`,
          'app_process',
          '/system/bin',
          HELPER_ENTRY_CLASS,
        ],
        { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr || error.message)))
          else resolve(stdout)
        },
      )
    })
  })
}

// ---------------------------------------------------------------------------
// ListMain stdout parsing
// ---------------------------------------------------------------------------

/**
 * Parse ListMain stdout into renderer-shaped apps.
 * @param {string} text raw JSON line: {"apps":[{"packageName","label","iconPng"?}]}
 */
export function normalizeListOutput(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text).trim())
  } catch {
    throw new Error('Invalid helper output')
  }
  if (!parsed || !Array.isArray(parsed.apps)) throw new Error('Invalid helper output')
  return parsed.apps.map((/** @type {any} */ app) => ({
    packageName: typeof app?.packageName === 'string' ? app.packageName : '',
    label: typeof app?.label === 'string' && app.label ? app.label : '',
    iconUrl:
      typeof app?.iconPng === 'string' && app.iconPng
        ? `data:image/png;base64,${app.iconPng}`
        : null,
  }))
}

/** @param {{ packageName: string, label?: string, iconUrl?: string | null }} app */
function normalizeApp(app) {
  return {
    packageName: app.packageName,
    label: app.label || app.packageName,
    iconUrl: app.iconUrl || null,
  }
}

function uniqueApps(apps) {
  const seen = new Set()
  return apps.map(normalizeApp).filter((app) => {
    if (!app.packageName || seen.has(app.packageName)) return false
    seen.add(app.packageName)
    return true
  })
}

// ---------------------------------------------------------------------------
// App-list load orchestration
// ---------------------------------------------------------------------------

/** loadId → serial; a cancelled or finished load is removed from this map. */
const activeLoads = new Map()

function isActive(loadId) {
  return activeLoads.has(loadId)
}

export function cancelInstalledAppsLoad(loadId) {
  activeLoads.delete(loadId)
}

function cancelAppLoadsForSerial(serial) {
  for (const [loadId, loadSerial] of activeLoads) {
    if (loadSerial === serial) activeLoads.delete(loadId)
  }
}

/**
 * Cancel in-flight Helper work for one device. Nothing persists on the device
 * between loads — the app_process run is one-shot — so only bookkeeping ends.
 * @param {string} serial
 */
export async function cleanupDevice(serial) {
  cancelAppLoadsForSerial(normalizeDisconnectSerial(serial))
}

/**
 * Load the installed-app list for one device and stream progress to the renderer.
 * `send` is an injected channel writer; this module never touches ipc directly.
 *
 * @param {string} serial
 * @param {number} loadId
 * @param {(payload: import('../../shared/types.js').AppLoadEvent) => void} send
 */
export async function loadInstalledApps(serial, loadId, send) {
  activeLoads.set(loadId, serial)
  const emit = (phase, apps) => {
    if (!isActive(loadId)) return
    send(apps === undefined ? { loadId, phase } : { loadId, phase, apps })
  }

  try {
    let apps
    try {
      await ensureServer()
      if (!(await isHelperInstalled(serial))) await installHelper(serial)
      if (!isActive(loadId)) return

      // One-shot shell-uid execution; labels and icons arrive inline.
      apps = uniqueApps(normalizeListOutput(await runHelperList(serial)))
    } catch (error) {
      // Setup failures become an actionable renderer prompt instead of a
      // thrown IPC error.
      if (!String(error?.message || '').startsWith(HELPER_SETUP_ERROR_PREFIX)) throw error
      const message = String(error.message).slice(HELPER_SETUP_ERROR_PREFIX.length)
      if (isActive(loadId)) send({ loadId, phase: 'error', code: 'helper-setup', message })
      return
    }
    if (!isActive(loadId)) return

    const now = Date.now()
    const snapshot = {
      authoritativeAt: now,
      writtenAt: now,
      apps: apps.map((app) => ({
        ...app,
        iconUpdatedAt: app.iconUrl ? now : null,
      })),
    }
    await writeAppCache(serial, snapshot)
    emit('authoritative', apps)
    emit('complete')
  } finally {
    activeLoads.delete(loadId)
  }
}
