import { execFile } from 'node:child_process'
import { getAdbPath } from '../resourceResolver.js'
import { isAlreadyDisconnectedError, normalizeDisconnectSerial } from './adbDisconnect.js'
import { parseAdbDevices } from './deviceParser.js'

// adb 是 client/server 架构：所有 adb 命令前先确保守护进程已启动（幂等）。
let serverStarted = false

export async function ensureServer() {
  if (serverStarted) return
  await new Promise((resolve, reject) => {
    execFile(getAdbPath(), ['start-server'], (err) => {
      if (err) reject(err)
      else {
        serverStarted = true
        resolve()
      }
    })
  })
}

/** @param {...string} args */
export function exec(...args) {
  return new Promise((resolve, reject) => {
    execFile(getAdbPath(), args, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout.trim())
    })
  })
}

/**
 * 在指定设备上执行 shell 命令。
 * @param {string} serial
 * @param {...string} args
 */
export function shell(serial, ...args) {
  return exec('-s', serial, 'shell', ...args)
}

/**
 * 无线配对。设备端偶发中断配对握手（adb 报 protocol fault），短间隔重试可显著提高成功率。
 * @param {string} host
 * @param {string|number} port
 * @param {string} code
 */
export async function pair(host, port, code) {
  const target = `${host}:${port}`
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await exec('pair', target, code)
    } catch (error) {
      lastError = error
      const message = String(error?.message || error)
      if (attempt === 2 || !/protocol fault|couldn't read status/i.test(message)) throw error
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
    }
  }
  throw lastError
}

/**
 * 建立无线 ADB transport（连接设备 tls-connect 端口）。
 * 注意 adb connect 失败时进程退出码可能仍为 0，需检查 stdout 文案判定结果。
 * @param {string} host
 * @param {string|number} port
 */
export async function connect(host, port) {
  const output = await exec('connect', `${host}:${port}`)
  if (!/connected to/i.test(output)) throw new Error(output || 'adb connect 失败')
  return output
}

/** @returns {Promise<import('../../shared/types.js').AdbDevice[]>} */
export function listDevices() {
  return exec('devices').then(parseAdbDevices)
}

/**
 * 断开无线 ADB transport；已离线视为成功（幂等）。
 * @param {string} rawSerial
 * @returns {Promise<boolean>}
 */
export async function disconnect(rawSerial) {
  const serial = normalizeDisconnectSerial(rawSerial)
  try {
    await exec('disconnect', serial)
  } catch (error) {
    if (isAlreadyDisconnectedError(error)) return true
    throw error
  }
  return true
}
