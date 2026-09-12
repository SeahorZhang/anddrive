<script setup>
/* global __BUILD_TIME__, __APP_CHANNEL__, __APP_VERSION__ */
import helperVersion from '../../resources/helper-app.version.json'
import BaseButton from './BaseButton.vue'
import {
  isMac,
  getPermissionStatusApi,
  requestPermissionApi,
  openPermissionSettingsApi,
} from '@/api'

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

const sections = [
  {
    title: '应用',
    rows: [
      { label: '版本', value: `v${__APP_VERSION__}` },
      { label: '通道', value: __APP_CHANNEL__ === 'beta' ? 'Beta' : '正式' },
      { label: '构建时间', value: formatTime(__BUILD_TIME__) },
    ],
  },
  {
    title: 'Helper',
    rows: [
      { label: '版本', value: `v${helperVersion.versionName} (${helperVersion.versionCode})` },
      { label: '构建时间', value: formatTime(helperVersion.builtAt) },
    ],
  },
]

const PERMISSIONS = [
  {
    id: 'localNetwork',
    label: '本地网络',
    description: '发现并连接同一网络下的 Android 设备',
  },
  {
    id: 'accessibility',
    label: '辅助功能',
    description: '投屏时转发键盘与鼠标操作',
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

const permissionRows = computed(() =>
  PERMISSIONS.map((permission) => ({
    ...permission,
    status: permissionStatus.value[permission.id] || 'unknown',
  })),
)

function statusClass(status) {
  if (status === 'granted') return 'bg-[#34c759]/15 text-[#248a3d]'
  if (status === 'denied') return 'bg-[#ff3b30]/15 text-[#d70015]'
  return 'bg-black/[0.06] text-black/40'
}

async function refreshPermissions() {
  if (!isMac) return
  try {
    permissionStatus.value = await getPermissionStatusApi()
  } catch (e) {
    console.error('读取系统权限状态失败：', e)
  }
}

async function requestPermission(permission) {
  busyId.value = permission.id
  try {
    const status = await requestPermissionApi(permission.id)
    permissionStatus.value = { ...permissionStatus.value, [permission.id]: status }
    // 完全磁盘访问无法自动授权；辅助功能被拒绝后也无法再次弹窗，都需要跳转系统设置。
    const needsSettings =
      permission.id === 'fullDiskAccess' ||
      (permission.id === 'accessibility' && status !== 'granted')
    if (needsSettings) await openPermissionSettingsApi(permission.id)
  } catch (e) {
    console.error('申请系统权限失败：', e)
  } finally {
    busyId.value = ''
  }
}

onMounted(refreshPermissions)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-5">
    <section v-for="section in sections" :key="section.title">
      <div class="mb-1.5 px-1 text-[11px] font-medium text-black/40">{{ section.title }}</div>
      <div
        class="divide-y divide-black/[0.06] overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur"
      >
        <div
          v-for="row in section.rows"
          :key="row.label"
          class="flex items-center justify-between px-4 py-3"
        >
          <span class="text-[13px] text-black/70">{{ row.label }}</span>
          <span class="text-[12px] tabular-nums text-black/45">{{ row.value }}</span>
        </div>
      </div>
    </section>

    <section v-if="isMac">
      <div class="mb-1.5 flex items-center justify-between px-1">
        <span class="text-[11px] font-medium text-black/40">系统权限</span>
        <button
          class="cursor-pointer text-[11px] text-[#007aff] outline-none hover:underline"
          @click="refreshPermissions"
        >
          刷新
        </button>
      </div>
      <div
        class="divide-y divide-black/[0.06] overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/70 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur"
      >
        <div v-for="row in permissionRows" :key="row.id" class="flex items-center gap-3 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-[13px] text-black/70">{{ row.label }}</span>
              <span
                :class="statusClass(row.status)"
                class="rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium"
              >
                {{ STATUS_TEXT[row.status] }}
              </span>
            </div>
            <div class="mt-1 text-[11px] text-black/40">{{ row.description }}</div>
          </div>
          <BaseButton
            v-if="row.status !== 'granted'"
            variant="secondary"
            :loading="busyId === row.id"
            @click="requestPermission(row)"
          >
            {{ row.status === 'denied' ? '去设置' : '授权' }}
          </BaseButton>
        </div>
      </div>
    </section>
  </div>
</template>
