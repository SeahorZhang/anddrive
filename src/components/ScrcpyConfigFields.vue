<script setup>
import SwitchToggle from './SwitchToggle.vue'
import { DISPLAY_QUALITY_TIERS } from '../../shared/scrcpyConfig.js'

/**
 * scrcpy 参数表单。无内部状态：读取 `config`，字段变化时 emit `change(key, value)`，
 * 由父组件决定写回全局偏好还是单次启动草稿。
 */
const props = defineProps({
  config: { type: Object, required: true },
  disabled: Boolean,
})
const emit = defineEmits(['change'])

const SELECT_CLASS =
  'h-7 max-w-[190px] cursor-pointer rounded-[7px] border border-black/10 bg-white px-2 text-[12px] text-black/70 outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[#007aff]/40'

const BIT_RATE_OPTIONS = ['8M', '16M', '24M', '32M']
const FPS_OPTIONS = [30, 60, 90, 120]
const CODEC_OPTIONS = [
  { value: 'h264', label: 'H.264' },
  { value: 'h265', label: 'H.265' },
  { value: 'av1', label: 'AV1' },
]
// 倍率从 DISPLAY_QUALITY_TIERS 取，标签里不再手抄数字（档位数值改了这里跟着变）。
const QUALITY_META = {
  compat: { name: '兼容', note: '给排版的异常应用' },
  native: { name: '均衡', note: '屏幕原生精度' },
  sharp: { name: '清晰', note: '最费带宽' },
}
const QUALITY_OPTIONS = Object.entries(DISPLAY_QUALITY_TIERS).map(([value, scale]) => {
  const meta = QUALITY_META[value] ?? { name: value, note: '' }
  return { value, label: `${meta.name}（${scale}x${meta.note ? `，${meta.note}` : ''}）` }
})
const SCREEN_OPTIONS = [
  { value: 'keepActive', label: '保持亮屏' },
  { value: 'turnOff', label: '启动后息屏' },
  { value: 'normal', label: '不干预' },
]

function update(key, value) {
  emit('change', key, value)
}
</script>

<template>
  <div
    class="divide-y divide-black/[0.06] overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur"
  >
    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-black/70">视频码率</div>
        <div class="mt-0.5 text-[11px] text-black/40">码率越高画质越好，网络占用也越大</div>
      </div>
      <select :class="SELECT_CLASS" :value="props.config.bitRate" :disabled="disabled"
        @change="update('bitRate', $event.target.value)">
        <option v-for="rate in BIT_RATE_OPTIONS" :key="rate" :value="rate">{{ rate }}</option>
      </select>
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-black/70">帧率上限</div>
        <div class="mt-0.5 text-[11px] text-black/40">限制镜像的最大帧率</div>
      </div>
      <select :class="SELECT_CLASS" :value="props.config.maxFps" :disabled="disabled"
        @change="update('maxFps', Number($event.target.value))">
        <option v-for="fps in FPS_OPTIONS" :key="fps" :value="fps">{{ fps }} fps</option>
      </select>
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-black/70">视频编码</div>
        <div class="mt-0.5 text-[11px] text-black/40">H.265/AV1 更省流量，部分设备可能不支持</div>
      </div>
      <select :class="SELECT_CLASS" :value="props.config.videoCodec" :disabled="disabled"
        @change="update('videoCodec', $event.target.value)">
        <option v-for="codec in CODEC_OPTIONS" :key="codec.value" :value="codec.value">
          {{ codec.label }}
        </option>
      </select>
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-black/70">画质档位</div>
        <div class="mt-0.5 text-[11px] text-black/40">
          镜像画面的像素倍率，会话建立时读取（改动不影响进行中的镜像）。
          实测只影响清晰度与带宽、不影响帧率：Wi-Fi 不稳时降到均衡
        </div>
      </div>
      <select :class="SELECT_CLASS" :value="props.config.quality" :disabled="disabled"
        @change="update('quality', $event.target.value)">
        <option v-for="tier in QUALITY_OPTIONS" :key="tier.value" :value="tier.value">
          {{ tier.label }}
        </option>
      </select>
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-black/70">屏幕策略</div>
        <div class="mt-0.5 text-[11px] text-black/40">控制启动后手机屏幕的亮灭状态</div>
      </div>
      <select :class="SELECT_CLASS" :value="props.config.screenMode" :disabled="disabled"
        @change="update('screenMode', $event.target.value)">
        <option v-for="mode in SCREEN_OPTIONS" :key="mode.value" :value="mode.value">
          {{ mode.label }}
        </option>
      </select>
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-black/70">音频转发</div>
        <div class="mt-0.5 text-[11px] text-black/40">把设备声音转发到电脑播放</div>
      </div>
      <SwitchToggle :model-value="props.config.audio" :disabled="disabled"
        @update:model-value="(value) => update('audio', value)" />
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-black/70">窗口置顶</div>
        <div class="mt-0.5 text-[11px] text-black/40">镜像窗口始终显示在其他窗口之上</div>
      </div>
      <SwitchToggle :model-value="props.config.alwaysOnTop" :disabled="disabled"
        @update:model-value="(value) => update('alwaysOnTop', value)" />
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-black/70">全屏启动</div>
        <div class="mt-0.5 text-[11px] text-black/40">镜像窗口以全屏模式打开</div>
      </div>
      <SwitchToggle :model-value="props.config.fullscreen" :disabled="disabled"
        @update:model-value="(value) => update('fullscreen', value)" />
    </div>
  </div>
</template>
