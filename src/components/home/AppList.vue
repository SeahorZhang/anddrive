<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from '../BaseButton.vue'
import ConfirmDialog from '../ConfirmDialog.vue'
import AppInfoDialog from '../AppInfoDialog.vue'
import ScrcpyLaunchDialog from '../ScrcpyLaunchDialog.vue'
import {
  installHelperApi,
  loadInstalledAppsApi,
  getCachedAppsApi,
  getAppIconsApi,
  uninstallHelperApi,
  deleteAppCacheApi,
  startScrcpyApi,
  forceStopAppApi,
  clearAppDataApi,
  uninstallAppApi,
  getAppInfoApi,
  exportApkApi,
} from '@/api'
import { notify, notifyError } from '@/composables/useNotifications'
import { useFavorites } from '@/composables/useFavorites'
import { scrcpyConfig } from '@/composables/useScrcpyPreferences'
import { refreshScrcpySessions } from '@/composables/useScrcpySessions'
import { copyToClipboard } from '@/utils/clipboard'
import { isHelperSetupError, readableError } from '@/utils/errors'

const props = defineProps({
  address: String,
})

/** 每批请求的图标数量 */
const ICON_BATCH_SIZE = 20
/** 同时进行的图标批次数 */
const ICON_BATCH_CONCURRENCY = 3
/** 图标缓存有效期：7 天内不重新拉取 */
const ICON_REFRESH_MS = 7 * 24 * 60 * 60 * 1000

const MENU_ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12px] text-black/75 outline-none select-none data-[highlighted]:bg-black/[0.06]'
const MENU_ITEM_DANGER_CLASS = 'text-[#ff3b30]'

/** 图标缺失或已过期才需要重新获取 */
function needsIcon(app) {
  return !app.iconUrl || Date.now() - (app.iconUpdatedAt || 0) >= ICON_REFRESH_MS
}

const apps = ref([])
const loading = ref(false)
const searchText = ref('')

/** 正在进行危险操作的应用包名，用于禁用重复触发与显示忙碌态 */
const busyPackage = ref('')

/** 按名称过滤后的应用列表，空搜索时返回全部 */
const filteredApps = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  if (!q) return apps.value
  return apps.value.filter((app) => app.label.toLowerCase().includes(q))
})

/** 收藏（置顶）状态，按设备隔离并跨重启保留 */
const { isFavorite, toggleFavorite } = useFavorites(() => props.address)

/** 收藏单独分组置顶，其余归入“全部应用” */
const sections = computed(() => {
  const list = filteredApps.value
  const favoriteApps = list.filter((app) => isFavorite(app.packageName))
  const otherApps = list.filter((app) => !isFavorite(app.packageName))
  const result = []
  if (favoriteApps.length) result.push({ key: 'favorites', title: '收藏', apps: favoriteApps })
  if (otherApps.length) {
    result.push({ key: 'all', title: favoriteApps.length ? '全部应用' : '', apps: otherApps })
  }
  return result
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
  const id = notify.loading('正在安装 Helper…', { key: 'helper-install' })
  try {
    await installHelperApi(props.address)
    notify.update(id, { type: 'success', message: 'Helper 安装成功' })
    // 获取app列表
    await getAppList()
  } catch (error) {
    notify.update(id, { type: 'error', message: readableError(error, '安装 Helper 失败') })
  }
}

async function uninstallHelper() {
  try {
    await uninstallHelperApi(props.address)
    apps.value = []
    notify.success('已从手机卸载 Helper')
  } catch (error) {
    notifyError(error, { title: '卸载 Helper 失败' })
  }
}

async function clearCache() {
  try {
    await deleteAppCacheApi(props.address)
    await getAppList()
    notify.success('缓存已清除，已重新加载')
  } catch (error) {
    notifyError(error, { title: '清除缓存失败' })
  }
}

/** 列表加载失败时给出可读提示与下一步操作。 */
function reportLoadError(error) {
  if (isHelperSetupError(error)) {
    notify.error(readableError(error, '设备上未找到 Helper'), {
      key: 'helper-setup',
      title: 'Helper 未就绪',
      action: { label: '安装 Helper', handler: installHelper },
    })
    return
  }
  notifyError(error, {
    key: 'app-list',
    title: '读取应用列表失败',
    action: { label: '重试', handler: getAppList },
  })
}

async function getAppList() {
  if (!props.address) return

  // 先用缓存秒开，避免每次进来都显示 loading；失败则忽略，继续走设备刷新
  try {
    const cached = await getCachedAppsApi(props.address)
    if (cached.length) apps.value = cached
  } catch {
    // ignore
  }

  loading.value = true
  try {
    // 第一阶段：包名 + 名称（快，无图标），带上缓存里的图标
    apps.value = await loadInstalledAppsApi(props.address)
  } catch (error) {
    reportLoadError(error)
    return
  } finally {
    loading.value = false
  }

  await loadIcons()
}

// 第二阶段：只有图标缺失或过期的才拉取，每批 20 个、3 路并发补齐
async function loadIcons() {
  const pending = apps.value.filter(needsIcon).map((app) => app.packageName)
  if (pending.length === 0) return

  let cursor = 0
  let failedBatches = 0
  async function worker() {
    while (cursor < pending.length) {
      const group = pending.slice(cursor, cursor + ICON_BATCH_SIZE)
      cursor += ICON_BATCH_SIZE
      try {
        patchIcons(await getAppIconsApi(props.address, group))
      } catch (error) {
        failedBatches += 1
        console.warn('图标批次失败：', readableError(error))
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(ICON_BATCH_CONCURRENCY, Math.ceil(pending.length / ICON_BATCH_SIZE)) },
      worker,
    ),
  )

  if (failedBatches > 0) {
    notify.error(`有 ${failedBatches} 批应用图标加载失败`, {
      key: 'app-icons',
      title: '图标加载不完整',
      action: { label: '重试', handler: loadIcons },
    })
  }
}

getAppList()

// ---------------------------------------------------------------------------
// 应用操作
// ---------------------------------------------------------------------------

function isBusy(app) {
  return busyPackage.value === app.packageName
}

async function launchApp(app) {
  try {
    await startScrcpyApi({
      serial: props.address,
      packageName: app.packageName,
      label: app.label,
      config: { ...scrcpyConfig },
    })
    await refreshScrcpySessions()
  } catch (error) {
    notifyError(error, { title: `启动 ${app.label} 失败` })
  }
}

/** 单次启动参数对话框目标 */
const launchDialogVisible = ref(false)
const launchTarget = ref(null)

function openLaunchDialog(app) {
  launchTarget.value = app
  launchDialogVisible.value = true
}

/** 危险操作统一加忙碌标记，避免重复触发 */
async function withBusy(app, task) {
  if (busyPackage.value) return
  busyPackage.value = app.packageName
  try {
    await task()
  } finally {
    busyPackage.value = ''
  }
}

async function forceStopApp(app) {
  await withBusy(app, async () => {
    try {
      await forceStopAppApi(props.address, app.packageName)
      notify.success(`已强制停止 ${app.label}`)
    } catch (error) {
      notifyError(error, { title: `强制停止 ${app.label} 失败` })
    }
  })
}

async function copyPackageName(app) {
  try {
    const ok = await copyToClipboard(app.packageName)
    if (!ok) throw new Error('剪贴板不可用')
    notify.success(`已复制包名 ${app.packageName}`)
  } catch (error) {
    notifyError(error, { title: '复制包名失败' })
  }
}

async function exportAppApk(app) {
  await withBusy(app, async () => {
    try {
      const result = await exportApkApi(props.address, app.packageName)
      if (result?.canceled) return
      const count = result?.files?.length || 0
      notify.success(`已导出 ${count} 个 APK 到 ${result.dir}`, { title: '导出成功' })
    } catch (error) {
      notifyError(error, { title: `导出 ${app.label} APK 失败` })
    }
  })
}

const infoVisible = ref(false)
const appInfo = ref(null)

async function showAppInfo(app) {
  infoVisible.value = true
  appInfo.value = { packageName: app.packageName }
  try {
    appInfo.value = await getAppInfoApi(props.address, app.packageName)
  } catch (error) {
    infoVisible.value = false
    notifyError(error, { title: `读取 ${app.label} 信息失败` })
  }
}

// ---------------------------------------------------------------------------
// 危险操作二次确认
// ---------------------------------------------------------------------------

const confirmOpen = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmLabelText = ref('确认')
const confirmError = ref('')
const confirmBusy = ref(false)
let pendingConfirm = null

function openConfirm({ title, message, confirmLabel, action }) {
  confirmTitle.value = title
  confirmMessage.value = message
  confirmLabelText.value = confirmLabel
  confirmError.value = ''
  pendingConfirm = action
  confirmOpen.value = true
}

async function handleConfirm() {
  if (!pendingConfirm) return
  confirmBusy.value = true
  confirmError.value = ''
  try {
    await pendingConfirm()
    confirmOpen.value = false
    pendingConfirm = null
  } catch (error) {
    confirmError.value = readableError(error, '操作失败')
  } finally {
    confirmBusy.value = false
  }
}

function cancelConfirm() {
  if (confirmBusy.value) return
  confirmOpen.value = false
  pendingConfirm = null
}

function confirmClearData(app) {
  openConfirm({
    title: '清除应用数据',
    message: `将清除「${app.label}」的全部数据（登录状态、设置、缓存等），且无法恢复。`,
    confirmLabel: '清除数据',
    action: async () => {
      await clearAppDataApi(props.address, app.packageName)
      notify.success(`已清除 ${app.label} 的数据`)
    },
  })
}

function confirmUninstall(app) {
  openConfirm({
    title: '卸载应用',
    message: `将从手机卸载「${app.label}」(${app.packageName})。`,
    confirmLabel: '卸载',
    action: async () => {
      await uninstallAppApi(props.address, app.packageName)
      apps.value = apps.value.filter((item) => item.packageName !== app.packageName)
      notify.success(`已卸载 ${app.label}`)
    },
  })
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="mb-3 flex items-center gap-2">
      <div class="relative flex h-8 min-w-0 flex-1 items-center">
        <Icon icon="lucide:search" :width="14" :height="14"
          class="pointer-events-none absolute left-2.5 text-black/35" />
        <input v-model="searchText" type="text" placeholder="搜索应用"
          class="h-full w-full rounded-[8px] bg-black/[0.05] pr-8 pl-8 text-[12px] text-black/80 transition-colors outline-none placeholder:text-black/30 focus:bg-black/[0.07] focus:ring-2 focus:ring-[#007aff]/35" />
        <button v-if="searchText"
          class="absolute right-2 flex size-4 cursor-pointer items-center justify-center rounded-full bg-black/20 text-white transition-colors hover:bg-black/35"
          @click="searchText = ''">
          <Icon icon="lucide:x" :width="10" :height="10" />
        </button>
      </div>

      <TooltipProvider :delay-duration="300">
        <div class="flex items-center gap-0.5 rounded-[9px] bg-black/[0.05] p-0.5">
          <TooltipRoot>
            <TooltipTrigger as-child>
              <BaseButton icon="lucide:download" icon-only :disabled="loading" @click="installHelper" />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent :side-offset="8" side="bottom"
                class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg">
                安装 Helper 到手机
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
          <TooltipRoot>
            <TooltipTrigger as-child>
              <BaseButton icon="lucide:trash-2" icon-only :disabled="loading" @click="uninstallHelper" />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent :side-offset="8" side="bottom"
                class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg">
                从手机卸载 Helper
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
          <TooltipRoot>
            <TooltipTrigger as-child>
              <BaseButton icon="lucide:eraser" icon-only :disabled="loading" @click="clearCache" />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent :side-offset="8" side="bottom"
                class="z-50 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg">
                清除缓存并重新加载
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </div>
      </TooltipProvider>
    </div>

    <ScrollAreaRoot class="min-h-0 flex-1">
      <ScrollAreaViewport
        class="h-full w-full rounded-[14px] border border-white/70 bg-white/55 shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
        <div class="p-2.5">
          <div v-if="loading && apps.length === 0"
            class="flex flex-col items-center justify-center gap-3 py-16 text-black/35">
            <span class="size-5 animate-spin rounded-full border-2 border-black/15 border-t-black/45" />
            <span class="text-[12px]">正在读取应用列表…</span>
          </div>

          <div v-else-if="filteredApps.length > 0" class="flex flex-col gap-3">
            <section v-for="section in sections" :key="section.key">
              <div v-if="section.title"
                class="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium text-black/40">
                <Icon v-if="section.key === 'favorites'" icon="lucide:star" :width="11" :height="11"
                  class="fill-current text-[#f5a623]" />
                {{ section.title }}
                <span class="text-black/25">{{ section.apps.length }}</span>
              </div>
              <div class="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1">
                <ContextMenuRoot v-for="app in section.apps" :key="app.packageName">
                  <ContextMenuTrigger as-child>
                    <div role="button" tabindex="0" :title="`启动 ${app.label}`"
                      class="group relative flex cursor-pointer flex-col items-center gap-1.5 rounded-[12px] p-2 transition-colors outline-none hover:bg-black/[0.05] focus-visible:bg-black/[0.05] active:bg-black/[0.09]"
                      @click="launchApp(app)" @keydown.enter="launchApp(app)"
                      @keydown.space.prevent="launchApp(app)">
                      <button type="button" :title="isFavorite(app.packageName) ? '取消收藏' : '收藏并置顶'"
                        :aria-pressed="isFavorite(app.packageName)"
                        class="absolute top-1 right-1 z-10 flex size-5 cursor-pointer items-center justify-center rounded-full bg-white/85 shadow-[0_1px_2px_rgba(0,0,0,0.15)] transition-opacity"
                        :class="isFavorite(app.packageName)
                          ? 'text-[#f5a623] opacity-100'
                          : 'text-black/35 opacity-0 group-hover:opacity-100 hover:text-[#f5a623]'
                          " @click.stop="toggleFavorite(app.packageName)">
                        <Icon icon="lucide:star" :width="12" :height="12"
                          :class="isFavorite(app.packageName) && 'fill-current'" />
                      </button>
                      <img v-if="app.iconUrl" :src="app.iconUrl"
                        class="pointer-events-none size-11 rounded-[11px] shadow-[0_1px_3px_rgba(0,0,0,0.14)]" />
                      <div v-else
                        class="pointer-events-none flex size-11 items-center justify-center rounded-[11px] bg-black/[0.06] text-black/25">
                        <Icon icon="lucide:package" :width="20" :height="20" />
                      </div>
                      <span
                        class="pointer-events-none w-full truncate text-center text-[11px] leading-tight text-black/70">
                        {{ app.label }}
                      </span>
                      <span v-if="isBusy(app)"
                        class="absolute inset-0 z-20 flex items-center justify-center rounded-[12px] bg-white/65">
                        <span class="size-4 animate-spin rounded-full border-2 border-black/15 border-t-black/45" />
                      </span>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuPortal>
                    <ContextMenuContent
                      class="z-[100] min-w-44 rounded-[10px] border border-black/[0.08] bg-white/95 p-1 shadow-[0_8px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl">
                      <ContextMenuItem :class="MENU_ITEM_CLASS" @select="launchApp(app)">
                        <Icon icon="lucide:play" :width="13" :height="13" class="shrink-0 text-black/40" />
                        启动
                      </ContextMenuItem>
                      <ContextMenuItem :class="MENU_ITEM_CLASS" @select="openLaunchDialog(app)">
                        <Icon icon="lucide:settings-2" :width="13" :height="13" class="shrink-0 text-black/40" />
                        启动（自定义参数）
                      </ContextMenuItem>
                      <ContextMenuItem :class="MENU_ITEM_CLASS" @select="forceStopApp(app)">
                        <Icon icon="lucide:square" :width="13" :height="13" class="shrink-0 text-black/40" />
                        强制停止
                      </ContextMenuItem>
                      <ContextMenuSeparator class="my-1 h-px bg-black/[0.06]" />
                      <ContextMenuItem :class="MENU_ITEM_CLASS" @select="showAppInfo(app)">
                        <Icon icon="lucide:info" :width="13" :height="13" class="shrink-0 text-black/40" />
                        应用信息
                      </ContextMenuItem>
                      <ContextMenuItem :class="MENU_ITEM_CLASS" @select="copyPackageName(app)">
                        <Icon icon="lucide:copy" :width="13" :height="13" class="shrink-0 text-black/40" />
                        复制包名
                      </ContextMenuItem>
                      <ContextMenuItem :class="MENU_ITEM_CLASS" @select="exportAppApk(app)">
                        <Icon icon="lucide:download" :width="13" :height="13" class="shrink-0 text-black/40" />
                        导出 APK
                      </ContextMenuItem>
                      <ContextMenuSeparator class="my-1 h-px bg-black/[0.06]" />
                      <ContextMenuItem :class="[MENU_ITEM_CLASS, MENU_ITEM_DANGER_CLASS]"
                        @select="confirmClearData(app)">
                        <Icon icon="lucide:eraser" :width="13" :height="13" class="shrink-0" />
                        清除数据
                      </ContextMenuItem>
                      <ContextMenuItem :class="[MENU_ITEM_CLASS, MENU_ITEM_DANGER_CLASS]"
                        @select="confirmUninstall(app)">
                        <Icon icon="lucide:trash-2" :width="13" :height="13" class="shrink-0" />
                        卸载
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenuPortal>
                </ContextMenuRoot>
              </div>
            </section>
          </div>

          <div v-else class="flex flex-col items-center justify-center gap-3 py-16 text-black/35">
            <Icon :icon="apps.length === 0 ? 'lucide:package' : 'lucide:search'" :width="28" :height="28"
              class="text-black/20" />
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

    <ConfirmDialog v-model="confirmOpen" :title="confirmTitle" :message="confirmMessage"
      :confirm-label="confirmLabelText" :loading="confirmBusy" :error="confirmError" @confirm="handleConfirm"
      @cancel="cancelConfirm" @close="cancelConfirm" />

    <AppInfoDialog v-model="infoVisible" :info="appInfo" />

    <ScrcpyLaunchDialog v-model="launchDialogVisible" :serial="props.address"
      :package-name="launchTarget?.packageName || ''" :label="launchTarget?.label || ''" />
  </div>
</template>
