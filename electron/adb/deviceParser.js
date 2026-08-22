/**
 * @param {string} output
 * @returns {import('../../shared/types.js').AdbDevice[]}
 */
export function parseAdbDevices(output) {
  const devices = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('List of devices attached')) continue
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized)(?:\s|$)/)
    if (match) devices.push({ serial: match[1], state: match[2] })
  }
  return devices
}

/**
 * 解析 `adb mdns services` 输出中的无线连接目标（"ip:port"）。
 * adb server 自带的 mDNS 视图是比本机 Bonjour 更可靠的发现来源，
 * 只取 _adb-tls-connect._tcp 条目（pairing 端口不能用于建立 transport）。
 * @param {string} output
 * @returns {string[]}
 */
export function parseMdnsConnectTargets(output) {
  /** @type {string[]} */
  const targets = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.includes('_adb-tls-connect._tcp')) continue
    const match = line.match(/(\d{1,3}(?:\.\d{1,3}){3}:(?:\d{1,5}))\s*$/)
    if (match && !targets.includes(match[1])) targets.push(match[1])
  }
  return targets
}

/**
 * @param {{ serial: string, model: string, brand: string, marketname: string, batteryOutput: string, storageOutput: string }} output
 * @returns {import('../../shared/types.js').DeviceInfo}
 */
export function parseDeviceInfo({
  serial,
  model,
  brand,
  marketname,
  batteryOutput,
  storageOutput,
}) {
  const deviceName = marketname
    ? brand && !marketname.startsWith(brand)
      ? `${brand} ${marketname}`
      : marketname
    : `${brand} ${model}`.trim()

  const batteryMatch = batteryOutput.match(/level:\s*(\d+)/)
  const battery = batteryMatch ? Number.parseInt(batteryMatch[1], 10) : -1
  const isCharging = batteryOutput.match(/status:\s*(\d+)/)?.[1] === '2'

  let storage = ''
  let storagePercent = 0
  for (const line of storageOutput.trim().split('\n')) {
    const trimmedLine = line.trim()
    if (!trimmedLine.endsWith(' /data')) continue
    const parts = trimmedLine.split(/\s+/).filter(Boolean)
    if (parts.length >= 5) {
      storage = `${parts[2]}/${parts[1]}`
      storagePercent = Number.parseInt(parts[4], 10) || 0
    }
    break
  }

  return { serial, model, deviceName, battery, isCharging, storage, storagePercent }
}
