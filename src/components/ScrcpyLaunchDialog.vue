<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from './BaseButton.vue'
import ScrcpyConfigFields from './ScrcpyConfigFields.vue'
import SwitchToggle from './SwitchToggle.vue'
import { startMirrorApi } from '@/api'
import { readableError } from '@/utils/errors'
import { notify } from '@/composables/useNotifications'
import { refreshScrcpySessions } from '@/composables/useScrcpySessions'
import { useDeviceCodecs, useLocalCodecs } from '@/composables/useCodecCaps'
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

// 编码下拉里的标记：本机能力 + 这台设备的能力（对话框打开时目标设备就定了）。
const localCodecs = useLocalCodecs()
const deviceCodecs = useDeviceCodecs(() => props.serial)

/** 单次启动草稿：打开时从全局默认复制，修改只影响本次启动。 */
const draft = reactive({ ...SCRCPY_DEFAULTS })
const saveAsDefault = ref(false)
const launching = ref(false)

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
        <p class="px-5 pb-2 text-[11px] text-black/40">以下参数只作用于这一次启动。</p>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          <ScrcpyConfigFields :config="draft" :disabled="launching" :local-codecs="localCodecs"
            :device-codecs="deviceCodecs" @change="onChange" />
        </div>

        <!-- 整行可点，开关本身不吃点击（否则会翻两下）。 -->
        <div class="mx-5 mb-2 flex items-center gap-3 rounded-[10px] border px-3 py-2.5 transition-colors"
          :class="[saveAsDefault ? 'border-[#007aff]/35 bg-[#007aff]/[0.07]' : 'border-black/10 bg-black/[0.03]',
            launching ? 'cursor-default opacity-50' : 'cursor-pointer']"
          @click="saveAsDefault = launching ? saveAsDefault : !saveAsDefault">
          <SwitchToggle :model-value="saveAsDefault" :disabled="launching" class="pointer-events-none" />
          <span class="min-w-0 flex-1">
            <span class="block text-[12.5px] font-medium text-[#1d1d1f]">同时保存为默认参数</span>
            <span class="mt-0.5 block text-[11px] text-black/45">下次启动镜像沿用这套参数</span>
          </span>
        </div>

        <div class="flex items-center justify-between gap-2 px-5 pt-1 pb-4">
          <BaseButton variant="default" :disabled="launching" @click="applyDefaults">重置本次参数</BaseButton>
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
