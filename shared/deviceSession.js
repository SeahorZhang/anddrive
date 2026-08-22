/**
 * Single-device session rule. Multiple online devices are a conflict and are
 * never silently reduced to the first entry.
 *
 * @typedef {{ status: 'empty' }} EmptySession
 * @typedef {{ status: 'connected', serial: string }} ConnectedSession
 * @typedef {{ status: 'conflict', serials: string[] }} ConflictSession
 * @typedef {EmptySession | ConnectedSession | ConflictSession} DeviceSession
 */

/**
 * @param {import('./types.js').AdbDevice[]} devices
 * @returns {DeviceSession}
 */
export function resolveSession(devices) {
  const online = (devices || []).filter((device) => device.state === 'device')
  if (online.length === 0) return { status: 'empty' }
  if (online.length === 1) return { status: 'connected', serial: online[0].serial }
  return { status: 'conflict', serials: online.map((device) => device.serial) }
}
