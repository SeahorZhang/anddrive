// Helper 协议常量与二进制图标帧解析。
export const HELPER_PROTOCOL_VERSION = 7
export const HELPER_PORT = 18923
// 投屏保活的专用转发端口：映射到设备上同一 helper 服务，
// 与 app 加载/device-info 的 18923 会话（forward 锁单槽管理）互不干扰。
export const HELPER_KEEPALIVE_PORT = 18924

/**
 * @param {string} path
 */
export const helperUrl = (path) => `http://127.0.0.1:${HELPER_PORT}${path}`

/**
 * @param {string} path
 */
export const helperKeepAliveUrl = (path) => `http://127.0.0.1:${HELPER_KEEPALIVE_PORT}${path}`

/**
 * 解析 /icons-bin 大端帧：[u16 包名长度][包名][u32 图标长度][PNG 字节]…；
 * 跳过空图标，截断帧处停止。
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
