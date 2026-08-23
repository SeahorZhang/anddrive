import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { adbExec, adbExecSafe } from '../adb/adbClient.js'
import { adbPath, helperApkPath } from '../paths.js'
import { HELPER_ENTRY_CLASS } from './helperList.js'

export const HELPER_PACKAGE = 'com.andrive.helper'

/**
 * Message prefix marking failures where the helper cannot be installed or run
 * on the device; the renderer turns these into an actionable install prompt.
 */
export const HELPER_SETUP_ERROR_PREFIX = 'HELPER_SETUP:'

const LIST_TIMEOUT_MS = 120000
const LIST_MAX_BUFFER_BYTES = 256 * 1024 * 1024

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
 * Remove the helper from the device. Idempotent: an already-absent package (or
 * one whose earlier install never committed) is treated as success.
 * @param {string} serial
 */
export async function uninstallHelper(serial) {
  const { code, stdout, stderr } = await adbExecSafe('-s', serial, 'uninstall', HELPER_PACKAGE)
  const output = [stdout, stderr].join(' ').trim()
  if (code === 0 || /success/i.test(output)) return true
  // adb uninstall exits non-zero with e.g. "Failure [DELETE_FAILED_INTERNAL_ERROR]"
  // when the package is already gone; confirm via pm path before treating it as
  // an idempotent success, so a genuine uninstall refusal still surfaces.
  if (!(await isHelperInstalled(serial))) return true
  throw new Error(output || '卸载 Helper 失败')
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
