<script setup>
import { diagnostics } from '../services/desktopApi'

const items = ref([])
const running = ref(false)
const listening = ref(false)
const sightings = ref([])

const statusColor = { pass: 'bg-green-500', warn: 'bg-yellow-500', fail: 'bg-red-500' }

const runAll = async () => {
  running.value = true
  try {
    const result = await diagnostics.run()
    items.value = result.items
  } finally {
    running.value = false
  }
}

/** 验证手机端广播是否可达：需先在手机上打开配对弹窗 */
const listenOnce = async () => {
  listening.value = true
  sightings.value = []
  try {
    sightings.value = await diagnostics.listenPairingBroadcast(10000)
  } finally {
    listening.value = false
  }
}

runAll()
</script>

<template>
  <div class="w-full rounded-lg border border-black/8 bg-gray-50 p-3 text-left">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-xs font-medium text-black/70">连接环境诊断</span>
      <button
        class="cursor-pointer text-[11px] text-blue-500 hover:text-blue-600"
        :disabled="running"
        @click="runAll"
      >
        {{ running ? '检测中...' : '重新检测' }}
      </button>
    </div>

    <ul class="space-y-1.5">
      <li
        v-for="item in items"
        :key="item.id"
        class="flex items-start gap-2 text-[11px] leading-snug"
      >
        <span
          class="mt-0.5 inline-block size-1.5 shrink-0 rounded-full"
          :class="statusColor[item.status] || 'bg-gray-300'"
        />
        <div class="min-w-0 flex-1">
          <span class="font-medium text-black/70">{{ item.name }}</span>
          <p class="break-all text-black/40">{{ item.detail }}</p>
        </div>
      </li>
    </ul>

    <div class="mt-3 border-t border-black/5 pt-2.5">
      <button
        class="w-full cursor-pointer rounded-md border border-black/10 py-1.5 text-[11px] text-black/60 transition-colors hover:bg-white disabled:opacity-50"
        :disabled="listening"
        @click="listenOnce"
      >
        {{
          listening
            ? '监听中（10s）—— 请现在打开手机的配对码/二维码弹窗'
            : '监听手机配对广播（10s）'
        }}
      </button>
      <div v-if="sightings.length > 0" class="mt-1.5 space-y-0.5 text-[11px] text-green-600">
        <p v-for="sighting in sightings" :key="sighting.address + sighting.type" class="truncate">
          ✓ 收到{{ sighting.type === 'pairing' ? '配对' : '连接' }}广播：{{ sighting.address }}
        </p>
      </div>
      <p
        v-else-if="!listening && sightings.length === 0"
        class="mt-1.5 text-[11px] leading-relaxed text-black/35"
      >
        提示：若上方全部通过但扫码无反应，请到 系统设置 → 隐私与安全性 → 本地网络， 确认 AndDrive
        已允许；再用上面的监听按钮配合手机验证。
      </p>
    </div>
  </div>
</template>
