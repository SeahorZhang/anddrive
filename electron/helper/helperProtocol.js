export const HELPER_PORT = 18923
export const HELPER_PROTOCOL_VERSION = 3
export const ICON_BATCH_SIZE = 24
export const ICON_BATCH_CONCURRENCY = 4

/** @param {string} path */
export const helperUrl = (path) => `http://127.0.0.1:${HELPER_PORT}${path}`

/**
 * Decode big-endian frames of `[u16 pkgLen][pkg][u32 iconLen][icon]`.
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
