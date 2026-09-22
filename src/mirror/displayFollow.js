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
// 结论：客户端只在「窗口对应的显示尺寸真的变了」时下发一次请求，并且**等尺寸停下来
// 再发**（debounce，不是 throttle）。
//
// 为什么必须 debounce：真机量过一次连续拖宽（每 150ms 发一步，920→1880 宽），
// 服务端的 300ms 去抖并没有把中间值合掉 —— 每一步都真的改了显示，于是 app 每一步都
// 重新决定一次布局：`≤1560x1800` 时它跟着填满，到 `1720x1800` 翻成固定比例竖条 + 左右
// 黑边，再到 `1880x1800` 又重排一次。表现出来就是用户说的「拖一下宽度画面转好几次」。
// 改成停手后才发，一次拖拽就只剩最后一次重排。
// ---------------------------------------------------------------------------

/** 尺寸稳定窗口：这段时间内没有新变化才真正下发（拖拽期间会被不断往后推）。 */
export const RESIZE_SETTLE_MS = 250;

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
 *   onIntent?: (size: { width: number, height: number }) => void,
 *   onSent?: (size: { width: number, height: number }) => void,
 *   onSkip?: () => void,
 *   settleMs?: number,
 *   setTimer?: (callback: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} options
 */
export function createDisplayFollower({
  send,
  onIntent,
  onSent,
  onSkip,
  settleMs = RESIZE_SETTLE_MS,
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
    if (!size || size.width <= 0 || size.height <= 0) {
      onSkip?.();
      return;
    }
    const key = displaySizeKey(size);
    // 尺寸没变就什么都不做：重复下发会让服务端白走一次 resize + capture reset。
    if (key === lastSent) {
      onSkip?.();
      return;
    }
    lastSent = key;
    // 「确实发出去了」与「用户有意图」是两件事：前者才需要等关键帧（见 createReflowGate）。
    onSent?.(size);
    // 下发失败：回滚记录让后续尺寸能重试，并回调 onSkip 撤遮罩——否则页面的重排门闩
    // 已被 arm，配置包永远不来，只能干等到 COVER_MAX_MS 兜底才揭。
    // 只有 lastSent 仍是自己时才算数：更新的下发已经接班的话，别动它的遮罩/门闩状态。
    const fail = () => {
      if (lastSent !== key) return;
      lastSent = "";
      onSkip?.();
    };
    try {
      Promise.resolve(send(size)).catch(fail);
    } catch {
      fail();
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
     * 请求把虚拟显示调整为该尺寸；与已下发尺寸相同则丢弃。每次请求都把定时器往后推，
     * 所以**拖拽过程中一条都不发**，只有尺寸停住 `settleMs` 后才发最后那个值。
     *
     * 但「要重排了」这件事在第一次请求时就该让页面知道（遮罩要在手一拖就盖上，
     * 不是停手才盖），所以每次请求都回调 `onIntent`；合并完发现尺寸其实没变（拖出去
     * 又拖回来）、或下发失败时回调 `onSkip`，页面据此撤罩。
     * @param {{ width: number, height: number }} size
     */
    request(size) {
      pending = size;
      onIntent?.(size);
      // 与 throttle（第一次变化起计时、期间只发一次）不同：这里每来一次变化就重新计时。
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, settleMs);
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

/**
 * 窗口比例与当前画面比例差多少才算「需要重排虚拟显示」。
 * 用在拖拽遮罩上：小于这个容差的抖动不值得把画面盖一次。
 * @param {number} windowRatio 窗口宽 / 高
 * @param {number} frameRatio 当前画面宽 / 高，0/NaN 表示还不知道
 * @param {number} [tolerance] 相对容差
 */
export function aspectDiffers(windowRatio, frameRatio, tolerance = 0.02) {
  if (!Number.isFinite(windowRatio) || !Number.isFinite(frameRatio)) return false;
  if (windowRatio <= 0 || frameRatio <= 0) return false;
  return Math.abs(windowRatio / frameRatio - 1) > tolerance;
}

/**
 * 「重排之后等到关键帧再揭遮罩」的门闩（纯逻辑，便于单测）。
 *
 * 为什么需要：设备端每次 `resizeDisplay` 都会 reset capture、重启编码器，重配后的
 * 第一个**可解码**画面必然是关键帧（前面还有一个新的 configuration 包）。只按时间
 * 揭遮罩（原来就是这么做的）会露出半帧或拖影 —— AndroMeld 那边同样有重排遮罩，
 * 但它多做了这一步（符号：`awaitingKeyFrameAfterReconfiguration`、强制 IDR 的
 * `request-sync`），我们照这个思路补。
 *
 * 只认「下发之后」的 configuration + 关键帧这一对；早到的关键帧不算数。
 */
export function createReflowGate() {
  let waiting = false;
  let sawConfig = false;
  return {
    /** 刚下发过一次 resizeDisplay：需要一对新的 configuration + 关键帧才算重排完成。 */
    arm() {
      waiting = true;
      sawConfig = false;
    },
    /** 收到流配置包（编码器重启的标志）。 */
    configuration() {
      if (waiting) sawConfig = true;
    },
    /**
     * 收到关键帧。
     * @returns {boolean} true 表示门闩满足，可以揭遮罩了。
     */
    keyFrame() {
      if (!waiting || !sawConfig) return false;
      waiting = false;
      sawConfig = false;
      return true;
    },
    /** 还在等关键帧（页面据此把遮罩再延一点，总时长仍有上限）。 */
    isWaiting: () => waiting,
    /** 换会话 / 遮罩从别的路径撤掉时清账。 */
    reset() {
      waiting = false;
      sawConfig = false;
    },
  };
}
