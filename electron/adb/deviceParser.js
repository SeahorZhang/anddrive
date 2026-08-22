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
 * @param {{ serial: string, model: string, brand: string, marketname: string }} output
 * @returns {import('../../shared/types.js').DeviceInfo}
 */
export function parseDeviceInfo({ serial, model, brand, marketname }) {
  const deviceName = marketname
    ? brand && !marketname.startsWith(brand)
      ? `${brand} ${marketname}`
      : marketname
    : `${brand} ${model}`.trim()

  return { serial, model, deviceName }
}
