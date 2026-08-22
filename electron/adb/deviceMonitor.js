import { spawn } from 'node:child_process'
import { getAdbPath } from '../resourceResolver.js'
import { parseAdbDevices } from './deviceParser.js'

// adb track-devices 常驻监听：设备增减即时回调（add/change/remove 帧推送），
// 取代轮询 `adb devices`。进程意外退出后置空，下次有订阅者时自动重启。

let proc = null
let buffer = ''
/** @type {Set<(devices: import('../../shared/types.js').AdbDevice[]) => void>} */
const listeners = new Set()

/**
 * 订阅设备列表变更；订阅即启动监听进程。返回取消订阅函数。
 * @param {(devices: import('../../shared/types.js').AdbDevice[]) => void} listener
 * @returns {() => void}
 */
export function onDevicesChanged(listener) {
  listeners.add(listener)
  ensureTracking()
  return () => listeners.delete(listener)
}

function ensureTracking() {
  if (proc) return
  try {
    proc = spawn(getAdbPath(), ['track-devices'])
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      drainFrames()
    })
    proc.on('error', () => {})
    proc.on('exit', () => {
      proc = null
      buffer = ''
      if (listeners.size > 0) queueMicrotask(ensureTracking)
    })
  } catch {
    proc = null
  }
}

/** 解析 4 位十六进制长度前缀的帧；每帧为一次完整设备列表快照。 */
function drainFrames() {
  for (;;) {
    if (buffer.length < 4) return
    const length = Number.parseInt(buffer.slice(0, 4), 16)
    if (!Number.isInteger(length) || length < 0) {
      buffer = '' // 协议错乱，丢弃缓冲等待下一帧
      return
    }
    if (buffer.length < 4 + length) return
    const block = buffer.slice(4, 4 + length)
    buffer = buffer.slice(4 + length)
    const devices = parseAdbDevices(block)
    for (const listener of listeners) listener(devices)
  }
}
