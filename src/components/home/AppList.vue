<script setup>
import { useAdb } from '../../composables/useAdb'

const props = defineProps({
  serial: String,
})

const {
  getCachedInstalledApps,
  loadInstalledApps,
  cancelInstalledAppsLoad,
  onInstalledApp,
} = useAdb()

const appsByPackage = ref(new Map())
const searchText = ref('')
const loading = ref(false)
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
  const next = new Map()
  for (const app of apps || []) {
    if (app?.packageName) next.set(app.packageName, app)
  }
  appsByPackage.value = next
}

function mergeIcons(apps) {
  if (!apps?.length) return
  const next = new Map(appsByPackage.value)
  for (const app of apps) {
    const existing = next.get(app?.packageName)
    if (existing) next.set(app.packageName, { ...existing, iconUrl: app.iconUrl })
  }
  appsByPackage.value = next
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
    appsByPackage.value = new Map()
    loading.value = false
    return
  }

  stopLoad()
  appsByPackage.value = new Map()
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
onUnmounted(stopLoad)
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
          class="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-black/8 bg-gray-50 p-2 transition-all hover:border-black/12 hover:bg-gray-100"
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
