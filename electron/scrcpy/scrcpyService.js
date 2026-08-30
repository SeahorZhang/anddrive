import { spawn } from 'node:child_process'
import { adbPath, scrcpyPath } from '../paths.js'

/** child process → { serial }; serial comes from the `-s` CLI arg. */
const scrcpyProcesses = new Map()

function serialOf(args) {
  const index = args.indexOf('-s')
  return index >= 0 ? (args[index + 1] ?? null) : null
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
    scrcpyProcesses.delete(child)
  }
}

/**
 * Launch a scrcpy mirror window with a single command line.
 * @param {string[]} args full scrcpy CLI arguments
 */
export function startScrcpy(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(scrcpyPath(), args, {
      stdio: 'ignore',
      // 打包的 adb 不在 PATH 上，scrcpy 通过 ADB 环境变量定位它；server 与可执行文件同目录自动找到。
      env: { ...process.env, ADB: adbPath() },
    })

    scrcpyProcesses.set(child, { serial: serialOf(args) })
    child.once('spawn', () => resolve(true))
    child.once('error', (error) => {
      scrcpyProcesses.delete(child)
      reject(error)
    })
    child.once('exit', () => {
      scrcpyProcesses.delete(child)
    })
  })
}
