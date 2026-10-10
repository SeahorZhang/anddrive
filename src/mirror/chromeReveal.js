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
 * @param {{ onShow: (shown: boolean) => void, hideAfterMs?: number }} deps
 * @returns {{ poke: () => void, leave: () => void }}
 */
export function createChromeReveal({ onShow, hideAfterMs = RAIL_HIDE_DELAY_MS }) {
  let shown = false;
  /** 唯一的收回到期时间：`leave` 重复触发不叠加（鼠标在格子边缘来回出界会连着发好几次）。 */
  let timer = null;

  function cancelHide() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  return {
    /** 鼠标进到手机右边那一格（触发挂在 `App.vue` 的 `.mirror-rail` 上）。 */
    poke() {
      cancelHide();
      if (shown) return;
      shown = true;
      onShow(true);
    },
    /** 鼠标离开那一格（坐标真的出了格子矩形才算，见 `isOutsideRect`）。 */
    leave() {
      if (!shown || timer) return;
      timer = setTimeout(() => {
        timer = null;
        shown = false;
        onShow(false);
      }, hideAfterMs);
    },
  };
}
