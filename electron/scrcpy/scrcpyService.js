import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { nativeImage } from 'electron'
import { adbPath, scrcpyPath, scrcpyServerPath } from '../paths.js'

/** child process → { serial, iconDir }; serial comes from the `-s` CLI arg. */
const scrcpyProcesses = new Map()

function serialOf(args) {
  const index = args.indexOf('-s')
  return index >= 0 ? (args[index + 1] ?? null) : null
}

async function removeIconDirectory(iconDir) {
  await rm(iconDir, { recursive: true, force: true }).catch(() => {})
}

/**
 * Kill running mirror processes. With a serial only that device's mirrors die;
 * without one everything is stopped (quit / disconnect-all paths).
 * @param {string} [serial]
 */
export function stopScrcpy(serial) {
  for (const [child, info] of scrcpyProcesses) {
    if (serial && info.serial !== serial) continue
    child.kill('SIGKILL')
    void removeIconDirectory(info.iconDir)
    scrcpyProcesses.delete(child)
  }
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

/**
 * @param {string[]} args full scrcpy CLI arguments built by main
 * @param {string} iconDataUrl
 */
export async function startScrcpy(args, iconDataUrl) {
  const serial = serialOf(args)
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

    scrcpyProcesses.set(child, { serial, iconDir })
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
