<script setup>
import { Icon } from '@iconify/vue'
import BaseButton from './BaseButton.vue'
import { focusMirrorApi, stopMirrorApi, stopAllMirrorApi } from '@/api'
import { notify, notifyError } from '@/composables/useNotifications'
import { mirrorSessions, refreshScrcpySessions } from '@/composables/useScrcpySessions'

const busyId = ref('')
const busyAll = ref(false)

const total = computed(() => mirrorSessions.value.length)

async function focusSession(session) {
  try {
    await focusMirrorApi(session.id)
  } catch (error) {
    notifyError(error, { title: '聚焦镜像窗口失败' })
  }
}

async function closeSession(session) {
  busyId.value = session.id
  try {
    await stopMirrorApi(session.id)
    await refreshScrcpySessions()
    notify.success(`已关闭 ${session.label} 镜像`)
  } catch (error) {
    notifyError(error, { title: '关闭镜像窗口失败' })
  } finally {
    busyId.value = ''
  }
}

async function closeAll() {
  busyAll.value = true
  try {
    await stopAllMirrorApi()
    await refreshScrcpySessions()
    notify.success('已关闭全部镜像窗口')
  } catch (error) {
    notifyError(error, { title: '关闭全部镜像失败' })
  } finally {
    busyAll.value = false
  }
}

/** 会话已运行时长，用于区分同名窗口 */
function elapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - (startedAt || 0)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
</script>

<template>
  <PopoverRoot v-if="total">
    <PopoverTrigger as-child>
      <BaseButton icon="lucide:monitor-play" :title="'运行中的镜像窗口'">
        <span class="ml-0.5 text-[11px] tabular-nums">{{ total }}</span>
      </BaseButton>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent :side-offset="8" side="bottom" align="end"
        class="z-60 flex w-72 flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop ring-1 ring-line backdrop-blur-xl outline-none">
        <div class="flex items-center justify-between px-3.5 pt-2.5 pb-1.5">
          <span class="text-[12px] font-semibold text-ink">
            运行中的镜像
            <span class="ml-1 text-[11px] font-normal text-ink-3">{{ total }}</span>
          </span>
          <button class="cursor-pointer text-[11px] text-accent outline-none hover:underline"
            :disabled="busyAll || !!busyId" @click="closeAll">
            {{ busyAll ? '关闭中…' : '全部关闭' }}
          </button>
        </div>
        <div class="max-h-64 overflow-y-auto px-1.5 pb-1.5">
          <div v-for="session in mirrorSessions" :key="session.id"
            class="group flex items-center gap-2 rounded-[10px] px-2 py-1.5 hover:bg-fill">
            <div
              class="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-gradient-to-b from-[#30d158] to-[#248a3d] text-white">
              <!-- 整机会话没有包名（采主屏，不建虚拟显示），图标跟着换一枚手机的 -->
              <Icon :icon="session.packageName ? 'lucide:app-window' : 'lucide:smartphone'" :width="14"
                :height="14" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-[12px] text-ink">{{ session.label }}</span>
                <span class="shrink-0 rounded-full bg-fill px-1.5 py-0.5 text-[10px] leading-none text-ink-3">
                  {{ session.codecName }} · 原生
                </span>
              </div>
              <div class="truncate text-[10px] text-ink-3">
                {{ session.packageName || '整机镜像' }} · {{ elapsed(session.startedAt) }}
              </div>
            </div>
            <button title="聚焦窗口"
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-3 outline-none hover:bg-fill hover:text-ink"
              @click="focusSession(session)">
              <Icon icon="lucide:app-window" :width="13" :height="13" />
            </button>
            <button title="关闭窗口" :disabled="busyId === session.id"
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-3 outline-none hover:bg-[#ff3b30]/12 hover:text-[#ff453a] disabled:opacity-40"
              @click="closeSession(session)">
              <Icon v-if="busyId !== session.id" icon="lucide:x" :width="13" :height="13" />
              <span v-else class="size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-ink-2" />
            </button>
          </div>

        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
