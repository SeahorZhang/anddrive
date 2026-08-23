const adb = window.electronAPI.adb
import { orderApps, pruneMru } from './appOrdering'

/**
 * Owns the installed-app list for the active device: cache-first display,
 * authoritative replacement, progressive icon patches and load lifecycle
 * (loadId bookkeeping, IPC subscription, serial switching, unmount cleanup).
 *
 * @param {() => string | undefined} serial
 * @param {() => string[]} [getRecency] current recently-launched package names;
 * replacements keep their ordering.
 */
export function useInstalledApps(serial, getRecency = () => []) {
  const { getCachedInstalledApps, loadInstalledApps, cancelInstalledAppsLoad, onInstalledApp } = adb

  const apps = ref([])
  const loading = ref(false)
  const iconComplete = ref(false)
  /** Non-null when the device needs the helper installed before apps can load. */
  const setupRequired = ref(null)

  let nextLoadId = 0
  let currentLoadId = 0
  let unsubscribe = null

  /** Reorder the current list so recently launched apps come first. */
  function applyRecency(mruPackages) {
    apps.value = orderApps(apps.value, mruPackages)
  }

  /**
   * Replace the whole list while keeping known recency entries in front.
   * @param {{ packageName?: string }[] | undefined} list
   */
  function replaceAll(list) {
    apps.value = orderApps(list, pruneMru(getRecency(), list))
  }

  /**
   * Merge late-arriving icons into existing entries; unknown packages are ignored.
   * @param {{ packageName?: string, iconUrl?: string | null }[] | undefined} updates
   */
  function patchIcons(updates) {
    if (!updates?.length) return
    const byPackage = new Map(apps.value.map((app) => [app.packageName, app]))
    for (const update of updates) {
      const existing = byPackage.get(update?.packageName)
      if (!existing) continue
      byPackage.set(existing.packageName, { ...existing, iconUrl: update.iconUrl })
    }
    apps.value = [...byPackage.values()]
  }

  function stopLoad() {
    unsubscribe?.()
    unsubscribe = null
    if (currentLoadId) {
      cancelInstalledAppsLoad(currentLoadId)
      currentLoadId = 0
    }
  }

  function reset() {
    stopLoad()
    apps.value = []
    loading.value = false
    iconComplete.value = false
    setupRequired.value = null
  }

  async function load() {
    const deviceSerial = serial()
    reset()
    if (!deviceSerial) return

    loading.value = true
    const loadId = ++nextLoadId
    currentLoadId = loadId

    unsubscribe = onInstalledApp((event) => {
      if (event.loadId !== loadId) return
      if (event.phase === 'authoritative') {
        replaceAll(event.apps)
        loading.value = false
      } else if (event.phase === 'icons') {
        patchIcons(event.apps)
      } else if (event.phase === 'complete') {
        iconComplete.value = true
        loading.value = false
      } else if (event.phase === 'error' && event.code === 'helper-setup') {
        setupRequired.value = { message: event.message || '' }
        loading.value = false
      }
    })

    try {
      try {
        const cached = await getCachedInstalledApps(deviceSerial)
        if (loadId !== currentLoadId || deviceSerial !== serial()) return
        if (cached?.apps) replaceAll(cached.apps)
      } catch (e) {
        console.warn('读取app缓存失败:', e)
      }
      await loadInstalledApps(deviceSerial, loadId)
    } catch (e) {
      console.error('获取app列表失败:', e)
    } finally {
      if (loadId === currentLoadId) {
        loading.value = false
        stopLoad()
      }
    }
  }

  function dispose() {
    stopLoad()
  }

  return { apps, loading, iconComplete, setupRequired, applyRecency, reset, load, dispose }
}
