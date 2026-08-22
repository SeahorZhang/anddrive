import { startScrcpy } from '../services/desktopApi'

/**
 * Owns the app-launch flow: immediate launches, launches deferred until an
 * icon arrives, per-app launching/error markers and the recency (MRU) order
 * that survives reloads within a session.
 *
 * @param {() => string | undefined} serial
 * @param {{
 *   apps: import('vue').Ref<{ packageName: string, label: string, iconUrl: string | null }[]>,
 *   iconComplete: import('vue').Ref<boolean>,
 *   applyRecency: (mruPackages: string[]) => void,
 * }} installedApps
 * @param {import('vue').Ref<string[]>} recencyPackages shared recency state;
 * also read by useInstalledApps when replacing the list.
 */
export function useAppLauncher(serial, installedApps, recencyPackages) {
  const { apps, iconComplete, applyRecency } = installedApps

  const mruPackages = recencyPackages
  const pendingIconLaunches = ref(new Set())
  const launchingPackages = ref(new Set())
  const launchErrors = ref(new Map())

  function setPackageState(state, packageName, active) {
    const next = new Set(state.value)
    if (active) next.add(packageName)
    else next.delete(packageName)
    state.value = next
  }

  function setLaunchError(packageName, message) {
    const next = new Map(launchErrors.value)
    if (message) next.set(packageName, message)
    else next.delete(packageName)
    launchErrors.value = next
  }

  function promote(app) {
    mruPackages.value = [
      app.packageName,
      ...mruPackages.value.filter((pkg) => pkg !== app.packageName),
    ]
    applyRecency(mruPackages.value)
  }

  async function launch(app) {
    if (launchingPackages.value.has(app.packageName)) return

    setPackageState(launchingPackages, app.packageName, true)
    setLaunchError(app.packageName, null)
    try {
      await startScrcpy({
        serial: serial(),
        packageName: app.packageName,
        label: app.label,
        iconDataUrl: app.iconUrl,
      })
      promote(app)
    } catch (error) {
      console.error('launchApp failed:', error)
      setLaunchError(app.packageName, error?.message || '启动失败')
    } finally {
      setPackageState(launchingPackages, app.packageName, false)
    }
  }

  /**
   * @param {{ packageName: string, label: string, iconUrl: string | null }} app
   */
  function requestLaunch(app) {
    if (
      pendingIconLaunches.value.has(app.packageName) ||
      launchingPackages.value.has(app.packageName)
    )
      return

    setLaunchError(app.packageName, null)
    if (app.iconUrl) {
      void launch(app)
      return
    }
    if (iconComplete.value) {
      setLaunchError(app.packageName, '无法加载应用图标')
      return
    }
    setPackageState(pendingIconLaunches, app.packageName, true)
  }

  /** Clear recency and transient launch markers when switching devices. */
  function reset() {
    mruPackages.value = []
    pendingIconLaunches.value = new Set()
    launchingPackages.value = new Set()
  }

  // An awaited icon arrived → fire the deferred launch.
  watch(apps, (list) => {
    if (!pendingIconLaunches.value.size) return
    const ready = list.filter(
      (app) => app.iconUrl && pendingIconLaunches.value.has(app.packageName),
    )
    if (!ready.length) return
    for (const app of ready) {
      setPackageState(pendingIconLaunches, app.packageName, false)
      void launch(app)
    }
  })

  // Icon loading finished without producing every icon → fail the rest.
  watch(iconComplete, (done) => {
    if (!done || !pendingIconLaunches.value.size) return
    for (const packageName of pendingIconLaunches.value) {
      setLaunchError(packageName, '无法加载应用图标')
    }
    pendingIconLaunches.value = new Set()
  })

  return { pendingIconLaunches, launchingPackages, launchErrors, requestLaunch, reset }
}
