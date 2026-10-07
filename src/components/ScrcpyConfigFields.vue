<script setup>
import SwitchToggle from './SwitchToggle.vue'
import {
  DISPLAY_QUALITY_TIERS,
  DISPLAY_QUALITY_BIT_RATES,
  planCodecList,
} from '../../shared/scrcpyConfig.js'

/**
 * scrcpy 参数表单。无内部状态：读取 `config`，字段变化时 emit `change(patch)`，
 * 由父组件决定写回全局偏好还是单次启动草稿。patch 是对象（一次可能改多个字段，
 * 比如选画质档位会同时改倍率与码率）。
 */
const props = defineProps({
  config: { type: Object, required: true },
  disabled: Boolean,
  /** 设备侧能编哪些（`parseEncoderMimes` 的 `usable`），null = 还不知道（设置页没有目标设备）。 */
  deviceCodecs: { type: Object, default: null },
  /** 本机 WebCodecs 能解哪些，null = 探测还没回来。 */
  localCodecs: { type: Object, default: null },
})
const emit = defineEmits(['change'])

const SELECT_CLASS =
  'h-7 max-w-[190px] cursor-pointer rounded-[7px] border border-line bg-surface-2 px-2 text-[12px] text-ink-2 outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/40'

const FPS_OPTIONS = [30, 60, 90, 120]
/** 某一头明确说「不行」才标记；null（没探测到）不标，免得凭猜测拦用户。 */
/**
 * 编码下拉全由 `planCodecList` 算（纯函数，单测覆盖）：
 * 协议认得 ∩ 设备能编 ∩ 本机能解才进下拉，所以换一台设备这份列表就不一样。
 */
const codecPlan = computed(() =>
  planCodecList({
    device: props.deviceCodecs?.usable ?? null,
    local: props.localCodecs,
    current: props.config.videoCodec,
  }),
)
const codecOptions = computed(() => codecPlan.value.options)

// 倍率与码率都从 shared 的两张表取，标签里不手抄数字（档位数值改了这里跟着变）。
// 选项标签只放「名字 + 倍率 / 码率」：select 最宽 190px，再塞档位说明就会被裁掉，
// 什么时候选哪档写在下面那行（那行会换行，不会被裁）。
const QUALITY_META = { compat: '兼容', native: '均衡', sharp: '清晰' }
const QUALITY_OPTIONS = Object.entries(DISPLAY_QUALITY_TIERS).map(([value, scale]) => {
  const name = QUALITY_META[value] ?? value
  return { value, label: `${name}（${scale}x / ${DISPLAY_QUALITY_BIT_RATES[value]}）` }
})

/** 档位与码率存盘是两个字段，只有值等于某个预设时下拉才落在那一档（否则是「自定义」）。 */
const CUSTOM_QUALITY = 'custom'
const qualityValue = computed(() =>
  DISPLAY_QUALITY_BIT_RATES[props.config.quality] === props.config.bitRate
    ? props.config.quality
    : CUSTOM_QUALITY,
)
/**
 * 档位与码率并成**一个**下拉，但不因此改存盘结构：老配置里两者对不上（手动挑过码率）
 * 时不静默改用户的值，只补一项标灰的「自定义」照实显示 —— 同 `planCodecList` 对越界
 * 编码的处理。挑回任一档位即写入该档的倍率与码率，「自定义」不可再选。
 */
const qualityOptions = computed(() => {
  if (qualityValue.value !== CUSTOM_QUALITY) return QUALITY_OPTIONS
  const name = QUALITY_META[props.config.quality] ?? props.config.quality
  return [
    ...QUALITY_OPTIONS,
    {
      value: CUSTOM_QUALITY,
      label: `自定义（${name} · ${props.config.bitRate}）`,
      disabled: true,
    },
  ]
})

function update(patch) {
  emit('change', patch)
}

/** 选档位 = 一次写入倍率与码率两个字段。 */
function updateQuality(tier) {
  if (tier === CUSTOM_QUALITY) return
  update({ quality: tier, bitRate: DISPLAY_QUALITY_BIT_RATES[tier] })
}
</script>

<template>
  <div
    class="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface-2/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur">
    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-ink-2">画质档位</div>
        <div class="mt-0.5 text-[11px] text-ink-3">
          一档 = 码率上限（开了下面「大屏模式」才还决定像素倍率），会话建立时读取（改动不影响进行中的镜像）。
          实测只影响清晰度与带宽、不影响帧率：排版异常的应用用兼容，Wi-Fi 不稳时降档
        </div>
      </div>
      <select :class="SELECT_CLASS" :value="qualityValue" :disabled="disabled"
        @change="updateQuality($event.target.value)">
        <option v-for="tier in qualityOptions" :key="tier.value" :value="tier.value" :disabled="tier.disabled">
          {{ tier.label }}
        </option>
      </select>
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-ink-2">大屏模式</div>
        <div class="mt-0.5 text-[11px] text-ink-3">
          改用随包的补丁版 server：虚拟显示按窗口 CSS × 画质档位倍率开、并忽略应用尺寸限制，固定竖屏的应用在横屏显示上能铺满。
          关闭（默认）用上游原生 server，显示按窗口物理像素开（1:1 不缩放），密度照设备主屏等比
        </div>
      </div>
      <SwitchToggle :model-value="props.config.largeScreenDisplay" :disabled="disabled"
        @update:model-value="(value) => update({ largeScreenDisplay: value })" />
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-ink-2">帧率上限</div>
        <div class="mt-0.5 text-[11px] text-ink-3">限制镜像的最大帧率</div>
      </div>
      <select :class="SELECT_CLASS" :value="props.config.maxFps" :disabled="disabled"
        @change="update({ maxFps: Number($event.target.value) })">
        <option v-for="fps in FPS_OPTIONS" :key="fps" :value="fps">{{ fps }} fps</option>
      </select>
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-ink-2">视频编码</div>
        <div class="mt-0.5 text-[11px] text-ink-3">投屏协议</div>
      </div>
      <select :class="SELECT_CLASS" :value="props.config.videoCodec" :disabled="disabled"
        @change="update({ videoCodec: $event.target.value })">
        <option v-for="codec in codecOptions" :key="codec.value" :value="codec.value" :disabled="codec.disabled">
          {{ codec.label }}
        </option>
      </select>
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-ink-2">音频转发</div>
        <div class="mt-0.5 text-[11px] text-ink-3">
          把设备声音转发到电脑播放（默认开）；转发期间手机不出声，结束投屏后手机立刻恢复播放
        </div>
      </div>
      <SwitchToggle :model-value="props.config.audio" :disabled="disabled"
        @update:model-value="(value) => update({ audio: value })" />
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-ink-2">窗口置顶</div>
        <div class="mt-0.5 text-[11px] text-ink-3">镜像窗口始终显示在其他窗口之上</div>
      </div>
      <SwitchToggle :model-value="props.config.alwaysOnTop" :disabled="disabled"
        @update:model-value="(value) => update({ alwaysOnTop: value })" />
    </div>

    <div class="flex items-center gap-3 px-4 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] text-ink-2">全屏启动</div>
        <div class="mt-0.5 text-[11px] text-ink-3">镜像窗口以全屏模式打开</div>
      </div>
      <SwitchToggle :model-value="props.config.fullscreen" :disabled="disabled"
        @update:model-value="(value) => update({ fullscreen: value })" />
    </div>
  </div>
</template>
