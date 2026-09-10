import { app, ipcMain, net } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { CHANNELS } from './ipcContract.js'
import { shutdown } from './adb.js'

/**
 * Release endpoint. `ANDDRIVE_UPDATE_API` points the updater at a local
 * release-shaped JSON (see `scripts/dev-update-server.mjs`) for local testing.
 */
const RELEASE_API =
  process.env.ANDDRIVE_UPDATE_API ||
  'https://api.github.com/repos/SeahorZhang/anddrive/releases/latest'
const USER_AGENT = 'AndDrive-Updater'

/** The updater normally only runs in packaged builds; `ANDDRIVE_UPDATE_FORCE=1`
 * enables it in `pnpm dev` for testing the check/download/UI flow. */
function updaterEnabled() {
  return app.isPackaged || process.env.ANDDRIVE_UPDATE_FORCE === '1'
}

/**
 * @typedef {object} UpdateStatus
 * @property {'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'installing' | 'error'} state
 * @property {string} [version]
 * @property {string} [releaseNotes]
 * @property {number} [percent]
 * @property {string} [message]
 */

/** @type {UpdateStatus} */
let status = { state: 'idle' }
/** @type {{ version: string, releaseNotes: string, zipPath: string } | null} */
let downloadedInfo = null
let installing = false
let getWindow = () => null

/** @param {Partial<UpdateStatus>} next */
function setStatus(next) {
  status = { ...status, ...next }
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.updateStatus, status)
}

/**
 * @param {unknown} value
 * @returns {[number, number, number] | null} major/minor/patch, or null when unparsable
 */
export function parseVersion(value) {
  const match = String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)]
}

/**
 * @param {unknown} candidate
 * @param {unknown} current
 * @returns {boolean} true when candidate is a strictly newer release
 */
export function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i]
  }
  return false
}

/**
 * Pick the macOS update zip for the requested architecture.
 * @param {Array<{ name?: string }> | undefined} assets
 * @param {string} arch `process.arch`
 * @returns {{ name?: string, browser_download_url?: string, size?: number } | null}
 */
export function pickMacAsset(assets, arch) {
  const zips = (Array.isArray(assets) ? assets : []).filter(
    (asset) => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.zip'),
  )
  return (
    zips.find((asset) => asset.name.includes(arch)) ??
    zips.find((asset) => /mac/i.test(asset.name)) ??
    zips[0] ??
    null
  )
}

const pendingPath = () => path.join(app.getPath('userData'), 'update-pending.json')

async function clearPendingNotes() {
  try {
    await fs.rm(pendingPath(), { force: true })
  } catch (error) {
    console.warn('Failed to clear pending update notes:', error)
  }
}

async function writePendingNotes(info) {
  await fs.writeFile(pendingPath(), JSON.stringify(info), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Read (and consume) the release notes saved before the last restart. Only
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

/** Query the latest GitHub release; null when the repo has no releases yet. */
async function fetchLatestRelease() {
  const response = await net.fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
  return response.json()
}

/**
 * Stream the update zip to a temp file, reporting progress.
 * @returns {Promise<string>} zip path
 */
async function downloadAsset(asset) {
  const response = await net.fetch(asset.browser_download_url, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anddrive-update-'))
  const zipPath = path.join(dir, asset.name || 'update.zip')
  const total = Number(response.headers.get('content-length')) || asset.size || 0
  const out = createWriteStream(zipPath)
  let received = 0

  try {
    for await (const chunk of Readable.fromWeb(/** @type {any} */ (response.body))) {
      received += chunk.length
      setStatus({
        state: 'downloading',
        percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
      })
      if (!out.write(chunk)) await once(out, 'drain')
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
  } catch (error) {
    out.destroy()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return zipPath
}

/**
 * Shell script that waits for the app to exit, swaps the bundle and relaunches.
 * Paths are passed as arguments so nothing is interpolated into the script.
 */
const INSTALL_SCRIPT = `#!/bin/bash
set -u
PID="$1"; APP="$2"; ZIP="$3"; LOG="$4"
exec >>"$LOG" 2>&1
echo "[$(date)] install update pid=$PID app=$APP zip=$ZIP"
for _ in $(seq 1 600); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.3
done
WORK="$(mktemp -d)"
if ! ditto -x -k "$ZIP" "$WORK"; then
  echo "unzip failed"; open "$APP"; exit 1
fi
NEW_APP="$(find "$WORK" -maxdepth 1 -name '*.app' | head -n 1)"
if [ -z "$NEW_APP" ]; then
  echo "no .app in archive"; open "$APP"; exit 1
fi
BACKUP="$APP.old.$$"
if mv "$APP" "$BACKUP" 2>/dev/null; then
  if ditto "$NEW_APP" "$APP"; then
    xattr -dr com.apple.quarantine "$APP" 2>/dev/null
    rm -rf "$BACKUP"
  else
    echo "copy failed, restoring"; rm -rf "$APP"; mv "$BACKUP" "$APP"
  fi
else
  echo "cannot move bundle, overwriting in place"
  ditto "$NEW_APP" "$APP" || true
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null
fi
rm -rf "$WORK"
open "$APP"
`

/** Resolve the running `.app` bundle from the executable path. */
function appBundlePath() {
  return path.resolve(app.getPath('exe'), '..', '..', '..')
}

/** Spawn the detached installer helper that replaces the app after we quit. */
async function startInstaller(zipPath) {
  const bundle = appBundlePath()
  console.log(`[updater] launching installer for ${bundle} <- ${zipPath}`)
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anddrive-installer-'))
  const scriptPath = path.join(workDir, 'install.sh')
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'AndDrive')
  await fs.mkdir(logDir, { recursive: true }).catch(() => {})
  const logPath = path.join(logDir, 'update.log')
  await fs.writeFile(scriptPath, INSTALL_SCRIPT, { encoding: 'utf8', mode: 0o700 })
  const child = spawn('/bin/bash', [scriptPath, String(process.pid), bundle, zipPath, logPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

/** Check GitHub for a newer release and download it in the background. */
async function checkForUpdates() {
  setStatus({ state: 'checking', message: '' })
  try {
    const release = await fetchLatestRelease()
    if (!release) {
      setStatus({ state: 'not-available', message: '' })
      return
    }
    const version = String(release.tag_name || release.name || '')
      .replace(/^v/i, '')
      .trim()
    if (!version || !isNewerVersion(version, app.getVersion())) {
      setStatus({ state: 'not-available', message: '' })
      return
    }
    const asset = pickMacAsset(release.assets, process.arch)
    if (!asset?.browser_download_url) {
      setStatus({ state: 'error', version, message: '未找到 macOS 更新包' })
      return
    }
    const releaseNotes = String(release.body || '')
    setStatus({ state: 'available', version, releaseNotes, message: '' })
    const zipPath = await downloadAsset(asset)
    downloadedInfo = { version, releaseNotes, zipPath }
    setStatus({ state: 'downloaded', version, releaseNotes, percent: 100, message: '' })
  } catch (error) {
    setStatus({ state: 'error', message: error?.message ?? String(error) })
  }
}

/**
 * Wire the updater and start the first check. No-op outside a packaged build,
 * where there is nothing to replace.
 * @param {() => import('electron').BrowserWindow | null} [windowGetter]
 */
export function initUpdater(windowGetter) {
  if (typeof windowGetter === 'function') getWindow = windowGetter
  if (!updaterEnabled()) return
  checkForUpdates()
}

ipcMain.handle(CHANNELS.updateGetStatus, () => status)

ipcMain.handle(CHANNELS.updateInstall, async () => {
  if (!downloadedInfo || installing) return false
  installing = true
  console.log(`[updater] install requested (packaged=${app.isPackaged})`)

  try {
    await writePendingNotes(downloadedInfo)
  } catch (error) {
    console.warn('Failed to persist pending update notes:', error)
  }

  // In `pnpm dev` there is no app bundle to replace (the "app" is Electron
  // itself), so only simulate the install and leave the dev build untouched.
  if (!app.isPackaged) {
    installing = false
    console.warn('[updater] dev build: skipping replacement, showing notes preview')
    return 'skipped'
  }

  try {
    await startInstaller(downloadedInfo.zipPath)
  } catch (error) {
    installing = false
    console.warn('Failed to start installer:', error)
    setStatus({ state: 'error', message: error?.message ?? String(error) })
    return false
  }

  try {
    await shutdown()
  } catch (error) {
    console.warn('Shutdown before update failed:', error)
  }

  setTimeout(() => app.quit(), 0)
  return 'installing'
})

ipcMain.handle(CHANNELS.updateNotes, () => takePendingNotes())
