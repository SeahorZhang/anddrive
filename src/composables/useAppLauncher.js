import { startScrcpy } from '../services/desktopApi'
import { orderAppsByMru, promoteToMruFront } from '../../shared/appOrdering'

/**
 * 启动意图与 MRU 排序：
 * - displayApps：按 MRU 优先对 installed 数据派生展示顺序（缓存/权威/图标 patch 共用一套规则）
 * - requestLaunch：有图标立即启动；无图标且图标仍在加载则挂起，图标到达或加载完成后结算
 * - launchingPackages / launchErrors：单次启动的去重与错误反馈
 *
 * @param {() => string} getSerial 当前 serial 的响应式取值
 * @param {ReturnType<import('./useInstalledApps').useInstalledApps>} installed
 */
export function useAppLauncher(getSerial, installed) {
  const mruPackages = ref([])
  const pendingIconLaunches = ref(new Set())
  const launchingPackages = ref(new Set())
  const launchErrors = ref(new Map())

  const displayApps = computed(
    () => orderAppsByMru(installed.appsByPackage.value.values(), mruPackages.value).apps,
  )

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

  async function launchApp(app) {
    if (launchingPackages.value.has(app.packageName)) return

    setPackageState(launchingPackages, app.packageName, true)
    setLaunchError(app.packageName, null)
    try {
      // 只提交领域数据；scrcpy CLI args 由 main 侧构建
      await startScrcpy({
        serial: getSerial(),
        packageName: app.packageName,
        label: app.label,
        iconDataUrl: app.iconUrl,
      })
      mruPackages.value = promoteToMruFront(mruPackages.value, app.packageName)
    } catch (error) {
      console.error('launchApp failed:', error)
      setLaunchError(app.packageName, error?.message || '启动失败')
    } finally {
      setPackageState(launchingPackages, app.packageName, false)
    }
  }

  function requestLaunch(app) {
    if (
      pendingIconLaunches.value.has(app.packageName) ||
      launchingPackages.value.has(app.packageName)
    )
      return

    setLaunchError(app.packageName, null)
    if (app.iconUrl) {
      void launchApp(app)
      return
    }
    if (installed.iconLoadComplete.value) {
      setLaunchError(app.packageName, '无法加载应用图标')
      return
    }
    setPackageState(pendingIconLaunches, app.packageName, true)
  }

  function clearLaunchState() {
    pendingIconLaunches.value = new Set()
    launchingPackages.value = new Set()
  }

  // 组合边界：把数据阶段事件接到启动意图与 MRU 维护上
  installed.bind({
    onReset: () => {
      mruPackages.value = []
      clearLaunchState()
    },
    onAuthoritative: (apps) => {
      const available = new Set(apps.map((app) => app.packageName))
      mruPackages.value = mruPackages.value.filter((pkg) => available.has(pkg))
    },
    onIcons: (patched) => {
      for (const app of patched) {
        if (!app.iconUrl || !pendingIconLaunches.value.has(app.packageName)) continue
        setPackageState(pendingIconLaunches, app.packageName, false)
        void launchApp(app)
      }
    },
    onComplete: () => {
      for (const packageName of pendingIconLaunches.value) {
        setLaunchError(packageName, '无法加载应用图标')
      }
      pendingIconLaunches.value = new Set()
    },
  })

  return {
    displayApps,
    mruPackages,
    pendingIconLaunches,
    launchingPackages,
    launchErrors,
    requestLaunch,
  }
}
