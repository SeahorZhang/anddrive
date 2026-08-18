/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDisconnectSerial(value) {
  if (typeof value !== 'string') throw new Error('设备序列号无效')
  const serial = value.trim()
  if (!serial || serial.length > 1024 || /\s/.test(serial)) {
    throw new Error('设备序列号无效')
  }
  return serial
}

/** @param {unknown} error */
export function isAlreadyDisconnectedError(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /\bno such device\b|\bdevice(?:\s+['"\w.:[\]-]+)?\s+not found\b|\bnot connected\b/i.test(
    message,
  )
}

/** @param {unknown} error */
export function isMissingForwardError(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  return (
    isAlreadyDisconnectedError(error) ||
    /\blistener\s+['"]?tcp:\d+['"]?\s+not found\b/i.test(message)
  )
}
