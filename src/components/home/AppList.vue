<script setup>
import BaseButton from '../BaseButton.vue'
import { useInstalledApps } from '../../composables/useInstalledApps'
import { useAppLauncher } from '../../composables/useAppLauncher'

const props = defineProps({
  serial: String,
})

const adb = window.electronAPI.adb

const recencyPackages = ref([])
const installedApps = useInstalledApps(
  () => props.serial,
  () => recencyPackages.value,
)
const launcher = useAppLauncher(() => props.serial, installedApps, recencyPackages)
const { apps, loading, setupRequired } = installedApps
const { pendingIconLaunches, launchingPackages, launchErrors, requestLaunch } = launcher

const searchText = ref('')
const maintenanceBusy = ref(null) // 'uninstall' | 'install' | 'cache' | null
const notice = ref(null) // { type: 'ok' | 'error', text: string }

const displayApps = computed(() => {
  if (!searchText.value) return apps.value
  const keyword = searchText.value.toLowerCase()
  return apps.value.filter(
    (app) =>
      app.label.toLowerCase().includes(keyword) || app.packageName.toLowerCase().includes(keyword),
  )
})

async function runMaintenance(action, label, after) {
  if (!props.serial || maintenanceBusy.value) return false
  maintenanceBusy.value = action
  notice.value = null
  try {
    await after()
    return true
  } catch (error) {
    notice.value = { type: 'error', text: error?.message || `${label}失败` }
    return false
  } finally {
    maintenanceBusy.value = null
  }
}

async function uninstallHelper() {
  try {
    await adb.uninstallHelper(props.serial)
  } catch (e) {
    console.log(11, e)
  }
  // installedApps.reset()
  // notice.value = { type: 'ok', text: 'Helper 已卸载，点击安装按钮或重新加载可恢复' }
}

function installHelper() {
  void runMaintenance('install', '安装 Helper', async () => {
    await adb.installHelper(props.serial)
    await installedApps.load()
    notice.value = { type: 'ok', text: 'Helper 已安装，列表已刷新' }
  })
}

function clearCache() {
  void runMaintenance('cache', '清除缓存', async () => {
    await adb.deleteAppCache(props.serial)
    await installedApps.load()
    notice.value = { type: 'ok', text: '缓存已清除，已从设备重新加载列表' }
  })
}

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
      <div class="mb-3 flex items-center gap-1.5">
        <input
          v-model="searchText"
          type="text"
          placeholder="搜索..."
          class="min-w-0 flex-1 rounded-lg border border-black/10 bg-gray-100 px-3 py-1.5 text-[11px] text-black/80 placeholder-black/30 transition-colors outline-none focus:border-blue-500/50"
        />
        <BaseButton
          icon="lucide:download"
          icon-only
          :loading="maintenanceBusy === 'install'"
          :disabled="!!maintenanceBusy && maintenanceBusy !== 'install'"
          title="安装 Helper 到手机"
          @click="installHelper"
        />
        <BaseButton
          icon="lucide:trash-2"
          icon-only
          :loading="maintenanceBusy === 'uninstall'"
          :disabled="!!maintenanceBusy && maintenanceBusy !== 'uninstall'"
          title="从手机卸载 Helper"
          @click="uninstallHelper"
        />
        <BaseButton
          icon="lucide:eraser"
          icon-only
          :loading="maintenanceBusy === 'cache'"
          :disabled="!!maintenanceBusy && maintenanceBusy !== 'cache'"
          title="清除应用缓存列表并重新加载"
          @click="clearCache"
        />
      </div>

      <div
        v-if="notice"
        class="mb-3 rounded-lg px-3 py-2 text-[11px]"
        :class="
          notice.type === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-600'
        "
      >
        {{ notice.text }}
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
        v-if="!loading && displayApps.length === 0 && setupRequired"
        class="flex flex-col items-center gap-3 py-12"
      >
        <div class="text-base font-semibold text-black/80">安装 AndroMeld Helper</div>
        <p class="max-w-[280px] text-center text-xs leading-5 text-black/50">
          此功能需要先在 Android 设备上安装辅助 APK。
        </p>
        <BaseButton
          variant="primary"
          size="md"
          :loading="maintenanceBusy === 'install'"
          @click="installHelper"
        >
          安装辅助 APK
        </BaseButton>
      </div>

      <div
        v-else-if="!loading && displayApps.length === 0"
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
