import { ipcMain, shell, systemPreferences } from 'electron'
import { promises as fs } from 'node:fs'
import dgram from 'node:dgram'
import os from 'node:os'
import path from 'node:path'
import { CHANNELS } from './ipcContract.js'

// ---------------------------------------------------------------------------
// macOS 系统权限
//
// 三种权限的处理方式不同：
// - 本地网络：系统在应用首次访问局域网（组播/广播）时弹窗，无公开查询 API。
// - 辅助功能：Electron 提供 systemPreferences.isTrustedAccessibilityClient。
// - 完全磁盘访问：无公开 API，只能通过 TCC.db 是否可读来判断，且必须手动授权。
// ---------------------------------------------------------------------------

const isMac = process.platform === 'darwin'

/** 系统设置的隐私面板深链，key 为权限 id。 */
const SETTINGS_PANES = {
  localNetwork: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  fullDiskAccess: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
}

export const PERMISSION_IDS = Object.keys(SETTINGS_PANES)

/**
 * 完全磁盘访问没有查询接口：TCC 数据库只有在获得该权限后才可读。
 * @returns {Promise<boolean>}
 */
export async function hasFullDiskAccess() {
  if (!isMac) return false
  const tccDb = path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
  let handle
  try {
    handle = await fs.open(tccDb, 'r')
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** @returns {boolean} */
export function hasAccessibilityAccess() {
  if (!isMac) return false
  return systemPreferences.isTrustedAccessibilityClient(false)
}

/**
 * 发送一个 mDNS 组播包以触发系统的“本地网络”授权弹窗。已拒绝时不会再弹，
 * 需要引导用户到系统设置手动开启。
 * @returns {Promise<void>}
 */
export function triggerLocalNetworkPrompt() {
  return new Promise((resolve) => {
    if (!isMac) return resolve()
    const socket = dgram.createSocket('udp4')
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // 已关闭。
      }
      resolve()
    }
    const timer = setTimeout(finish, 1500)
    socket.once('error', finish)
    socket.bind(0, () => {
      try {
        const packet = Buffer.from([0])
        socket.send(packet, 0, packet.length, 5353, '224.0.0.251', finish)
      } catch {
        finish()
      }
    })
  })
}

/**
 * @typedef {'granted' | 'denied' | 'unknown'} PermissionStatus
 */

/**
 * @returns {Promise<Record<string, PermissionStatus>>}
 */
export async function getPermissionStatus() {
  if (!isMac) {
    return { localNetwork: 'unknown', accessibility: 'unknown', fullDiskAccess: 'unknown' }
  }
  return {
    // 无公开 API，无法可靠判断。
    localNetwork: 'unknown',
    accessibility: hasAccessibilityAccess() ? 'granted' : 'denied',
    fullDiskAccess: (await hasFullDiskAccess()) ? 'granted' : 'denied',
  }
}

/**
 * 触发系统授权流程，返回该权限触发后的状态。
 * @param {string} id
 * @returns {Promise<PermissionStatus>}
 */
export async function requestPermission(id) {
  if (!isMac) throw new Error('系统权限仅支持 macOS')
  if (id === 'localNetwork') {
    await triggerLocalNetworkPrompt()
    return 'unknown'
  }
  if (id === 'accessibility') {
    systemPreferences.isTrustedAccessibilityClient(true)
    return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
  }
  if (id === 'fullDiskAccess') {
    return (await hasFullDiskAccess()) ? 'granted' : 'denied'
  }
  throw new Error(`未知系统权限：${id}`)
}

/**
 * 打开系统设置中对应的隐私面板。
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function openPermissionSettings(id) {
  const pane = SETTINGS_PANES[id]
  if (!pane) throw new Error(`未知系统权限：${id}`)
  await shell.openExternal(pane)
  return true
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.permissionsStatus, () => getPermissionStatus())
ipcMain.handle(CHANNELS.permissionsRequest, (_, id) => requestPermission(id))
ipcMain.handle(CHANNELS.permissionsOpenSettings, (_, id) => openPermissionSettings(id))
