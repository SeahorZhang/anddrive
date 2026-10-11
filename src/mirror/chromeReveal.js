/**
 * 指针坐标是否落在某个矩形之外。
 *
 * 「移出悬浮栏」不能直接信 `pointerleave`：面板显形那一刻它会盖到触发格上面，命中层一变浏览器就
 * 补发一次 leave，坐标其实还在格里（用户 2026-10-10 报的「展示/隐藏来回抖」）。先过这道几何关。
 *
 * @param {{ clientX: number, clientY: number }} point
 * @param {{ left: number, top: number, right: number, bottom: number }} rect
 */
export function isOutsideRect({ clientX, clientY }, rect) {
  return clientX <= rect.left || clientY <= rect.top || clientX >= rect.right || clientY >= rect.bottom;
}

/** 鼠标离开悬浮栏多久之后才收回（用户 2026-10-10：「鼠标只要移出悬浮栏 1 秒后才消失」）。 */
export const RAIL_HIDE_DELAY_MS = 1000;

/**
 * 右侧悬浮长条的显隐状态机（纯逻辑，便于单测）。
 *
 * 规则（2026-10-10 第三次改）：**进到那一格就显形；离开那一格后隔 `hideAfterMs` 才收回**，
 * 期间再进来就把计时撤掉。取代之前两版 —— 「停手 1.5s 自动淡出」（作废）与
 * 「只有鼠标移出窗口才收」（也作废，收得太晚，鼠标回到画面上那条还杵着）。
 * `poke` 挂在 pointermove 上每帧都调 ⇒ 必须幂等，不能每次都发一遍开关红绿灯的 IPC。
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
    /** 鼠标离开那一格（坐标真的出了格子矩形才算，见 `isOutsideRect`）。 */
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
