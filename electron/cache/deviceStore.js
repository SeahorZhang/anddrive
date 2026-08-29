import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_DEVICES = 20

const storePath = () => path.join(app.getPath('userData'), 'devices-v1.json')

/** @param {unknown} value */
function sanitizeDevice(value) {
  if (!value || typeof value !== 'object') return null
  const device = /** @type {Record<string, unknown>} */ (value)
  if (typeof device.serial !== 'string' || !device.serial.trim()) return null
  const str = (v) => (typeof v === 'string' ? v.slice(0, 1024) : '')
  return {
    serial: device.serial.trim().slice(0, 1024),
    address: str(device.address),
    deviceName: str(device.deviceName),
    savedAt: typeof device.savedAt === 'number' ? device.savedAt : Date.now(),
  }
}

/**
 * Paired-device bookkeeping, persisted to userData/devices-v1.json.
 * Newest first, capped at {@link MAX_DEVICES} entries.
 */
export async function listSavedDevices() {
  try {
    const data = await fs.readFile(storePath(), 'utf8')
    const parsed = JSON.parse(data)
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitizeDevice).filter(Boolean)
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('Failed to read saved devices:', error)
    return []
  }
}

/**
 * Insert or update one device (matched by serial) and persist.
 * @param {{ serial: string, address?: string, deviceName?: string }} input
 */
export async function saveDevice(input) {
  const incoming = sanitizeDevice({ ...input, savedAt: Date.now() })
  if (!incoming) throw new Error('设备信息无效')
  // Field-level merge: an empty address/deviceName in the new payload must not
  // erase a previously saved value.
  const devices = await listSavedDevices()
  const previous = devices.find((d) => d.serial === incoming.serial)
  const merged = {
    ...previous,
    ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== '' && v != null)),
    savedAt: incoming.savedAt,
  }
  const next = [merged, ...devices.filter((d) => d.serial !== merged.serial)]
  await fs.writeFile(storePath(), JSON.stringify(next.slice(0, MAX_DEVICES), null, 2), 'utf8')
  return merged
}
