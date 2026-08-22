import { getBuffer, getJson } from './helperClient.js'
import { helperUrl, parseIconBatch } from './helperProtocol.js'
import { ICON_REFRESH_MS } from '../cache/appCacheSchema.js'
import { readAppCache, writeAppCache } from '../cache/appCache.js'

// 应用列表编排：缓存优先、权威列表、图标渐进/批量加载与取消。
// 通过工厂注入 helper 会话能力，进度经 emit(AppLoadEvent) 回调上报，
// 不直接触碰 ipc sender。

const ICON_BATCH_SIZE = 24
const ICON_BATCH_CONCURRENCY = 4

/**
 * 归一化后的应用条目。
 * @typedef {{ packageName: string, label: string, iconUrl: string | null }} NormalizedApp
 */

/** @param {{ packageName?: unknown, label?: unknown, iconUrl?: unknown }} app @returns {NormalizedApp} */
export function normalizeApp(app) {
  return {
    packageName: /** @type {string} */ (app.packageName),
    label: /** @type {string} */ (app.label || app.packageName),
    iconUrl: /** @type {string | null} */ (app.iconUrl || null),
  }
}

/** @param {Array<{ packageName?: unknown, label?: unknown, iconUrl?: unknown }>} apps @returns {NormalizedApp[]} */
export function uniqueApps(apps) {
  const seen = new Set()
  return apps.map(normalizeApp).filter((app) => {
    if (!app.packageName || seen.has(app.packageName)) return false
    seen.add(app.packageName)
    return true
  })
}

/**
 * 用缓存补齐快照（图标、时间戳），并挑出需要刷新图标的 app。
 * @param {NormalizedApp[]} apps
 * @param {import('../../shared/types.js').AppCacheSnapshot|null} cache
 * @param {number} now
 * @returns {{ snapshotApps: import('../../shared/types.js').CachedInstalledApp[], iconsToFetch: NormalizedApp[] }}
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
      cached?.label !== app.label
    ) {
      iconsToFetch.push(app)
    }
  }
  return { snapshotApps, iconsToFetch }
}

/**
 * @param {NormalizedApp[]} apps
 * @returns {import('../../shared/types.js').InstalledApp[]}
 */
export function rendererApps(apps) {
  return apps.map(({ packageName, label, iconUrl }) => ({ packageName, label, iconUrl }))
}

/**
 * @param {{
 *   isInstalled: (serial: string) => Promise<boolean>,
 *   install: (serial: string) => Promise<void>,
 *   ensureReady: (serial: string, sessionId: string|number) => Promise<void>,
 *   ensureProtocol: (serial: string) => Promise<void>,
 *   releaseSession: (serial: string, sessionId: string|number) => Promise<void>,
 *   acquireForwardLock: () => Promise<() => void>,
 * }} helper
 */
export function createAppLoader(helper) {
  /** @type {Map<number, string>} */
  const activeLoads = new Map()

  /** @param {number} loadId */
  const isActive = (loadId) => activeLoads.has(loadId)

  /**
   * @param {{ loadId: number, apps: NormalizedApp[], onIcons: (apps: import('../../shared/types.js').IconUpdate[]) => void }} options
   */
  async function fetchIconsLegacy({ loadId, apps, onIcons }) {
    let index = 0
    async function worker() {
      while (index < apps.length) {
        if (!isActive(loadId)) return
        const app = apps[index++]
        try {
          const buffer = await getBuffer(
            helperUrl(`/icon-bin?pkg=${encodeURIComponent(app.packageName)}`),
          )
          if (buffer?.length > 0 && isActive(loadId)) {
            onIcons([
              {
                packageName: app.packageName,
                iconUrl: `data:image/png;base64,${buffer.toString('base64')}`,
              },
            ])
          }
        } catch {
          // A missing icon should not fail the rest of the list.
        }
      }
    }
    await Promise.all(Array.from({ length: ICON_BATCH_CONCURRENCY }, () => worker()))
  }

  /**
   * @param {{ loadId: number, apps: NormalizedApp[], onIcons: (apps: import('../../shared/types.js').IconUpdate[]) => void }} options
   */
  async function fetchIconsBatched({ loadId, apps, onIcons }) {
    let index = 0
    let fallback = false
    async function worker() {
      while (!fallback && index < apps.length) {
        if (!isActive(loadId)) return
        const batch = apps.slice(index, (index += ICON_BATCH_SIZE))
        try {
          const packages = batch.map((app) => app.packageName).join(',')
          const buffer = await getBuffer(
            helperUrl(`/icons-bin?pkgs=${encodeURIComponent(packages)}`),
          )
          if (buffer?.length > 0 && isActive(loadId)) onIcons(parseIconBatch(buffer))
          else fallback = true
        } catch {
          fallback = true
        }
      }
    }
    await Promise.all(Array.from({ length: ICON_BATCH_CONCURRENCY }, () => worker()))
    if (fallback && isActive(loadId)) await fetchIconsLegacy({ loadId, apps, onIcons })
  }

  return {
    /**
     * @param {{ serial: string, loadId: number, emit: (event: import('../../shared/types.js').AppLoadEvent) => void }} options
     */
    async load({ serial, loadId, emit }) {
      activeLoads.set(loadId, serial)
      const release = await helper.acquireForwardLock()

      try {
        if (!isActive(loadId)) return
        if (!(await helper.isInstalled(serial))) await helper.install(serial)
        if (!isActive(loadId)) return
        await helper.ensureReady(serial, loadId)
        await helper.ensureProtocol(serial)

        const capabilities = await getJson(helperUrl('/ping'), 0).catch(() => ({}))
        const response = await getJson(helperUrl('/apps'))
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
        emit({ loadId, phase: 'authoritative', apps: rendererApps(snapshotApps) })
        if (!isActive(loadId)) return

        let iconChanged = false
        /**
         * @param {import('../../shared/types.js').IconUpdate[]} apps
         */
        const onIcons = (apps) => {
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
            emit({ loadId, phase: 'icons', apps: updates })
          }
        }

        const context = { loadId, apps: iconsToFetch, onIcons }
        if (capabilities?.batchIcons === true) await fetchIconsBatched(context)
        else await fetchIconsLegacy(context)
        if (!isActive(loadId)) return
        if (iconChanged) await writeAppCache(serial, createSnapshot())
        emit({ loadId, phase: 'complete' })
      } finally {
        activeLoads.delete(loadId)
        try {
          await helper.releaseSession(serial, loadId)
        } catch (error) {
          console.warn('Failed to remove helper forward:', error)
        }
        release()
      }
    },

    /**
     * @param {number} loadId
     */
    cancelLoad(loadId) {
      activeLoads.delete(loadId)
    },

    /**
     * @param {string} serial
     */
    cancelForSerial(serial) {
      for (const [loadId, loadSerial] of activeLoads) {
        if (loadSerial === serial) activeLoads.delete(loadId)
      }
    },
  }
}
