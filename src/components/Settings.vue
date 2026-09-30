<script setup>
/* global __BUILD_TIME__, __APP_CHANNEL__, __APP_VERSION__ */
import BaseButton from './BaseButton.vue'
import {
  isMac,
  getPermissionStatusApi,
  requestPermissionApi,
  openPermissionSettingsApi,
} from '@/api'
import { notifyError } from '@/composables/useNotifications'
import { autoReconnect } from '@/composables/useConnectionPreferences'
import { theme } from '@/composables/useTheme'
import { scrcpyConfig, resetScrcpyConfig } from '@/composables/useScrcpyPreferences'
import { useDeviceCodecs, useLocalCodecs } from '@/composables/useCodecCaps'

/** 当前设备地址：编码列表要按「这台能不能编」筛，没有设备时只按本机能力。 */
const props = defineProps({ serial: { type: String, default: '' } })

// 与右键启动对话框同一套判据：协议认得 ∩ 这台设备能编 ∩ 本机能解。
const localCodecs = useLocalCodecs()
const deviceCodecs = useDeviceCodecs(() => props.serial)

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

const CHANNEL_LABELS = {
  dev: '开发环境',
  beta: '预发布环境',
  stable: '正式环境',
}

const appVersion = __APP_VERSION__
const appChannel = CHANNEL_LABELS[__APP_CHANNEL__] ?? __APP_CHANNEL__
const buildTime = formatTime(__BUILD_TIME__)

const PERMISSIONS = [
  {
    id: 'localNetwork',
    label: '本地网络',
    description: '发现并连接同一网络下的 Android 设备',
  },
  {
    id: 'accessibility',
    label: '辅助功能',
    description: '镜像时转发键盘与鼠标操作',
  },
  {
    id: 'fullDiskAccess',
    label: '完全磁盘访问',
    description: '读取受保护的系统路径',
  },
]

const STATUS_TEXT = {
  granted: '已授权',
  denied: '未授权',
  unknown: '未知',
}

const permissionStatus = ref({})
const busyId = ref('')

const autoReconnectModel = computed({
  get: () => autoReconnect.value,
  set: (value) => {
    autoReconnect.value = value
  },
})

const darkModeModel = computed({
  get: () => theme.value === 'dark',
  set: (value) => {
    theme.value = value ? 'dark' : 'light'
  },
})

const permissionRows = computed(() =>
  PERMISSIONS.map((permission) => ({
    ...permission,
    status: permissionStatus.value[permission.id] || 'unknown',
  })),
)

function statusClass(status) {
  if (status === 'granted') return 'bg-[#34c759]/15 text-[#248a3d] dark:text-[#30d158]'
  if (status === 'denied') return 'bg-[#ff3b30]/15 text-[#d70015] dark:text-[#ff453a]'
  return 'bg-fill text-ink-3'
}

async function refreshPermissions() {
  if (!isMac) return
  try {
    permissionStatus.value = await getPermissionStatusApi()
  } catch (e) {
    notifyError(e, { title: '读取系统权限状态失败' })
  }
}

async function requestPermission(permission) {
  busyId.value = permission.id
  try {
    const status = await requestPermissionApi(permission.id)
    permissionStatus.value = { ...permissionStatus.value, [permission.id]: status }
    // 权限被拒绝后系统不会再弹窗：完全磁盘访问与本地网络只能手动开启，
    // 辅助功能被拒绝后也无法再次弹窗，都需要跳转系统设置。
    const needsSettings =
      permission.id === 'fullDiskAccess' ||
      (permission.id === 'localNetwork' && status === 'denied') ||
      (permission.id === 'accessibility' && status !== 'granted')
    if (needsSettings) await openPermissionSettingsApi(permission.id)
  } catch (e) {
    notifyError(e, { title: '申请系统权限失败' })
  } finally {
    busyId.value = ''
  }
}

async function openPermissionSettings(permission) {
  try {
    await openPermissionSettingsApi(permission.id)
  } catch (e) {
    notifyError(e, { title: '打开系统设置失败' })
  }
}

// 已授权时按钮用于跳转到对应系统设置页；未授权时先触发授权流程。
function handlePermissionAction(permission) {
  return permission.status === 'granted'
    ? openPermissionSettings(permission)
    : requestPermission(permission)
}

onMounted(refreshPermissions)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-5">
    <section>
      <div class="mb-1.5 flex items-center justify-between px-1">
        <span class="text-[11px] font-medium text-ink-3">连接</span>
      </div>
      <div
        class="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface-2/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur"
      >
        <div class="flex items-center gap-3 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="text-[13px] text-ink-2">自动重连</div>
            <div class="mt-1 text-[11px] text-ink-3">
              连接中断或设备离线后，自动尝试恢复与设备的连接
            </div>
          </div>
          <SwitchToggle v-model="autoReconnectModel" />
        </div>
      </div>
    </section>

    <section>
      <div class="mb-1.5 flex items-center justify-between px-1">
        <span class="text-[11px] font-medium text-ink-3">外观</span>
      </div>
      <div
        class="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface-2/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur"
      >
        <div class="flex items-center gap-3 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="text-[13px] text-ink-2">深色模式</div>
            <div class="mt-1 text-[11px] text-ink-3">
              切换界面的明暗外观，设置会记住你的选择
            </div>
          </div>
          <SwitchToggle v-model="darkModeModel" />
        </div>
      </div>
    </section>

    <section>
      <div class="mb-1.5 flex items-center justify-between px-1">
        <span class="text-[11px] font-medium text-ink-3">镜像</span>
        <button class="cursor-pointer text-[11px] text-accent outline-none hover:underline" @click="resetScrcpyConfig">
          恢复默认
        </button>
      </div>
      <ScrcpyConfigFields :config="scrcpyConfig" :local-codecs="localCodecs" :device-codecs="deviceCodecs"
        @change="(patch) => Object.assign(scrcpyConfig, patch)" />
    </section>

    <section v-if="isMac">
      <div class="mb-1.5 flex items-center justify-between px-1">
        <span class="text-[11px] font-medium text-ink-3">系统权限</span>
        <button class="cursor-pointer text-[11px] text-accent outline-none hover:underline"
          @click="refreshPermissions">
          刷新
        </button>
      </div>
      <div
        class="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface-2/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur">
        <div v-for="row in permissionRows" :key="row.id" class="flex items-center gap-3 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-[13px] text-ink-2">{{ row.label }}</span>
              <span :class="statusClass(row.status)"
                class="rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium">
                {{ STATUS_TEXT[row.status] }}
              </span>
            </div>
            <div class="mt-1 text-[11px] text-ink-3">{{ row.description }}</div>
          </div>
          <BaseButton variant="secondary" :loading="busyId === row.id" @click="handlePermissionAction(row)">
            {{ row.status === 'granted' ? '设置' : row.status === 'denied' ? '去设置' : '授权' }}
          </BaseButton>
        </div>
      </div>
    </section>

    <div class="mt-auto pt-2 text-center text-[11px] text-ink-4 tabular-nums">
      v{{ appVersion }} · {{ appChannel }} · {{ buildTime }}
    </div>
  </div>
</template>
