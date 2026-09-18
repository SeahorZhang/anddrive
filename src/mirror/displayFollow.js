// ---------------------------------------------------------------------------
// 虚拟显示跟随窗口的请求合并器（纯逻辑，便于单测）
//
// 背景（scrcpy 4.0 服务端行为，见 server 的 video/NewDisplayCapture.java）：
// - 虚拟显示以 `--new-display` 的尺寸创建；之后每条 `resizeDisplay` 控制消息都会
//   走到 `virtualDisplay.resize()`。显示属性一旦变化，服务端就 reset capture、
//   重启编码器，并把新尺寸经 stream meta 下发给客户端。
// - 虚拟显示带 `VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT`，**旋转由设备上的应用
//   决定**。而每次 resize 都是一次配置变更，应用（例如抖音）会重新走一遍方向
//   决策 —— 于是画面看起来「旋转了几下」。
//
// 结论：客户端只在「窗口对应的显示尺寸真的变了」时下发一次请求，并把短时间内的
// 多次变化合并成一次（服务端另有 300ms 去抖，见 DisplayResizeDebouncer）。
// ---------------------------------------------------------------------------

/** 合并窗口：窗口拖动时把短时间内的多次尺寸变化并成一次请求。 */
export const RESIZE_COALESCE_MS = 150;

/**
 * 尺寸指纹，用于判断「与上次下发的尺寸是否相同」。
 * @param {{ width: number, height: number } | null | undefined} size
 * @returns {string}
 */
export function displaySizeKey(size) {
  if (!size) return "";
  return `${size.width}x${size.height}`;
}

/**
 * @param {{
 *   send: (size: { width: number, height: number }) => unknown,
 *   coalesceMs?: number,
 *   setTimer?: (callback: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} options
 */
export function createDisplayFollower({
  send,
  coalesceMs = RESIZE_COALESCE_MS,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  /** 最近一次实际下发的尺寸指纹；空串表示尚未下发过。 */
  let lastSent = "";
  /** 待下发的尺寸（合并窗口内以最后一次为准）。 */
  let pending = null;
  let timer = null;

  function flush() {
    timer = null;
    const size = pending;
    pending = null;
    if (!size || size.width <= 0 || size.height <= 0) return;
    const key = displaySizeKey(size);
    // 尺寸没变就什么都不做：重复下发会让服务端白走一次 resize + capture reset。
    if (key === lastSent) return;
    lastSent = key;
    try {
      Promise.resolve(send(size)).catch(() => {
        // 下发失败（连接已断等）：清掉记录，让后续尺寸变化仍可重试。
        lastSent = "";
      });
    } catch {
      lastSent = "";
    }
  }

  return {
    /**
     * 会话建立阶段已用该尺寸创建虚拟显示（`connect.js` 的 `newDisplay`），
     * 记为已下发，避免启动时立刻重复下发一次完全相同的 resizeDisplay。
     * @param {{ width: number, height: number } | null | undefined} size
     */
    seed(size) {
      lastSent = displaySizeKey(size);
    },

    /**
     * 请求把虚拟显示调整为该尺寸；与已下发尺寸相同则丢弃，多次请求在合并窗口内
     * 只下发最后一次。
     * @param {{ width: number, height: number }} size
     */
    request(size) {
      pending = size;
      if (timer !== null) return;
      timer = setTimer(flush, coalesceMs);
    },

    /** 会话结束：丢弃待发请求。 */
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },

    /** 最近一次实际下发的尺寸指纹（`宽x高`），未下发过为空串。 */
    get lastSentKey() {
      return lastSent;
    },
  };
}
