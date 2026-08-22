import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { nativeImage } from 'electron'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getAdbPath, getScrcpyPath, getScrcpyServerPath } from '../resourceResolver.js'
import { buildScrcpyArgs } from './scrcpyRequest.js'

// scrcpy 进程管理：以 serial 关联进程，统一启动/停止与临时图标目录清理。
// 资源路径全部来自 resourceResolver；CLI args 由 buildScrcpyArgs 构建。

/** @type {Map<string, { child: import('node:child_process').ChildProcess, iconDir: string }>} */
const processesBySerial = new Map()

async function removeIconDirectory(iconDir) {
  await rm(iconDir, { recursive: true, force: true }).catch(() => {})
}

function killEntry(serial, entry) {
  entry.child.kill('SIGKILL')
  void removeIconDirectory(entry.iconDir)
}

/** 停止指定设备的 scrcpy 进程。 */
export function stopForSerial(serial) {
  const entry = processesBySerial.get(serial)
  if (!entry) return
  processesBySerial.delete(serial)
  killEntry(serial, entry)
}

/** 停止所有 scrcpy 进程（退出/全局清理用）。 */
export function stopAll() {
  for (const [serial, entry] of processesBySerial) {
    processesBySerial.delete(serial)
    killEntry(serial, entry)
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
 * 启动 scrcpy 镜像指定设备上的应用。同 serial 的旧进程会被先停止。
 * @param {import('../../shared/types.js').ScrcpyLaunchInput} request 已通过 validateScrcpyRequest 校验的领域数据
 * @returns {Promise<boolean>} spawn 成功即 resolve
 */
export async function start(request) {
  const { serial, iconDataUrl } = request
  // 单设备模型：同一设备的旧镜像直接替换
  if (processesBySerial.has(serial)) stopForSerial(serial)

  const iconDir = await prepareIcon(iconDataUrl)
  const env = {
    ...process.env,
    ADB: getAdbPath(),
    SCRCPY_SERVER_PATH: getScrcpyServerPath(),
    SCRCPY_ICON_DIR: iconDir,
  }
  const args = buildScrcpyArgs(request)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(getScrcpyPath(), args, {
        stdio: 'ignore',
        env,
      })
    } catch (error) {
      void removeIconDirectory(iconDir)
      reject(error)
      return
    }

    processesBySerial.set(serial, { child, iconDir })
    child.once('spawn', () => resolve(true))
    child.once('error', (error) => {
      if (processesBySerial.get(serial)?.child === child) processesBySerial.delete(serial)
      void removeIconDirectory(iconDir)
      reject(error)
    })
    child.once('exit', () => {
      if (processesBySerial.get(serial)?.child === child) processesBySerial.delete(serial)
      void removeIconDirectory(iconDir)
    })
  })
}
