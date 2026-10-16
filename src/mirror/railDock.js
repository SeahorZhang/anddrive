/**
 * 悬浮操作条的落点计算（纯函数，便于单测）。
 *
 * 两条路：
 * - **满屏那两档**：只做纵向（`clampRailTop` / `railAnchorTop`）—— 横向永远钉在窗口右边缘那一格
 *   （真全屏是「画面一格 + 长条一格」的两格排法，长条那一格就是它的位置）。
 * - **窗口态**（浮在画面顶部的那条玻璃胶囊）：**横纵都能拖**（`clampRailPos`，2026-10-16 用户
 *   「右侧操作栏可拖动」）。它浮在画面上、不占布局 ⇒ 拖到哪都不改窗口尺寸、也不改画面矩形。
 *
 * 落点用 `translate` 表达（不吃布局 ⇒ 画面那块矩形一寸不动，不会白发一条 `resizeDisplay`，
 * 手机不会重排）。
 */

/** 上下左右各留这一点呼吸，条不会被拖到贴死窗口边角抓不回来。 */
export const RAIL_EDGE_PAD = 12;

/**
 * 拖起来的最小位移（CSS px，两轴直线距离）。
 *
 * 为什么要它：窗口态那条胶囊里**几乎全是按钮**（6 颗 22px 的键 + 2px 间隙，整条 159px 里只剩
 * 3px 的 padding 能抓），只认"抓空白处"等于没法拖。有了阈值就变成：
 * **按在按钮上不动 = 点它，按住了挪过 4px = 拖整条**（macOS 的拖动阈值也在这一档）。
 * 4 是"手抖"与"真的要拖"之间那条线，取小一点更跟手。
 */
export const RAIL_DRAG_THRESHOLD = 4;

/**
 * 单轴夹取：把"条在这一轴上的起点"夹进 `[−pad, 窗口长 − 条长 − pad]`。
 *
 * @param {number} desired 期望起点（CSS px，可为负 / NaN）
 * @param {number} extent 条在这一轴上的长度
 * @param {number} viewportExtent 窗口在这一轴上的长度
 * @param {number} pad 两端呼吸位
 * @returns {number} 夹好的起点；条比窗口还长时只能回 0（贴起始边）
 */
function clampAxis(desired, extent, viewportExtent, pad) {
  const want = Number(desired);
  if (!Number.isFinite(want)) return 0;
  const max = Number(viewportExtent) - Number(extent) - pad;
  // 条比窗口还长（窗口拖到最矮 / 长条常驻那一屏）：没有可拖区间，钉回起始边。
  if (!(max > 0)) return 0;
  // ⚠️ 下沿写成 `pad > 0 ? -pad : 0` 而不是 `-pad`：`pad = 0` 时 `-pad` 是 **-0**，
  // 它一路传到 `translate: -0px` 与测试的 `toEqual(0)` 都会出岔子（`Object.is(-0, 0)` 为假）。
  return Math.min(max, Math.max(pad > 0 ? -pad : 0, want));
}

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
  return clampAxis(desired, panelHeight, viewportHeight, pad);
}

/**
 * **窗口态胶囊**的落点：横纵都夹一遍，返回左上角在**窗口内容区**里的坐标。
 *
 * 与 `clampRailTop` 同一套夹法（`pad` 是那个"别贴死边角"的呼吸位），只是两轴都做。
 * 调用方把结果写进 `--rail-x` / `--rail-y`，由 CSS 的 `translate` 落到画面上。
 *
 * ⚠️ 尺寸要传**面板实测值**（`offsetWidth/offsetHeight`）：胶囊宽度由内容撑开、按钮数随条件
 * 渲染（桌面模式那颗只在采主屏那档出、dev 那格只在开发时出）⇒ 不能写死一个常量。
 *
 * @param {{ x: number, y: number }} desired 期望的胶囊左上角（窗口内容区坐标系）
 * @param {{ width: number, height: number }} size 胶囊实测尺寸
 * @param {{ width: number, height: number }} viewport 窗口内容区尺寸
 * @param {number} [pad] 四周呼吸位
 * @returns {{ x: number, y: number }}
 */
export function clampRailPos(desired, size, viewport, pad = RAIL_EDGE_PAD) {
  return {
    x: clampAxis(desired?.x, size?.width, viewport?.width, pad),
    y: clampAxis(desired?.y, size?.height, viewport?.height, pad),
  };
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
 * ⚠️ **2026-10-16 起窗口态（胶囊）不再用它**：那条胶囊的默认落点由 `mirrorRailTop()` 给
 * （与三颗彩虹键中线对齐），这份 `railAnchorTop` 只剩满屏那两档在用。
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
