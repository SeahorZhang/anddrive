import { reactive } from 'vue'
import { onUpdateStatusApi, getUpdateStatusApi, installUpdateApi, getUpdateNotesApi } from '@/api'

/** 自动更新状态：idle | checking | available | downloading | downloaded | not-available | installing | error */
export const updateState = reactive({
  state: 'idle',
  version: '',
  releaseNotes: '',
  percent: 0,
  message: '',
})

let initialized = false

/** @param {Partial<typeof updateState>} payload */
function applyStatus(payload) {
  if (!payload) return
  updateState.state = payload.state || 'idle'
  updateState.version = payload.version || ''
  updateState.releaseNotes = payload.releaseNotes || ''
  updateState.percent = payload.percent || 0
  updateState.message = payload.message || ''
}

/** 订阅主进程推送的更新状态，并同步一次当前状态 */
export function initUpdater() {
  if (initialized) return
  initialized = true
  onUpdateStatusApi(applyStatus)
  getUpdateStatusApi()
    .then(applyStatus)
    .catch(() => {})
}

/** 保存更新内容并重启安装 */
export async function requestUpdateInstall() {
  const previous = updateState.state
  updateState.state = 'installing'
  try {
    const installed = await installUpdateApi()
    if (!installed) updateState.state = previous
    return installed
  } catch (error) {
    updateState.state = 'error'
    updateState.message = error?.message || '更新失败'
    return false
  }
}

/** 读取（并消费）本次更新内容，供重启后弹窗展示 */
export async function takeUpdateNotes() {
  try {
    return await getUpdateNotesApi()
  } catch {
    return null
  }
}
