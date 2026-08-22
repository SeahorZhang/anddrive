import { ensureServer } from '../adb/adbClient.js'
import { normalizeDisconnectSerial } from '../adb/errors.js'
import { ICON_REFRESH_MS, readAppCache, writeAppCache } from '../cache/appCache.js'
import {
  acquireForwardLock,
  ensureCompatibleCapabilities,
  ensureHelperReady,
  installHelper,
  isHelperInstalled,
  removeForward,
  removeForwardForSerial,
} from './helperLifecycle.js'
import { httpGetBuffer, httpGetJSON } from './helperClient.js'
import {
  ICON_BATCH_CONCURRENCY,
  ICON_BATCH_SIZE,
  helperUrl,
  parseIconBatch,
} from './helperProtocol.js'

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
 * Cancel Helper work and remove the forward owned by one device.
 * @param {string} serial
 */
export async function cleanupDevice(serial) {
  serial = normalizeDisconnectSerial(serial)
  cancelAppLoadsForSerial(serial)
  const releaseForwardLock = await acquireForwardLock()
  try {
    await removeForwardForSerial(serial)
  } finally {
    releaseForwardLock()
  }
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
 * Merge cached icon state into the fresh list and decide which icons need fetching.
 * @param {ReturnType<typeof uniqueApps>} apps
 * @param {import('../../shared/types.js').AppCacheSnapshot | null} cache
 */
export function reconcileCachedApps(apps, cache, now) {
  const cachedByPackage = new Map(cache?.apps.map((app) => [app.packageName, app]) || [])
  const snapshotApps = []
  const iconsToFetch = []
  for (const app of apps) {
    const cached = cachedByPackage.get(app.packageName)
    const iconUrl = cached?.iconUrl || null
    const iconUpdatedAt = cached?.iconUpdatedAt || null
    const reconciled = { ...app, iconUrl, iconUpdatedAt }
    snapshotApps.push(reconciled)
    if (
      !iconUrl ||
      !iconUpdatedAt ||
      now - iconUpdatedAt >= ICON_REFRESH_MS ||
      cached.label !== app.label
    ) {
      iconsToFetch.push(app)
    }
  }
  return { snapshotApps, iconsToFetch }
}

function rendererApps(apps) {
  return apps.map(({ packageName, label, iconUrl }) => ({ packageName, label, iconUrl }))
}

async function fetchIconsLegacy(apps, emit, loadId) {
  let index = 0
  async function worker() {
    while (index < apps.length) {
      if (!isActive(loadId)) return
      const app = apps[index++]
      try {
        const buffer = await httpGetBuffer(
          helperUrl(`/icon-bin?pkg=${encodeURIComponent(app.packageName)}`),
        )
        if (buffer?.length > 0)
          emit({
            packageName: app.packageName,
            iconUrl: `data:image/png;base64,${buffer.toString('base64')}`,
          })
      } catch {
        // A missing icon should not fail the rest of the list.
      }
    }
  }
  await Promise.all(Array.from({ length: ICON_BATCH_CONCURRENCY }, () => worker()))
}

async function fetchIcons(apps, emit, loadId, batchIcons) {
  if (!batchIcons) return fetchIconsLegacy(apps, emit, loadId)
  let index = 0
  let fallback = false
  async function worker() {
    while (!fallback && index < apps.length) {
      if (!isActive(loadId)) return
      const batch = apps.slice(index, (index += ICON_BATCH_SIZE))
      try {
        const packages = batch.map((app) => app.packageName).join(',')
        const buffer = await httpGetBuffer(
          helperUrl(`/icons-bin?pkgs=${encodeURIComponent(packages)}`),
        )
        if (buffer?.length > 0) emit(parseIconBatch(buffer))
        else fallback = true
      } catch {
        fallback = true
      }
    }
  }
  await Promise.all(Array.from({ length: ICON_BATCH_CONCURRENCY }, () => worker()))
  if (fallback && isActive(loadId)) await fetchIconsLegacy(apps, emit, loadId)
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
  const releaseForwardLock = await acquireForwardLock()
  const emit = (phase, apps) => {
    if (!isActive(loadId)) return
    send(apps === undefined ? { loadId, phase } : { loadId, phase, apps })
  }

  try {
    if (!isActive(loadId)) return
    await ensureServer()
    if (!(await isHelperInstalled(serial))) await installHelper(serial)
    if (!isActive(loadId)) return
    await ensureHelperReady(serial, loadId)

    const capabilities = await ensureCompatibleCapabilities(serial)

    const response = await httpGetJSON(helperUrl('/apps'))
    if (!response || !Array.isArray(response.apps)) throw new Error('Invalid app list response')
    const now = Date.now()
    const normalizedApps = uniqueApps(response.apps)
    const cache = await readAppCache(serial)
    const { snapshotApps, iconsToFetch } = reconcileCachedApps(normalizedApps, cache, now)
    const snapshotByPackage = new Map(snapshotApps.map((app) => [app.packageName, app]))
    const createSnapshot = () => ({
      authoritativeAt: now,
      writtenAt: Date.now(),
      apps: [...snapshotByPackage.values()],
    })

    await writeAppCache(serial, createSnapshot())
    emit('authoritative', rendererApps(snapshotApps))
    if (!isActive(loadId)) return

    let iconChanged = false
    const emitIcons = (apps) => {
      if (!isActive(loadId)) return
      const updates = []
      for (const app of Array.isArray(apps) ? apps : [apps]) {
        const existing = snapshotByPackage.get(app.packageName)
        if (!existing || !app.iconUrl) continue
        existing.iconUrl = app.iconUrl
        existing.iconUpdatedAt = Date.now()
        updates.push({ packageName: app.packageName, iconUrl: app.iconUrl })
      }
      if (updates.length > 0) {
        iconChanged = true
        emit('icons', updates)
      }
    }
    await fetchIcons(iconsToFetch, emitIcons, loadId, capabilities.batchIcons === true)
    if (!isActive(loadId)) return
    if (iconChanged) await writeAppCache(serial, createSnapshot())
    emit('complete')
  } finally {
    activeLoads.delete(loadId)
    try {
      await removeForward(serial, loadId)
    } catch (error) {
      console.warn('Failed to remove helper forward:', error)
    }
    releaseForwardLock()
  }
}
