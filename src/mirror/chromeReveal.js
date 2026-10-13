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
    /** 鼠标离开触发区（由调用方按 `chromeZone` 判，格子矩形那套已废）。 */
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
 * 「指针进没进那层 chrome 的两条边」的判据，返回三态而不是布尔：**进出的线不是同一条**（迟滞）。
 *
 * chrome 是一个 **L 形**：右边那一条（= 操作栏本身）+ 上边那一条（三颗与标题）。用户 10-12 明确
 * 「鼠标移动到右侧和上边都要展示边框」⇒ 两条臂都算触发区。
 * 为什么还要迟滞：只有一条线时，鼠标停在按钮上、或往左/往下挪一点去看 tooltip，条就当场收一半
 * 再弹回（「一闪一闪、常常要移几次才出得来」）。所以：
 * - 落在任一臂的 `enter` 范围内 → `enter`（显形）；
 * - 两条臂**都**越出 `exit` → `leave`（交给状态机延 `hideAfterMs` 收）；
 * - 其余 → `hold`，保持现状。
 *
 * @param {{ clientX: number, clientY: number }} point
 * @param {number} width 窗口宽（CSS px）
 * @param {number} height 窗口高
 * @param {{ x: number, y: number }} enter 两臂各自的进入宽度 / 高度
 * @param {{ x: number, y: number }} exit 两臂各自的收线（比 `enter` 宽，构成迟滞）
 * @returns {'enter' | 'hold' | 'leave'}
 */
export function chromeZone({ clientX, clientY }, width, height, enter, exit) {
  const fromRight = width - clientX;
  const fromTop = clientY;
  if (fromRight <= enter.x || fromTop <= enter.y) return 'enter';
  if (fromRight > exit.x && fromTop > exit.y) return 'leave';
  return 'hold';
}
