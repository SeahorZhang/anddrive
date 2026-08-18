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

/**
 * @param {Buffer} buffer
 * @returns {{ packageName: string, iconUrl: string }[]}
 */
export function parseIconBatch(buffer) {
  const apps = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const packageLength = buffer.readUInt16BE(offset)
    offset += 2
    if (packageLength === 0 || offset + packageLength + 4 > buffer.length) break
    const packageName = buffer.toString('utf8', offset, offset + packageLength)
    offset += packageLength
    const iconLength = buffer.readUInt32BE(offset)
    offset += 4
    if (iconLength > buffer.length - offset) break
    if (iconLength > 0) {
      const icon = buffer.subarray(offset, offset + iconLength)
      apps.push({ packageName, iconUrl: `data:image/png;base64,${icon.toString('base64')}` })
    }
    offset += iconLength
  }
  return apps
}
