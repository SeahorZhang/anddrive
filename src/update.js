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

/** 「更新内容」弹窗状态 */
export const updateNotesDialog = reactive({
  visible: false,
  version: '',
  releaseNotes: '',
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

function showNotes(version, releaseNotes) {
  updateNotesDialog.version = version || ''
  updateNotesDialog.releaseNotes = releaseNotes || ''
  updateNotesDialog.visible = true
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

/**
 * 保存更新内容并重启安装。
 * 返回 'installing'（打包环境，应用即将退出重启）、'skipped'（开发环境跳过替换）
 * 或 false（无可用更新/出错）。开发环境会直接预览更新内容。
 */
export async function requestUpdateInstall() {
  const previous = updateState.state
  updateState.state = 'installing'
  try {
    const result = await installUpdateApi()
    if (result === 'installing') return result
    updateState.state = previous
    if (result === 'skipped') showNotes(updateState.version, updateState.releaseNotes)
    return result
  } catch (error) {
    console.error('[update] install failed:', error)
    updateState.state = 'error'
    updateState.message = error?.message || '更新失败'
    return false
  }
}

/** 读取（并消费）重启后待展示的更新内容 */
export async function loadPendingUpdateNotes() {
  const notes = await getUpdateNotesApi().catch(() => null)
  if (notes && (notes.releaseNotes || notes.version)) showNotes(notes.version, notes.releaseNotes)
}
