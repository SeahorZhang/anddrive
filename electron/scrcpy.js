import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { app, nativeImage } from 'electron'
import { tmpdir } from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scrcpyProcesses = new Map()

function resourceBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources')
}

function scrcpyPath() {
  return path.join(resourceBase(), 'scrcpy', 'scrcpy')
}

function scrcpyServerPath() {
  return path.join(resourceBase(), 'scrcpy', 'scrcpy-server')
}

function adbPath() {
  return path.join(resourceBase(), 'adb', 'mac', 'adb')
}

async function removeIconDirectory(iconDir) {
  await rm(iconDir, { recursive: true, force: true }).catch(() => {})
}

export function stopScrcpy() {
  for (const [child, iconDir] of scrcpyProcesses) {
    child.kill('SIGKILL')
    void removeIconDirectory(iconDir)
  }
  scrcpyProcesses.clear()
}

async function prepareIcon(iconDataUrl) {
  if (!iconDataUrl?.startsWith('data:image/png;base64,')) {
    throw new Error('应用图标不可用')
  }

  const image = nativeImage.createFromDataURL(iconDataUrl)
  if (image.isEmpty()) {
    throw new Error('应用图标无效')
  }

  const iconDir = await mkdtemp(path.join(tmpdir(), 'anddrive-scrcpy-'))
  try {
    await writeFile(path.join(iconDir, 'scrcpy.png'), image.toPNG(), { mode: 0o600 })
    return iconDir
  } catch (error) {
    await removeIconDirectory(iconDir)
    throw error
  }
}

export async function startScrcpy(args, iconDataUrl) {
  const iconDir = await prepareIcon(iconDataUrl)
  const env = {
    ...process.env,
    ADB: adbPath(),
    SCRCPY_SERVER_PATH: scrcpyServerPath(),
    SCRCPY_ICON_DIR: iconDir,
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(scrcpyPath(), args, {
        stdio: 'ignore',
        env,
      })
    } catch (error) {
      void removeIconDirectory(iconDir)
      reject(error)
      return
    }

    scrcpyProcesses.set(child, iconDir)
    child.once('spawn', () => resolve(true))
    child.once('error', (error) => {
      scrcpyProcesses.delete(child)
      void removeIconDirectory(iconDir)
      reject(error)
    })
    child.once('exit', () => {
      scrcpyProcesses.delete(child)
      void removeIconDirectory(iconDir)
    })
  })
}
