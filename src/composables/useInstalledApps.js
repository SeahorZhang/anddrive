import { adb } from '../services/desktopApi'

/**
 * 已安装应用的数据加载生命周期：
 * 缓存优先读取 → loadId 订阅 authoritative/icons/complete 事件 → serial 切换与卸载清理。
 * 只负责数据获取与加载状态；MRU 排序与启动意图由 useAppLauncher 经 bind() 组合进来。
 *
 * @param {() => string} getSerial 当前 serial 的响应式取值
 */
export function useInstalledApps(getSerial) {
  const { getCachedInstalledApps, loadInstalledApps, cancelInstalledAppsLoad, onInstalledApp } = adb

  /** 到达顺序的 app 集合（排序展示由 useAppLauncher 派生） */
  const appsByPackage = shallowRef(new Map())
  const loading = ref(false)
  const iconLoadComplete = ref(false)

  let nextLoadId = 0
  let currentLoadId = 0
  let unsubscribe = null

  /** 数据阶段回调，由 useAppLauncher 注册；全部可选。 */
  let handlers = {}
  const bind = (next) => {
    handlers = next || {}
  }

  function stopLoad() {
    unsubscribe?.()
    unsubscribe = null
    if (currentLoadId) {
      cancelInstalledAppsLoad(currentLoadId)
      currentLoadId = 0
    }
  }

  /** 清空本地数据并通知组合方重置其状态（MRU/启动意图）。 */
  function resetState() {
    appsByPackage.value = new Map()
    iconLoadComplete.value = false
    loading.value = false
    handlers.onReset?.()
  }

  /**
   * 以 packageName 去重后整表替换（后者覆盖前者），返回去重后的列表。
   * @param {(import('../../shared/types.js').InstalledApp | null | undefined)[]} apps
   */
  function setApps(apps) {
    const next = new Map()
    for (const app of apps || []) {
      if (app?.packageName) next.set(app.packageName, app)
    }
    appsByPackage.value = next
    return [...next.values()]
  }

  /**
   * 图标增量 patch：仅更新已存在的条目，返回本次真正更新的完整 app 对象。
   * @param {(import('../../shared/types.js').InstalledApp | null | undefined)[]} updates
   */
  function mergeIcons(updates) {
    if (!updates?.length) return []
    const next = new Map(appsByPackage.value)
    const patched = []
    for (const update of updates) {
      const existing = next.get(update?.packageName)
      if (!existing) continue
      const updated = { ...existing, iconUrl: update.iconUrl }
      next.set(existing.packageName, updated)
      patched.push(updated)
    }
    appsByPackage.value = next
    return patched
  }

  async function loadApps() {
    stopLoad()
    resetState()

    const serial = getSerial()
    if (!serial) return

    loading.value = true
    const loadId = ++nextLoadId
    currentLoadId = loadId
    unsubscribe = onInstalledApp(({ loadId: eventLoadId, phase, apps }) => {
      if (eventLoadId !== loadId) return
      if (phase === 'authoritative') {
        const list = setApps(apps)
        loading.value = false
        handlers.onAuthoritative?.(list)
      } else if (phase === 'icons') {
        handlers.onIcons?.(mergeIcons(apps))
      } else if (phase === 'complete') {
        iconLoadComplete.value = true
        loading.value = false
        handlers.onComplete?.()
      }
    })

    try {
      try {
        const cached = await getCachedInstalledApps(serial)
        if (loadId !== currentLoadId || serial !== getSerial()) return
        if (cached?.apps) handlers.onAuthoritative?.(setApps(cached.apps))
      } catch (e) {
        console.warn('读取app缓存失败:', e)
      }
      await loadInstalledApps(serial, loadId)
    } catch (e) {
      console.error('获取app列表失败:', e)
    } finally {
      if (loadId === currentLoadId) {
        loading.value = false
        stopLoad()
      }
    }
  }

  if (getSerial()) loadApps()
  watch(getSerial, loadApps)
  onUnmounted(() => {
    stopLoad()
    resetState()
  })

  return {
    appsByPackage,
    loading,
    iconLoadComplete,
    bind,
  }
}
