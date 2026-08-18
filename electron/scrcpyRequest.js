/**
 * @param {unknown} options
 * @returns {import('../shared/types.js').ScrcpyRequest}
 */
export function validateScrcpyRequest(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('启动参数无效')
  }

  const request = /** @type {Record<string, unknown>} */ (options)
  if (
    !Array.isArray(request.args) ||
    !request.args.length ||
    request.args.length > 32 ||
    request.args.some((arg) => typeof arg !== 'string' || !arg.length || arg.length > 1024)
  ) {
    throw new Error('scrcpy 参数无效')
  }
  if (
    typeof request.packageName !== 'string' ||
    !request.packageName ||
    request.packageName.length > 256
  ) {
    throw new Error('应用包名无效')
  }
  if (
    typeof request.iconDataUrl !== 'string' ||
    request.iconDataUrl.length > 1024 * 1024 ||
    !request.iconDataUrl.startsWith('data:image/png;base64,')
  ) {
    throw new Error('应用图标无效')
  }

  return {
    args: request.args,
    packageName: request.packageName,
    iconDataUrl: request.iconDataUrl,
  }
}
