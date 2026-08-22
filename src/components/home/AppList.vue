<script setup>
import { useInstalledApps } from '../../composables/useInstalledApps'
import { useAppLauncher } from '../../composables/useAppLauncher'

const props = defineProps({
  serial: String,
})

const recencyPackages = ref([])
const installedApps = useInstalledApps(() => props.serial, () => recencyPackages.value)
const launcher = useAppLauncher(() => props.serial, installedApps, recencyPackages)
const { apps, loading } = installedApps
const { pendingIconLaunches, launchingPackages, launchErrors, requestLaunch } = launcher

const searchText = ref('')

const displayApps = computed(() => {
  if (!searchText.value) return apps.value
  const keyword = searchText.value.toLowerCase()
  return apps.value.filter(
    (app) =>
      app.label.toLowerCase().includes(keyword) || app.packageName.toLowerCase().includes(keyword),
  )
})

function load() {
  launcher.reset()
  void installedApps.load()
}

if (props.serial) load()
watch(
  () => props.serial,
  () => {
    searchText.value = ''
    load()
  },
)
onUnmounted(() => {
  launcher.reset()
  installedApps.dispose()
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

      <div v-if="loading && apps.length === 0" class="flex items-center justify-center py-8">
        <div class="text-sm text-black/40">加载中...</div>
      </div>

      <div v-if="apps.length > 0" class="grid grid-cols-5 gap-2">
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
