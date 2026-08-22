/**
 * 单设备选择规则：0 台在线 → none；恰好 1 台 → ok；多台 → conflict。
 * 多台在线时不得静默取第一台，由调用方展示冲突错误。
 *
 * @param {import('./types.js').AdbDevice[]} devices
 * @returns {import('./types.js').AdbSelection}
 */
export function selectDevice(devices) {
  const online = devices.filter((device) => device.state === 'device')
  if (online.length === 0) return { status: 'none' }
  if (online.length === 1) return { status: 'ok', device: online[0] }
  return { status: 'conflict', devices: online }
}
