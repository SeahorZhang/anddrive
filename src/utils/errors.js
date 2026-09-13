/**
 * 渲染层错误工具。
 *
 * 主进程抛出的错误经 ipcRenderer.invoke 跨桥后会被 Electron 包一层
 * （如 `Error invoking remote method 'adb:x': Error: 原始信息`）。这里统一
 * 剥离外层包装，并识别主进程约定的 `HELPER_SETUP:` 前缀，让界面拿到可直接
 * 展示的文案。
 */

export const HELPER_SETUP_PREFIX = "HELPER_SETUP:";

/** @param {unknown} error */
function rawMessage(error) {
  if (error && typeof error === "object" && "message" in error) {
    const message = /** @type {{ message?: unknown }} */ (error).message;
    return typeof message === "string" ? message : "";
  }
  return typeof error === "string" ? error : "";
}

/**
 * 转为用户可读的错误文案，并在 Helper 未就绪时去掉 `HELPER_SETUP:` 前缀。
 * @param {unknown} error
 * @param {string} [fallback]
 * @returns {string}
 */
export function readableError(error, fallback = "操作失败") {
  let text = rawMessage(error).trim();
  const helperIndex = text.indexOf(HELPER_SETUP_PREFIX);
  if (helperIndex >= 0) {
    text = text.slice(helperIndex + HELPER_SETUP_PREFIX.length);
  } else {
    text = text.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "");
  }
  return text.trim() || fallback;
}

/**
 * 主进程用 `HELPER_SETUP:` 标记“Helper 无法安装/运行”，渲染层据此给出
 * “安装 Helper”行动按钮。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isHelperSetupError(error) {
  return rawMessage(error).includes(HELPER_SETUP_PREFIX);
}
