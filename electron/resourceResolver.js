import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// macOS-only：所有打包资源（adb/scrcpy/helper apk）路径的唯一来源，
// adb、helper、scrcpy 服务一律经由本模块取路径，不再各自硬编码。
function resourceBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources')
}

const ADB_BIN = { darwin: 'mac/adb', win32: 'win/adb.exe', linux: 'linux/adb' }[process.platform]

export function getAdbPath() {
  return path.join(resourceBase(), 'adb', ADB_BIN)
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
