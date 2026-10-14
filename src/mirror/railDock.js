/**
 * 悬浮长条的**纵向**落点计算（纯函数，便于单测）。
 *
 * 只做纵向：横向永远钉在窗口右边缘那一格 —— 那格在窗口态（窄画面）是**画面外面**（用户 10-10
 * 定稿「任何 UI 都不要在手机里出现」），画面够宽浮起来那一档与满屏态是浮在画面上的一格；
 * 允许横向拖就等于允许把条摆到手机画面中间盖住内容。
 *
 * 落点用 `translate: 0 <top>px` 表达（不吃布局 ⇒ 画面那块矩形一寸不动，不会白发一条
 * `resizeDisplay`，手机不会重排）。
 */

/** 上下各留这一点呼吸，条不会被拖到贴死屏幕边角抓不回来。 */
export const RAIL_EDGE_PAD = 12;

/**
 * 把想要的纵向偏移夹进可落点区间。
 *
 * @param {number} desired 期望的「面板顶边到窗口顶」距离（CSS px，可为负 / NaN）
 * @param {number} panelHeight 面板实测高
 * @param {number} viewportHeight 窗口高
 * @param {number} [pad] 上下呼吸位
 * @returns {number} 夹好的偏移；面板比窗口还高时只能回 0（顶格）
 */
export function clampRailTop(desired, panelHeight, viewportHeight, pad = RAIL_EDGE_PAD) {
  const want = Number(desired);
  if (!Number.isFinite(want)) return 0;
  const max = viewportHeight - panelHeight - pad;
  // 面板比窗口高（窗口拖到最矮 / 长条常驻那一屏）：没有可拖区间，钉回顶格。
  if (!(max > 0)) return 0;
  return Math.min(max, Math.max(-pad, want));
}

/**
 * **浮动态**（画面够宽、长条浮在画面里）的默认落点：上下居中（用户 2026-10-14 第二条
 * 「右侧悬浮操作栏上下居中」）。
 *
 * 窗口态那条贴顶是有原因的（面板与手机同高，整格占满，`clampRailTop` 只会回 0），浮起来之后
 * 面板只有内容那么高，贴着顶就成了一根挂在上沿的条 —— 居中是这一档该有的样子（与桌面模式全屏同源）。
 *
 * ⚠️ **它是"锚点"不是"约束"**：调用方在**进浮动态**与**窗口改大小**这两拍把它写进 `railTop`，
 * 之后用户照样能拖（拖出来的位移留到下一次重锚）。别每帧算 —— 那等于把拖拽功能废掉。
 *
 * @param {number} panelHeight 面板实测高
 * @param {number} viewportHeight 窗口高
 * @param {number} [pad] 上下呼吸位
 * @returns {number} 居中后的偏移（已夹进可落区间；面板比窗口高时回 0）
 */
export function railAnchorTop(panelHeight, viewportHeight, pad = RAIL_EDGE_PAD) {
  const center = (Number(viewportHeight) - Number(panelHeight)) / 2;
  return clampRailTop(center, panelHeight, viewportHeight, pad);
}
