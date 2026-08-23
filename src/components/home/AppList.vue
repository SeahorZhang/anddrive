<script setup>
import BaseButton from '../BaseButton.vue'

const props = defineProps({
  serial: String,
})

const adb = window.electronAPI.adb

/** 每批请求的图标数量 */
const ICON_BATCH_SIZE = 20
/** 同时进行的图标批次数 */
const ICON_BATCH_CONCURRENCY = 3
/** 图标缓存有效期：7 天内不重新拉取 */
const ICON_REFRESH_MS = 7 * 24 * 60 * 60 * 1000

/** 图标缺失或已过期才需要重新获取 */
function needsIcon(app) {
  return !app.iconUrl || Date.now() - (app.iconUpdatedAt || 0) >= ICON_REFRESH_MS
}

const apps = ref([])
const loading = ref(false)
const searchText = ref('')

const displayApps = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()
  if (!keyword) return apps.value
  return apps.value.filter(
    (app) =>
      app.label.toLowerCase().includes(keyword) || app.packageName.toLowerCase().includes(keyword),
  )
})

/** 加载已安装 app 列表（helper 未装时会自动先安装），再按批补图标 */
async function getAppList() {
  if (!props.serial) return
  loading.value = true
  try {
    // 第一阶段：包名 + 名称（快，无图标）
    apps.value = await adb.loadInstalledApps(props.serial)
  } catch (error) {
    console.log('获取app列表失败', error?.message)
    loading.value = false
    return
  }
  loading.value = false

  // 第二阶段：缓存缺失/过期的图标，按每组 20 个、3 路并发补齐
  const pending = apps.value.filter(needsIcon).map((app) => app.packageName)
  if (pending.length === 0) return

  let cursor = 0
  async function worker() {
    while (cursor < pending.length) {
      const group = pending.slice(cursor, cursor + ICON_BATCH_SIZE)
      cursor += ICON_BATCH_SIZE
      try {
        patchIcons(await adb.getAppIcons(props.serial, group))
      } catch (error) {
        console.log('图标批次失败', error?.message)
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(ICON_BATCH_CONCURRENCY, Math.ceil(pending.length / ICON_BATCH_SIZE)) },
      worker,
    ),
  )
}

/** 把一批 {packageName, iconUrl} 合并进当前列表 */
function patchIcons(fetched) {
  const byPackage = new Map(apps.value.map((app) => [app.packageName, app]))
  for (const app of fetched || []) {
    const existing = byPackage.get(app.packageName)
    if (!existing || !app.iconUrl) continue
    existing.iconUrl = app.iconUrl
  }
  apps.value = [...byPackage.values()]
}

async function installHelper() {
  const stdout = await adb.installHelper(props.serial)
  if (!stdout.includes('Success')) return console.log('安装失败')

  // 获取app列表
  await getAppList()
}

async function uninstallHelper() {
  const { code, stderr, stdout } = await adb.uninstallHelper(props.serial)
  console.log(1, code, stderr, stdout)
  // 这台 ROM 卸载成功也返回 code 1 + Failure，所以不做失败分支；仅清空本地列表。
  // 注意：任何一次 getAppList() 都会自动重装 Helper。
  apps.value = []
}

async function clearCache() {
  await adb.deleteAppCache(props.serial)
  await getAppList()
}

getAppList()
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
          :disabled="loading"
          title="安装 Helper 到手机"
          @click="installHelper"
        />
        <BaseButton
          icon="lucide:trash-2"
          icon-only
          :disabled="loading"
          title="从手机卸载 Helper"
          @click="uninstallHelper"
        />
        <BaseButton
          icon="lucide:eraser"
          icon-only
          :disabled="loading"
          title="清除应用缓存列表并重新加载"
          @click="clearCache"
        />
      </div>

      <div v-if="loading && apps.length === 0" class="flex items-center justify-center py-8">
        <div class="text-sm text-black/40">加载中...</div>
      </div>

      <div v-if="apps.length > 0" class="grid grid-cols-5 gap-2">
        <div
          v-for="app in displayApps"
          :key="app.packageName"
          class="flex flex-col items-center gap-1 rounded-lg border border-black/8 bg-gray-50 p-2 transition-all hover:border-black/12 hover:bg-gray-100"
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
