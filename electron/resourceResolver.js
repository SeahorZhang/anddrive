import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// macOS-only：所有打包资源（adb/scrcpy/helper apk）路径的唯一来源，
// adb、helper、scrcpy 服务一律经由本模块取路径，不再各自硬编码。
function resourceBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources')
}

/**
 * @returns {string} 相对 resources 的 adb 可执行文件路径
 */
function adbBin() {
  if (process.platform !== 'darwin') {
    throw new Error(`AndDrive 仅支持 macOS 构建，当前平台: ${process.platform}`)
  }
  return 'mac/adb'
}

export function getAdbPath() {
  return path.join(resourceBase(), 'adb', adbBin())
}

export function getHelperApkPath() {
  return path.join(resourceBase(), 'helper-app.apk')
}

export function getScrcpyPath() {
  return path.join(resourceBase(), 'scrcpy', 'scrcpy')
}

export function getScrcpyServerPath() {
  return path.join(resourceBase(), 'scrcpy', 'scrcpy-server')
}
