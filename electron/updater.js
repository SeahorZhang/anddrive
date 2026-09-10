import { app, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CHANNELS } from './ipcContract.js'
import { shutdown } from './adb.js'

const { autoUpdater } = electronUpdater

/**
 * @typedef {object} UpdateStatus
 * @property {'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'} state
 * @property {string} [version]
 * @property {string} [releaseNotes]
 * @property {number} [percent]
 * @property {string} [message]
 */

/** Latest status pushed to the renderer; also served on demand via `update:getStatus`. */
/** @type {UpdateStatus} */
let status = { state: 'idle' }
/** Info of the downloaded update, kept until the user restarts to install it. */
let downloadedInfo = null
/** True while an install is in progress so quit handling can skip graceful delays. */
let installing = false
let getWindow = () => null

/** @param {Partial<UpdateStatus>} next */
function setStatus(next) {
  status = { ...status, ...next }
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.updateStatus, status)
}

/**
 * Release notes arrive either as a string (GitHub release body) or as the
 * electron-updater `ReleaseNoteInfo[]`; flatten both to plain display text.
 * @param {unknown} notes
 * @returns {string}
 */
export function normalizeReleaseNotes(notes) {
  if (typeof notes === 'string') return notes.trim()
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => {
        const note = typeof entry?.note === 'string' ? entry.note.trim() : ''
        if (!note) return ''
        return entry.version ? `${entry.version}\n${note}` : note
      })
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

const pendingPath = () => path.join(app.getPath('userData'), 'update-pending.json')

async function clearPendingNotes() {
  try {
    await fs.rm(pendingPath(), { force: true })
  } catch (error) {
    console.warn('Failed to clear pending update notes:', error)
  }
}

/**
 * Read (and consume) the release notes saved just before the last restart. Only
 * returned when the running version matches, so a failed install never shows a
 * stale "what's new" dialog.
 * @returns {Promise<{ version: string, releaseNotes: string } | null>}
 */
export async function takePendingNotes() {
  let pending
  try {
    pending = JSON.parse(await fs.readFile(pendingPath(), 'utf8'))
  } catch {
    return null
  } finally {
    await clearPendingNotes()
  }
  if (!pending || pending.version !== app.getVersion()) return null
  return { version: String(pending.version), releaseNotes: String(pending.releaseNotes || '') }
}

/** @returns {boolean} */
export const isUpdateInstalling = () => installing

/**
 * Wire auto-update events and start the first check. No-op outside a packaged
 * build (there is no `app-update.yml` and no Squirrel feed to talk to).
 * @param {() => import('electron').BrowserWindow | null} [windowGetter]
 */
export function initUpdater(windowGetter) {
  if (typeof windowGetter === 'function') getWindow = windowGetter
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  // Only install when the user asks, so the release-notes dialog can be shown
  // after the restart instead of silently updating on a normal quit.
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', message: '' }))
  autoUpdater.on('update-available', (info) =>
    setStatus({
      state: 'available',
      version: info?.version ?? '',
      releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
      message: '',
    }),
  )
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available', message: '' }))
  autoUpdater.on('download-progress', (progress) =>
    setStatus({ state: 'downloading', percent: Math.round(progress?.percent ?? 0) }),
  )
  autoUpdater.on('update-downloaded', (info) => {
    const version = info?.version ?? ''
    const releaseNotes = normalizeReleaseNotes(info?.releaseNotes)
    downloadedInfo = { version, releaseNotes }
    setStatus({ state: 'downloaded', version, releaseNotes, percent: 100, message: '' })
  })
  autoUpdater.on('error', (error) =>
    setStatus({ state: 'error', message: error?.message ?? String(error) }),
  )

  autoUpdater.checkForUpdates().catch((error) => {
    setStatus({ state: 'error', message: error?.message ?? String(error) })
  })
}

ipcMain.handle(CHANNELS.updateGetStatus, () => status)

ipcMain.handle(CHANNELS.updateInstall, async () => {
  if (!downloadedInfo || installing) return false
  installing = true

  try {
    await fs.writeFile(pendingPath(), JSON.stringify(downloadedInfo), {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    console.warn('Failed to persist pending update notes:', error)
  }

  try {
    await shutdown()
  } catch (error) {
    console.warn('Shutdown before update failed:', error)
  }

  setTimeout(() => autoUpdater.quitAndInstall(), 0)
  return true
})

ipcMain.handle(CHANNELS.updateNotes, () => takePendingNotes())
