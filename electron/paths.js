import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Single resource resolver: packaged resources dir in prod, project ./resources in dev. */
export function resourcesBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources')
}

export const adbPath = () => path.join(resourcesBase(), 'adb', 'mac', 'adb')
export const helperApkPath = () => path.join(resourcesBase(), 'helper-app.apk')
export const scrcpyPath = () => path.join(resourcesBase(), 'scrcpy', 'scrcpy')
export const scrcpyServerPath = () => path.join(resourcesBase(), 'scrcpy', 'scrcpy-server')
