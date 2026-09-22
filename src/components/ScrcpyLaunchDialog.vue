<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from './BaseButton.vue'
import ScrcpyConfigFields from './ScrcpyConfigFields.vue'
import { startMirrorApi } from '@/api'
import { readableError } from '@/utils/errors'
import { notify } from '@/composables/useNotifications'
import { refreshScrcpySessions } from '@/composables/useScrcpySessions'
import {
  scrcpyConfig,
  SCRCPY_DEFAULTS,
} from '@/composables/useScrcpyPreferences'

const modelValue = defineModel({ type: Boolean, default: false })
const props = defineProps({
  serial: { type: String, default: '' },
  packageName: { type: String, default: '' },
  label: { type: String, default: '' },
  iconUrl: { type: String, default: '' },
})

/** 单次启动草稿：打开时从全局默认复制，修改只影响本次启动。 */
const draft = reactive({ ...SCRCPY_DEFAULTS })
const saveAsDefault = ref(false)
const launching = ref(false)
draft.engine = 'native'

const error = ref('')

watch(modelValue, (open) => {
  if (!open) return
  Object.assign(draft, scrcpyConfig)
  saveAsDefault.value = false
  error.value = ''
})

function onChange(key, value) {
  draft[key] = value
}

function applyDefaults() {
  Object.assign(draft, SCRCPY_DEFAULTS)
}

async function launch() {
  if (launching.value) return
  launching.value = true
  error.value = ''
  try {
    const payload = {
      serial: props.serial,
      packageName: props.packageName,
      label: props.label,
      iconUrl: props.iconUrl || undefined,
      config: { ...draft },
    }
    await startMirrorApi(payload)
    if (saveAsDefault.value) Object.assign(scrcpyConfig, draft)
    await refreshScrcpySessions()
    notify.success(`已启动 ${props.label}`, { title: '镜像已开启' })
    modelValue.value = false
  } catch (e) {
    error.value = readableError(e, '启动镜像失败')
  } finally {
    launching.value = false
  }
}
</script>

<template>
  <DialogRoot v-model:open="modelValue">
    <DialogPortal>
      <DialogOverlay
        class="data-[state=open]:animate-in data-[state=open]:fade-in fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
      <DialogContent
        class="data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[420px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[16px] border border-white/60 bg-white/90 shadow-[0_16px_48px_rgba(0,0,0,0.22)] outline-none backdrop-blur-2xl">
        <div class="flex items-center justify-between px-5 pt-4 pb-2">
          <DialogTitle class="text-[14px] font-semibold text-[#1d1d1f]">
            启动镜像 · {{ label }}
          </DialogTitle>
          <button
            class="flex size-6 cursor-pointer items-center justify-center rounded-full text-black/35 transition-colors hover:bg-black/[0.06] hover:text-black/60"
            @click="modelValue = false">
            <Icon icon="lucide:x" :width="14" :height="14" />
          </button>
        </div>
        <p class="px-5 pb-2 text-[11px] text-black/40">本次启动参数仅对当前窗口生效，可勾选保存为默认。</p>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          <ScrcpyConfigFields :config="draft" :disabled="launching" @change="onChange" />
          <label class="mt-3 flex cursor-pointer items-center gap-2 px-1 text-[12px] text-black/60">
            <input v-model="saveAsDefault" type="checkbox" class="size-3.5 accent-[#007aff]" />
            同时保存为默认参数
          </label>
          <p class="mt-1 px-1 text-[11px] text-black/40">
            自研引擎支持 H.264 / H.265（需平台硬解），AV1 会自动回落到 H.264。
          </p>
          <p class="mt-1 px-1 text-[11px] text-black/40">
            镜像以虚拟大屏打开：应用按镜像窗口的比例铺满，拖动窗口时画面自动跟随重排（期间有短暂遮罩）。
          </p>
        </div>

        <div class="flex items-center justify-between gap-2 px-5 pt-1 pb-4">
          <BaseButton variant="default" :disabled="launching" @click="applyDefaults">恢复默认</BaseButton>
          <div class="flex items-center gap-2">
            <BaseButton variant="secondary" :disabled="launching" @click="modelValue = false">取消</BaseButton>
            <BaseButton variant="primary" :loading="launching" @click="launch">启动</BaseButton>
          </div>
        </div>
        <p v-if="error" class="px-5 pb-3 text-[11px] text-red-600">{{ error }}</p>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
