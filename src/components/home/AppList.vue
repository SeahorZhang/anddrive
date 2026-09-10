<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from '../BaseButton.vue'
import {
  installHelperApi,
  loadInstalledAppsApi,
  getAppIconsApi,
  uninstallHelperApi,
  deleteAppCacheApi,
  startScrcpyApi,
} from '@/api'

const props = defineProps({
  address: String,
})

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

/** 按名称过滤后的应用列表，空搜索时返回全部 */
const filteredApps = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  if (!q) return apps.value
  return apps.value.filter((app) => app.label.toLowerCase().includes(q))
})

/** 把一批 {packageName, iconUrl, iconUpdatedAt} 合并进当前列表 */
function patchIcons(fetched) {
  const byPackage = new Map(apps.value.map((app) => [app.packageName, app]))
  for (const app of fetched || []) {
    const existing = byPackage.get(app.packageName)
    if (!existing || !app.iconUrl) continue
    existing.iconUrl = app.iconUrl
    existing.iconUpdatedAt = app.iconUpdatedAt
  }
  apps.value = [...byPackage.values()]
}

async function installHelper() {
  try {
    const stdout = await installHelperApi(props.address)
    console.log(8, stdout)

    // 获取app列表
    await getAppList()
  } catch (e) {
    console.log(e)
  }
}

async function uninstallHelper() {
  const { code, stderr, stdout } = await uninstallHelperApi(props.address)
  console.log(1, code, stderr, stdout)
  apps.value = []
}

async function clearCache() {
  await deleteAppCacheApi(props.address)
  await getAppList()
}

async function getAppList() {
  if (!props.address) return
  loading.value = true

  try {
    // 第一阶段：包名 + 名称（快，无图标），带上缓存里的图标
    apps.value = await loadInstalledAppsApi(props.address)
  } catch (error) {
    console.log('获取app列表失败', error?.message)
    return
  } finally {
    loading.value = false
  }

  // 第二阶段：只有图标缺失或过期的才拉取，每批 20 个、3 路并发补齐
  const pending = apps.value.filter(needsIcon).map((app) => app.packageName)
  if (pending.length === 0) return

  let cursor = 0
  async function worker() {
    while (cursor < pending.length) {
      const group = pending.slice(cursor, cursor + ICON_BATCH_SIZE)
      cursor += ICON_BATCH_SIZE
      try {
        patchIcons(await getAppIconsApi(props.address, group))
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

getAppList()

async function launchApp(app) {
  try {
    await startScrcpyApi({
      serial: props.address,
      packageName: app.packageName,
      label: app.label,
    })
  } catch (error) {
    console.error('launchApp failed:', error)
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="mb-3 flex items-center gap-2">
      <div class="relative flex h-8 min-w-0 flex-1 items-center">
        <Icon
          icon="lucide:search"
          :width="14"
          :height="14"
          class="pointer-events-none absolute left-2.5 text-black/35"
        />
        <input
          v-model="searchText"
          type="text"
          placeholder="搜索应用"
          class="h-full w-full rounded-[8px] bg-black/[0.05] pr-8 pl-8 text-[12px] text-black/80 transition-colors outline-none placeholder:text-black/30 focus:bg-black/[0.07] focus:ring-2 focus:ring-[#007aff]/35"
        />
        <button
          v-if="searchText"
          class="absolute right-2 flex size-4 cursor-pointer items-center justify-center rounded-full bg-black/20 text-white transition-colors hover:bg-black/35"
          @click="searchText = ''"
        >
          <Icon icon="lucide:x" :width="10" :height="10" />
        </button>
      </div>

      <TooltipProvider :delay-duration="300">
        <div class="flex items-center gap-0.5 rounded-[9px] bg-black/[0.05] p-0.5">
          <TooltipRoot>
            <TooltipTrigger as-child>
              <BaseButton
                icon="lucide:download"
                icon-only
                :disabled="loading"
                @click="installHelper"
              />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                :side-offset="8"
                side="bottom"
                class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg"
              >
                安装 Helper 到手机
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
          <TooltipRoot>
            <TooltipTrigger as-child>
              <BaseButton
                icon="lucide:trash-2"
                icon-only
                :disabled="loading"
                @click="uninstallHelper"
              />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                :side-offset="8"
                side="bottom"
                class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg"
              >
                从手机卸载 Helper
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
          <TooltipRoot>
            <TooltipTrigger as-child>
              <BaseButton icon="lucide:eraser" icon-only :disabled="loading" @click="clearCache" />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                :side-offset="8"
                side="bottom"
                class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg"
              >
                清除缓存并重新加载
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </div>
      </TooltipProvider>
    </div>

    <ScrollAreaRoot class="min-h-0 flex-1">
      <ScrollAreaViewport
        class="h-full w-full rounded-[14px] border border-white/70 bg-white/55 shadow-[0_1px_3px_rgba(0,0,0,0.05)]"
      >
        <div class="p-2.5">
          <div
            v-if="loading && apps.length === 0"
            class="flex flex-col items-center justify-center gap-3 py-16 text-black/35"
          >
            <span
              class="size-5 animate-spin rounded-full border-2 border-black/15 border-t-black/45"
            />
            <span class="text-[12px]">正在读取应用列表…</span>
          </div>

          <div
            v-else-if="filteredApps.length > 0"
            class="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1"
          >
            <button
              v-for="app in filteredApps"
              :key="app.packageName"
              type="button"
              title="点击启动"
              class="group flex cursor-pointer flex-col items-center gap-1.5 rounded-[12px] p-2 transition-colors outline-none hover:bg-black/[0.05] focus-visible:bg-black/[0.05] active:bg-black/[0.09]"
              @click="launchApp(app)"
            >
              <img
                v-if="app.iconUrl"
                :src="app.iconUrl"
                class="pointer-events-none size-11 rounded-[11px] shadow-[0_1px_3px_rgba(0,0,0,0.14)]"
              />
              <div
                v-else
                class="pointer-events-none flex size-11 items-center justify-center rounded-[11px] bg-black/[0.06] text-black/25"
              >
                <Icon icon="lucide:package" :width="20" :height="20" />
              </div>
              <span
                class="pointer-events-none w-full truncate text-center text-[11px] leading-tight text-black/70"
              >
                {{ app.label }}
              </span>
            </button>
          </div>

          <div v-else class="flex flex-col items-center justify-center gap-3 py-16 text-black/35">
            <Icon
              :icon="apps.length === 0 ? 'lucide:package' : 'lucide:search'"
              :width="28"
              :height="28"
              class="text-black/20"
            />
            <span class="text-[12px]">
              {{ apps.length === 0 ? '手机中暂无应用' : '没有找到匹配的应用' }}
            </span>
          </div>
        </div>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar orientation="vertical" class="flex w-2 touch-none p-0.5 select-none">
        <ScrollAreaThumb class="relative flex-1 rounded-full bg-black/20 hover:bg-black/30" />
      </ScrollAreaScrollbar>
    </ScrollAreaRoot>
  </div>
</template>
