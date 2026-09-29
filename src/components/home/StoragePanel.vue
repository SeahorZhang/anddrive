<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from '../BaseButton.vue'
import {
  getStorageVolumesApi,
  mountStorageApi,
  unmountStorageApi,
  revealStorageApi,
} from '@/api'
import { notifyError } from '@/composables/useNotifications'
import { formatStorage, clampPercent } from '@/utils/format'
import { readableError } from '@/utils/errors'

const props = defineProps({
  serial: { type: String, default: '' },
  // 挂载点目录名就是访达里的卷标题，所以得带上设备名；面板自己不知道设备叫什么。
  deviceLabel: { type: String, default: '' },
})

const loading = ref(false)
const error = ref('')
const report = ref(null)

async function load(force = false) {
  if (!props.serial || loading.value) return
  loading.value = true
  error.value = ''
  try {
    report.value = await getStorageVolumesApi(props.serial, force)
  } catch (e) {
    error.value = readableError(e, '读取设备存储失败')
  } finally {
    loading.value = false
  }
}

// 和 DeviceStats 一样：只在弹层打开时挂载，所以「每次打开都拉一次」就是全部的加载时机。
// force：主进程那份存储读数缓存 15 秒，不强制刷新会看到上一次打开时的数字。
onMounted(() => load(true))

watch(
  () => props.serial,
  () => {
    report.value = null
    error.value = ''
    load()
  },
)

const KIND_ICON = {
  shared: 'lucide:hard-drive',
  removable: 'lucide:memory-stick',
  camera: 'lucide:camera',
  root: 'lucide:folder-tree',
}

// BaseButton 表达不了"同一颗按钮里的一段"（它自带圆角与描边），所以分段按钮自己写。
// `cursor-pointer` 不能省：原生 `<button>` 在 Chromium 里默认是箭头，看着就像不能点。
const SEGMENT =
  'flex h-full cursor-pointer items-center justify-center text-[12px] font-medium text-black/70 outline-none transition-colors ' +
  'hover:bg-black/[0.03] active:bg-black/[0.07] disabled:cursor-not-allowed disabled:opacity-40 ' +
  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#007aff]/40'

// 百分比只在 shared/storageVolumes.js 里按「已用 / 总共」算一次，这里只画。
const percent = computed(() => clampPercent(report.value?.summary?.percentUsed))

const busy = ref('')

/** 挂载状态是报告的一部分，所以每次操作完都要重取一次报告。 */
async function run(volumeId, action, title) {
  if (busy.value) return
  busy.value = volumeId
  try {
    await action()
    report.value = await getStorageVolumesApi(props.serial, true)
  } catch (e) {
    notifyError(e, { title })
  } finally {
    busy.value = ''
  }
}

// 挂上之后那一格自己会变成「打开 + 弹出」，所以成功不再弹提示（失败仍然要报）。
const mountVolume = (volume) =>
  run(
    volume.id,
    () => mountStorageApi({ serial: props.serial, volumeId: volume.id, deviceLabel: props.deviceLabel }),
    '挂载失败',
  )

const unmountVolume = (volume) =>
  run(volume.id, () => unmountStorageApi(volume.id), '取消挂载失败')

const revealVolume = (volume) =>
  run(volume.id, () => revealStorageApi(volume.id), '打不开这个位置')
</script>

<template>
  <!-- 外壳（圆角/描边/阴影）由 PopoverContent 给，这里只管内容 -->
  <div class="text-[12px]">
    <div v-if="loading && !report" class="flex items-center justify-center gap-2 py-6 text-[12px] text-black/45">
      <span class="size-3.5 animate-spin rounded-full border-2 border-black/15 border-t-black/45" />
      正在读取设备存储…
    </div>

    <div v-else-if="error && !report" class="flex flex-col items-center gap-2 py-5">
      <span class="text-[12px] text-red-600">{{ error }}</span>
      <BaseButton variant="secondary" @click="load(true)">重试</BaseButton>
    </div>

    <template v-else-if="report">
      <div class="flex items-baseline justify-between gap-2">
        <div class="truncate text-[13px] font-medium tabular-nums text-black/80">
          {{ formatStorage(report.summary?.usedBytes) }}
          <span class="ml-0.5 text-[11px] font-normal text-black/40">已用</span>
        </div>
        <div class="shrink-0 text-[11px] tabular-nums text-black/45">
          共 {{ formatStorage(report.summary?.totalBytes) }} · {{ percent }}%
        </div>
      </div>
      <div class="mt-2 h-[5px] w-full overflow-hidden rounded-full bg-black/[0.07]">
        <div class="h-full rounded-full bg-[#007aff]/90" :style="{ width: `${percent}%` }" />
      </div>

      <div class="my-5 h-px bg-black/[0.07]" />

      <!-- 三格横排：挂哪个是同级决定，排成列表会让「相机」看起来像「内部存储」的子项，
           而它其实是另一个挂载点。每格就三行：图标 / 名称 / 按钮，不描边也不铺底 ——
           六个框挤在 346px 的弹层里只会显得乱。 -->
      <div class="grid grid-cols-3 gap-2">
        <div v-for="volume in report.volumes" :key="volume.id" class="flex min-w-0 flex-col items-center">
          <!-- 挂上之后图标与名称一起变蓝：这一格不描边不铺底，颜色是唯一的区别 -->
          <Icon :icon="KIND_ICON[volume.kind] || 'lucide:hard-drive'" :width="18" :height="18"
            :class="volume.mountPoint ? 'text-[#007aff]' : 'text-black/40'" />
          <div class="mt-1.5 max-w-full truncate text-[12px]"
            :class="volume.mountPoint ? 'text-[#007aff]' : 'text-black/80'" :title="volume.path">
            {{ volume.label }}
          </div>
          <div class="mt-2 flex h-7 items-center">
            <!-- 已挂载 = 一颗分段按钮：左「打开」右「弹出」，中间一条竖线。拆成两颗独立按钮
                 会比「挂载」那一格显得重，而这两个动作本来就是同一件事的两半。 -->
            <div v-if="volume.mountPoint"
              class="inline-flex h-7 overflow-hidden rounded-[7px] border border-black/10 bg-white shadow-[0_1px_1px_rgba(0,0,0,0.05)]">
              <button type="button" :class="[SEGMENT, 'px-2.5']" :disabled="busy === volume.id"
                @click="revealVolume(volume)">
                打开
              </button>
              <span class="w-px shrink-0 bg-black/[0.12]" />
              <button type="button" :class="[SEGMENT, 'px-2']" title="取消挂载" :disabled="busy === volume.id"
                @click="unmountVolume(volume)">
                <Icon icon="lucide:eject" :width="13" :height="13" />
              </button>
            </div>
            <BaseButton v-else variant="secondary" :loading="busy === volume.id" @click="mountVolume(volume)">
              挂载
            </BaseButton>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
