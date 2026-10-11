// 候选窗锚点的坐标换算（G1 续）。
//
// 背景：macOS 摆放输入法候选窗**只认宿主交给它的 caret 矩形**。原生应用（竞品）自己实现
// `NSTextInputClient.firstRectForCharacterRange:`，把手机光标换算成屏幕坐标返回回去；Electron
// 里这条方法改不了 —— Chromium 拿**聚焦元素的 DOM caret 矩形**充当它。所以渲染层只有一条路：
// 把收字字段（`.mirror-mactext`）挪到手机光标那个点上，候选窗自然跟过去。
//
// 这里放的是两个方向的**纯换算**（不碰 DOM），量的是同一块 canvas 显示矩形，
// 与 `useMirrorInput.videoCoords()` 互为逆变换 —— letterbox 的黑边在两个方向上都被同一套
// 比例排除，不需要各自再算一遍。
//
// ⚠️ 输入退化（尺寸未知、矩形为零）一律返回 `null`，由调用方决定跳过；不要在这里兜底成 0，
// 那会把候选窗锚到画面左上角 —— 正是这次要修的现象。

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function usableRect(rect) {
  return Boolean(rect) && positive(rect.width) && positive(rect.height);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Android 正文默认字号（sp）。只用来把「一个字多宽」换算成设备像素，取的是最常见的那一档。 */
export const BODY_TEXT_SP = 16;
/** 行高 / 字号。Android 的光标就是一条**行高**的竖线，所以 caret 矩形的高度按它算。 */
export const LINE_HEIGHT_RATIO = 1.35;

/** 字号 → 设备像素（1sp = dpi/160 px）。 */
export function emSizePx(dpi) {
  return (BODY_TEXT_SP * dpi) / 160;
}

/**
 * 中日韩 / 全角字符 —— 这些按 1 em 估（等宽方块字，估得准），其余按 0.55 em 估。
 * 覆盖 CJK 统一表意、扩展 A、谚文、全角形式与全角标点。
 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * 一段文本在手机上占多宽（设备 px）。
 *
 * ⚠️ 这是**估计**，不是测量 —— 它只是设备侧那条精确路（`caretRectToAnchor`）的**退路**：
 * 设备报得到真实光标矩形时用那个（现在是主路），报不到（编辑器不支持、或光标没了）才用这条
 * 按送出去的文本自己推。宽字符估得准（方块字），拉丁字符有 ±10% 的误差；估小了候选窗会落在
 * 光标后面，估大了会超前。
 *
 * @param {string} text
 * @param {number} emPx 一个 em 有多少设备像素
 * @returns {number} 设备 px
 */
export function estimateAdvancePx(text, emPx) {
  if (!text || !(emPx > 0)) return 0;
  let em = 0;
  for (const char of text) em += WIDE_CHAR.test(char) ? 1 : 0.55;
  return em * emPx;
}

/**
 * 设备侧报来的**光标矩形** → 锚点 + 高度。
 *
 * 这是 2026-10-11 从竞品身上挖出来的那条路（见 `docs/NATIVE_MIRROR.md` §G1 Slice 4c）：
 * 输入法在 `InputConnection` 上调 `requestCursorUpdates(CURSOR_UPDATE_MONITOR)`，
 * 编辑器就会把 `CursorAnchorInfo` 推进 `onUpdateCursorAnchorInfo`。
 *
 * ⚠️ 不请求就永远收不到 —— 这正是我们此前误判"Android 拿不到光标像素位置"的原因
 * （`mCursorRect` 恒为 `0,0-0,0` 不是没有，是没人要）。
 *
 * ⚠️⚠️ 还有一层坑（2026-10-11 踩过）：`getInsertionMarker*` 报的是**编辑器本地坐标**，必须过
 * `CursorAnchorInfo.getMatrix()` 才是屏幕坐标 —— 官方类摘要那句 "in the screen coordinates"
 * 说的是过矩阵之后的结果。**变换在设备侧做**（`MirrorInputMethodService.onUpdateCursorAnchorInfo`），
 * 所以走到这里的入参已经是**屏幕坐标、设备 px**。当时漏了这一步，把本地坐标误读成"平台给不出
 * 屏幕坐标"，一度整条路关掉；补上后两类编辑器（MIUI 原生 EditText / Chromium WebView）都精确吻合。
 *
 * @param {{ x: number, top: number, bottom: number } | null | undefined} rect 屏幕坐标（设备 px）
 * @returns {{ x: number, y: number, height: number } | null} 锚点（设备 px）+ 矩形高度（设备 px）
 */
export function caretRectToAnchor(rect) {
  if (!rect) return null;
  const { x, top, bottom } = rect;
  if (![x, top, bottom].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return { x, y: (top + bottom) / 2, height: Math.max(0, bottom - top) };
}

/**
 * 窗口里的一个点 → **设备坐标**（视频像素）。
 *
 * 夹进显示矩形内：点到 letterbox 的黑边上时，映射结果会落在 [0, size] 之外，
 * 而候选窗不该被甩到画面外。
 *
 * @param {{ clientX: number, clientY: number, rect: { left: number, top: number, width: number, height: number }, size: { width: number, height: number } }} input
 * @returns {{ x: number, y: number } | null}
 */
export function clientToDevice({ clientX, clientY, rect, size }) {
  if (!usableRect(rect) || !positive(size?.width) || !positive(size?.height)) return null;
  return {
    x: clamp((clientX - rect.left) * (size.width / rect.width), 0, size.width),
    y: clamp((clientY - rect.top) * (size.height / rect.height), 0, size.height),
  };
}

/**
 * 设备坐标 → **交给 macOS 的那个 caret 矩形**（`.mirror-screen` 内的 CSS px）。
 *
 * 锚点存设备坐标、显示位置每次现算，窗口缩放与黑边比例变化就都自动跟上，不用在 resize 里
 * 另存一份记忆。`screenRect` 是定位祖先的矩形 —— 字段是 `position: absolute`，坐标相对它。
 *
 * ⚠️ `caretHeightPx` 不是装饰：给 macOS 一个 1px 高的矩形，它就把候选窗摆在那个点上，
 * 结果压在文字行上；给**一个行高**、并让矩形**以锚点为中心**（底边落在文字行底），
 * 它才落在文字行**下方** —— 这才是「候选窗在光标下方」。
 *
 * @param {{ point: { x: number, y: number } | null, rect: { left: number, top: number, width: number, height: number }, size: { width: number, height: number }, screenRect: { left: number, top: number }, caretHeightPx?: number }} input
 * @returns {{ left: number, top: number, height: number } | null}
 */
export function deviceToScreen({ point, rect, size, screenRect, caretHeightPx = 0 }) {
  if (!point || !usableRect(rect) || !positive(size?.width) || !positive(size?.height)) return null;
  if (!screenRect) return null;
  const height = positive(caretHeightPx) ? (caretHeightPx / size.height) * rect.height : 0;
  return {
    left: rect.left + (point.x / size.width) * rect.width - screenRect.left,
    top: rect.top + (point.y / size.height) * rect.height - screenRect.top - height / 2,
    height,
  };
}
