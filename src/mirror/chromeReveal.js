/** 鼠标离开悬浮栏多久之后才收回（用户 2026-10-10：「鼠标只要移出悬浮栏 1 秒后才消失」）。 */
export const RAIL_HIDE_DELAY_MS = 1000;

/**
 * 右侧悬浮长条的显隐状态机（纯逻辑，便于单测）。
 *
 * 规则（2026-10-10 第三次改）：**进到触发区就显形；离开后隔 `hideAfterMs` 才收回**，
 * 期间再进来就把计时撤掉。取代之前两版 —— 「停手 1.5s 自动淡出」（作废）与
 * 「只有鼠标移出窗口才收」（也作废，收得太晚，鼠标回到画面上那条还杵着）。
 * `poke` / `leave` 由 window 上的 pointermove 每帧调 ⇒ 必须幂等，不能每次都发一遍开关红绿灯的 IPC。
 *
 * **常驻**（2026-10-11 加，长条上那颗"一直显示"的按钮）：`setPinned(true)` 之后 `leave` 不再收
 * —— 用户按下去就是"这条别再自己躲起来"，此时鼠标在哪都不该把它收掉。取消常驻只是把
 * "不许收"这一条撤掉，**不在这里排收回计时**（点那颗按钮时指针必然在条上；指针真在条外的
 * 路径由调用方补一次 `leave()`，见 `App.vue` 的 `toggleRailPinned`）。
 *
 * @param {{ onShow: (shown: boolean) => void, hideAfterMs?: number }} deps
 * @returns {{ poke: () => void, leave: () => void, setPinned: (pinned: boolean) => void }}
 */
export function createChromeReveal({ onShow, hideAfterMs = RAIL_HIDE_DELAY_MS }) {
  let shown = false;
  /** 常驻（用户点了"一直显示"）。与 `shown` 是两件事：常驻期间 `shown` 恒为真，但它不是"鼠标在条上"。 */
  let pinned = false;
  /** 唯一的收回到期时间：`leave` 重复触发不叠加（鼠标在格子边缘来回出界会连着发好几次）。 */
  let timer = null;

  function cancelHide() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  /** 状态真的变了才报 —— `poke` 每帧都调，这里不挡就是每帧一条 IPC。 */
  function apply(next) {
    if (shown === next) return;
    shown = next;
    onShow(next);
  }

  return {
    /** 鼠标进到手机右边那一格（触发挂在 `App.vue` 的 `.mirror-rail` 上）。 */
    poke() {
      cancelHide();
      apply(true);
    },
    /** 鼠标离开触发区（由调用方按 `rightEdgeZone` 判，格子矩形那套已废）。 */
    leave() {
      // 常驻时不收，也不排到期时间：排了就会在"取消常驻"那一刻冒出一个陈旧的计时。
      if (!shown || pinned || timer) return;
      timer = setTimeout(() => {
        timer = null;
        apply(false);
      }, hideAfterMs);
    },
    /**
     * 常驻开关。开的时候顺带把条显出来 —— 那颗按钮本身就在条上，但它该独立于 hover 生效。
     */
    setPinned(next) {
      pinned = Boolean(next);
      if (!pinned) return;
      cancelHide();
      apply(true);
    },
  };
}

/**
 * 满屏那一档（桌面模式）「指针进没进右边缘那一条」的判据，返回三态而不是布尔：
 * **进出的线不是同一条**（迟滞）。
 *
 * 为什么必须两条线：只有一条 86px 的线时，鼠标停在按钮上、或往左挪一点点去看浮出的 tooltip
 * （它 portal 到 body，在条的左边）就会立刻算「离开」⇒ 条收一半又弹回来，用户看到的就是
 * 「一闪一闪、而且常常要移几次才出得来」（2026-10-11）。所以：
 * - 进 `enterPx` 以内算 `enter`（显形）；
 * - 出 `exitPx` 以外算 `leave`（交给状态机延 `hideAfterMs` 收）；
 * - 中间那一圈 `hold` —— **什么都不做**，保持现在的样子。
 *
 * 只按横坐标判：满屏里贴任何高度都该能浮出条，不然顶部/底部要精确贴边才出得来。
 *
 * @param {{ clientX: number }} point
 * @param {number} windowWidth 窗口宽（CSS px）
 * @param {number} enterPx 进来算触发的宽度（= 长条格子宽）
 * @param {number} exitPx 离开算收线的宽度（比 `enterPx` 宽，构成迟滞）
 * @returns {'enter' | 'hold' | 'leave'}
 */
export function rightEdgeZone({ clientX }, windowWidth, enterPx, exitPx) {
  const fromRight = windowWidth - clientX;
  if (fromRight <= enterPx) return 'enter';
  if (fromRight > exitPx) return 'leave';
  return 'hold';
}
