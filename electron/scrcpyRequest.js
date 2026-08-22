const SCRCPY_DISPLAY = '1920x1080/320'
const SCRCPY_VIDEO_CODEC = 'h265'
const SCRCPY_VIDEO_BITRATE = '24M'

/**
 * Builds the scrcpy invocation from renderer-submitted domain data. CLI policy
 * (display, codec, bitrate, window placement) stays in main; the renderer
 * never assembles scrcpy flags.
 *
 * @param {unknown} options
 * @returns {{ args: string[], iconDataUrl: string }}
 */
export function buildScrcpyRequest(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('启动参数无效')
  }

  const request = /** @type {Record<string, unknown>} */ (options)
  const serial = validateSerial(request.serial)
  const packageName = validatePackageName(request.packageName)
  const label = validateLabel(request.label)
  const iconDataUrl = validateIconDataUrl(request.iconDataUrl)

  return {
    args: [
      '-s',
      serial,
      `--new-display=${SCRCPY_DISPLAY}`,
      `--start-app=${packageName}`,
      `--video-codec=${SCRCPY_VIDEO_CODEC}`,
      '-b',
      SCRCPY_VIDEO_BITRATE,
      '--window-x=auto',
      '--window-y=auto',
      `--window-title=${label}`,
    ],
    iconDataUrl,
  }
}

/** @param {unknown} value */
function validateSerial(value) {
  if (typeof value !== 'string' || !value || /\s/.test(value) || value.length > 1024) {
    throw new Error('设备序列号无效')
  }
  return value
}

/** @param {unknown} value */
function validatePackageName(value) {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new Error('应用包名无效')
  }
  return value
}

/** @param {unknown} value */
function validateLabel(value) {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new Error('应用名称无效')
  }
  return value
}

/** @param {unknown} value */
function validateIconDataUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length > 1024 * 1024 ||
    !value.startsWith('data:image/png;base64,')
  ) {
    throw new Error('应用图标无效')
  }
  return value
}
