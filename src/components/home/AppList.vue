<script setup>
import { adb, startScrcpy } from '../../services/desktopApi'

const props = defineProps({
  serial: String,
})

const { getCachedInstalledApps, loadInstalledApps, cancelInstalledAppsLoad, onInstalledApp } =
  adb
const appsByPackage = ref(new Map())
const mruPackages = ref([])
const searchText = ref('')
const loading = ref(false)
const iconLoadComplete = ref(false)
const pendingIconLaunches = ref(new Set())
const launchingPackages = ref(new Set())
const launchErrors = ref(new Map())
let nextLoadId = 0
let currentLoadId = 0
let unsubscribe = null

const allApps = computed(() => [...appsByPackage.value.values()])

const displayApps = computed(() => {
  if (!searchText.value) return allApps.value
  const keyword = searchText.value.toLowerCase()
  return allApps.value.filter(
    (app) =>
      app.label.toLowerCase().includes(keyword) || app.packageName.toLowerCase().includes(keyword),
  )
})

function replaceApps(apps) {
  const available = new Map()
  for (const app of apps || []) {
    if (app?.packageName) available.set(app.packageName, app)
  }

  mruPackages.value = mruPackages.value.filter((pkg) => available.has(pkg))

  const next = new Map()
  for (const pkg of mruPackages.value) {
    next.set(pkg, available.get(pkg))
  }
  for (const [pkg, app] of available) {
    if (!next.has(pkg)) next.set(pkg, app)
  }
  appsByPackage.value = next
}

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

function promoteApp(app) {
  mruPackages.value = [
    app.packageName,
    ...mruPackages.value.filter((pkg) => pkg !== app.packageName),
  ]

  const available = new Map(appsByPackage.value)
  const next = new Map()
  for (const pkg of mruPackages.value) {
    if (available.has(pkg)) next.set(pkg, available.get(pkg))
  }
  for (const [pkg, availableApp] of available) {
    if (!next.has(pkg)) next.set(pkg, availableApp)
  }
  appsByPackage.value = next
}

function mergeIcons(apps) {
  if (!apps?.length) return
  const next = new Map(appsByPackage.value)
  const readyToLaunch = []
  for (const app of apps) {
    const existing = next.get(app?.packageName)
    if (!existing) continue
    const updated = { ...existing, iconUrl: app.iconUrl }
    next.set(app.packageName, updated)
    if (updated.iconUrl && pendingIconLaunches.value.has(updated.packageName)) {
      readyToLaunch.push(updated)
    }
  }
  appsByPackage.value = next
  for (const app of readyToLaunch) {
    setPackageState(pendingIconLaunches, app.packageName, false)
    void launchApp(app)
  }
}

async function launchApp(app) {
  if (launchingPackages.value.has(app.packageName)) return

  setPackageState(launchingPackages, app.packageName, true)
  setLaunchError(app.packageName, null)
  try {
    await startScrcpy({
      args: [
        '-s',
        props.serial,
        '--new-display=1920x1080/320',
        `--start-app=${app.packageName}`,
        '--video-codec=h265',
        '-b',
        '24M',
        '--window-x=auto',
        '--window-y=auto',
        `--window-title=${app.label}`,
      ],
      iconDataUrl: app.iconUrl,
      packageName: app.packageName,
    })
    promoteApp(app)
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
  if (iconLoadComplete.value) {
    setLaunchError(app.packageName, '无法加载应用图标')
    return
  }
  setPackageState(pendingIconLaunches, app.packageName, true)
}

function clearLaunchState(message) {
  if (message) {
    for (const packageName of pendingIconLaunches.value) {
      setLaunchError(packageName, message)
    }
  }
  pendingIconLaunches.value = new Set()
  launchingPackages.value = new Set()
}

function stopLoad() {
  unsubscribe?.()
  unsubscribe = null
  if (currentLoadId) {
    cancelInstalledAppsLoad(currentLoadId)
    currentLoadId = 0
  }
}

async function loadApps() {
  if (!props.serial) {
    stopLoad()
    clearLaunchState()
    appsByPackage.value = new Map()
    mruPackages.value = []
    iconLoadComplete.value = false
    loading.value = false
    return
  }

  stopLoad()
  clearLaunchState()
  appsByPackage.value = new Map()
  mruPackages.value = []
  iconLoadComplete.value = false
  loading.value = true

  const serial = props.serial
  const loadId = ++nextLoadId
  currentLoadId = loadId
  unsubscribe = onInstalledApp(({ loadId: eventLoadId, phase, apps }) => {
    if (eventLoadId !== loadId) return
    if (phase === 'authoritative') {
      replaceApps(apps)
      loading.value = false
    } else if (phase === 'icons') {
      mergeIcons(apps)
    } else if (phase === 'complete') {
      for (const packageName of pendingIconLaunches.value) {
        setLaunchError(packageName, '无法加载应用图标')
      }
      pendingIconLaunches.value = new Set()
      iconLoadComplete.value = true
      loading.value = false
    }
  })

  try {
    try {
      const cached = await getCachedInstalledApps(serial)
      if (loadId !== currentLoadId || serial !== props.serial) return
      if (cached?.apps) replaceApps(cached.apps)
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

if (props.serial) loadApps()
watch(() => props.serial, loadApps)
onUnmounted(() => {
  stopLoad()
  clearLaunchState()
})
</script>

<template>
  <ScrollAreaRoot class="h-0 flex-1">
    <ScrollAreaViewport class="h-full w-full">
      <div class="relative mb-3">
        <input
          v-model="searchText"
          type="text"
          placeholder="搜索..."
          class="w-full rounded-lg border border-black/10 bg-gray-100 px-3 py-1.5 text-[11px] text-black/80 placeholder-black/30 transition-colors outline-none focus:border-blue-500/50"
        />
      </div>

      <div v-if="loading && allApps.length === 0" class="flex items-center justify-center py-8">
        <div class="text-sm text-black/40">加载中...</div>
      </div>

      <div v-if="allApps.length > 0" class="grid grid-cols-5 gap-2">
        <div
          v-for="app in displayApps"
          :key="app.packageName"
          class="relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-black/8 bg-gray-50 p-2 transition-all hover:border-black/12 hover:bg-gray-100"
          :class="{
            'cursor-wait opacity-60':
              pendingIconLaunches.has(app.packageName) || launchingPackages.has(app.packageName),
          }"
          @click="requestLaunch(app)"
        >
          <img
            v-if="app.iconUrl"
            :src="app.iconUrl"
            class="pointer-events-none h-8 w-8 rounded-lg"
          />
          <div
            v-else
            class="pointer-events-none flex h-8 w-8 items-center justify-center rounded-lg bg-gray-200"
          >
            <svg
              class="h-4 w-4 text-black/20"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
          </div>
          <span class="pointer-events-none w-full truncate text-center text-[10px] text-black/60">{{
            app.label
          }}</span>
          <span
            v-if="
              pendingIconLaunches.has(app.packageName) || launchingPackages.has(app.packageName)
            "
            class="pointer-events-none absolute top-1 right-1 h-2 w-2 animate-pulse rounded-full bg-blue-500"
          />
          <span
            v-else-if="launchErrors.has(app.packageName)"
            class="pointer-events-none absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500"
            :title="launchErrors.get(app.packageName)"
          />
        </div>
      </div>

      <div
        v-if="!loading && displayApps.length === 0"
        class="flex items-center justify-center py-8"
      >
        <div class="text-sm text-black/40">
          {{ searchText ? '未找到匹配的app' : '暂无app' }}
        </div>
      </div>
    </ScrollAreaViewport>
    <ScrollAreaScrollbar orientation="vertical">
      <ScrollAreaThumb />
    </ScrollAreaScrollbar>
  </ScrollAreaRoot>
</template>
