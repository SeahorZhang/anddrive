/**
 * 校验 renderer 提交的 scrcpy 启动请求（纯领域数据），并提供 CLI args 构建。
 * 渲染进程不得自行拼接 scrcpy 参数；默认码率、窗口参数等策略集中在这里。
 * @param {unknown} options
 * @returns {import('../../shared/types.js').ScrcpyLaunchInput}
 */
export function validateScrcpyRequest(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('启动参数无效')
  }

  const request = /** @type {Record<string, unknown>} */ (options)
  if (typeof request.serial !== 'string' || !request.serial || request.serial.length > 256) {
    throw new Error('设备序列号无效')
  }
  if (
    typeof request.packageName !== 'string' ||
    !request.packageName ||
    request.packageName.length > 256
  ) {
    throw new Error('应用包名无效')
  }
  if (typeof request.label !== 'string' || request.label.length > 512) {
    throw new Error('应用名称无效')
  }
  if (
    typeof request.iconDataUrl !== 'string' ||
    request.iconDataUrl.length > 1024 * 1024 ||
    !request.iconDataUrl.startsWith('data:image/png;base64,')
  ) {
    throw new Error('应用图标无效')
  }

  return /** @type {import('../../shared/types.js').ScrcpyLaunchInput} */ (request)
}

/**
 * 由领域数据构建 scrcpy CLI args（单处维护默认码率与窗口参数）。
 * @param {import('../../shared/types.js').ScrcpyLaunchInput} input
 * @returns {string[]}
 */
export function buildScrcpyArgs({ serial, packageName, label }) {
  return [
    '-s',
    serial,
    '--new-display=1920x1080/320',
    `--start-app=${packageName}`,
    '--video-codec=h265',
    '-b',
    '24M',
    '--window-x=auto',
    '--window-y=auto',
    `--window-title=${label || packageName}`,
  ]
}
