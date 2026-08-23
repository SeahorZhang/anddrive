import { ensureServer } from '../adb/adbClient.js'
import { normalizeDisconnectSerial } from '../adb/errors.js'
import { writeAppCache } from '../cache/appCache.js'
import {
  HELPER_SETUP_ERROR_PREFIX,
  installHelper,
  isHelperInstalled,
  runHelperList,
} from './helperApk.js'
import { normalizeListOutput } from './helperList.js'

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

/** @param {{ packageName: string, label?: string, iconUrl?: string | null }} app */
function normalizeApp(app) {
  return {
    packageName: app.packageName,
    label: app.label || app.packageName,
    iconUrl: app.iconUrl || null,
  }
}

/** @param {{ packageName: string, label?: string, iconUrl?: string | null }[]} apps */
export function uniqueApps(apps) {
  const seen = new Set()
  return apps.map(normalizeApp).filter((app) => {
    if (!app.packageName || seen.has(app.packageName)) return false
    seen.add(app.packageName)
    return true
  })
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
