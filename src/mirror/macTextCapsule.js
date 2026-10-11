// 拼音胶囊（G1 续）：把"正在输入的拼音"画在 Mac 上，形状照竞品。
//
// 为什么必须自己画：macOS **不代画 marked text** —— 宿主（这里是 Chromium 的收字字段）收到
// `setMarkedText:` 之后由自己负责呈现。我们的收字字段是 1×1 全透明、`font-size:1px`，
// Chromium 把合成串画在里面等于看不见，所以这段得我们自己补一个可见的载体。
// 候选窗不用管：那是 macOS 画的，会按我们交出去的 caret 矩形落在胶囊**下面**。
//
// 判据与几何都抽在这里（纯函数，判据在 `tests/mirror/macTextCapsule.test.js`），
// 组件里只剩绑样式。
//
// ⚠️ 胶囊**固定宽度**、并且**夹在画面内**（第四轮）：宽度不随合成串变（`ffs dffsdfl` 那种
// 长串以前会把它顶出画面右缘、被裁掉半截）。夹取用的是 `.mirror-screen` 的宽，由调用方喂进来
// —— 这里不碰 DOM。

/**
 * 胶囊该不该出现、显示什么。
 *
 * 三条判据叠着，**任一条不成立都不画** —— 画错的表现是"用户没在打字，画面上却挂着一个胶囊"：
 * - `capturing`：归属是我们的（用户按了 × 让出、或切走，就不该再出现）；
 * - `focused`：收字字段**真的拿到焦点**（状态是 active 但焦点在长条按键上时，按键不进字段）；
 * - `composing`：正在合成（纯 ASCII 直接落字，不该有胶囊）。
 *
 * @param {{ capturing?: boolean, focused?: boolean, composing?: string }} state
 * @returns {{ visible: boolean, text: string }}
 */
export function macTextCapsule({ capturing = false, focused = false, composing = '' } = {}) {
  const text = typeof composing === 'string' ? composing : ''
  return { visible: Boolean(capturing) && Boolean(focused) && text.length > 0, text }
}

/**
 * 胶囊高 / 那一行的行高。
 *
 * 取自竞品截图（2026-10-11 第二轮对齐，`docs/NATIVE_MIRROR.md` §G1 Slice 4d）：
 * 中文正文墨迹高 28px ⇒ em ≈ 32px ⇒ 行高 ≈ 43px；胶囊实测高 56px ⇒ **≈1.3 个行高**。
 * 旧版是 0.93 个行高（字号 0.62 行高、无纵向内边距），所以看着比竞品小一圈。
 */
export const CAPSULE_HEIGHT_RATIO = 1.3

/**
 * 胶囊字号 / 胶囊高。
 *
 * 竞品同图：胶囊高 56px，拼音字高（升部到基线）20px ⇒ em ≈ 27px ⇒ **≈0.48 个胶囊高**。
 * 换算回行高就是 0.62 —— 与旧版字号一致，所以拼音本身没变大，变大的是胶囊壳。
 */
export const CAPSULE_FONT_RATIO = 0.48

/**
 * 胶囊**固定宽度** / 胶囊高。
 *
 * 竞品实测（2026-10-11 第四轮，逐像素量 560×248 那张图）：胶囊外框 x[259,450] 宽 **192**、
 * 高 **56** ⇒ **≈3.43，取 3.4**。
 *
 * ⚠️ 关键判据是它**不裹文字**：同一格里拼音墨迹只占 x[283,390]（宽 108），**左边距 24、
 * 右边距 60** —— 左右不对称，右边多出来的约 36px 是**预留**。两张竞品图（06-16 / 06-29）
 * 量出来是同一个数，不是量测噪声。
 *
 * 这正是用户 10-11 的要求：「拼音框不要无限长，固定宽度」—— 旧版没有 `width`，
 * 胶囊随合成串一直变长（`ffs dffsdfl` 那种能顶出画面右缘，被 `.mirror-screen` 的
 * `overflow: hidden` 裁掉半截）。短拼音时右边留白多一点，是**固定宽度**的必然结果，
 * 不是 bug。
 */
export const CAPSULE_WIDTH_RATIO = 3.4

/** 胶囊文字的下限字号（CSS px）：行高很小时也不至于糊成一团。 */
const CAPSULE_MIN_FONT_PX = 10

/**
 * 胶囊左边缘夹进画面里（`width` 是固定宽度、`screenWidth` 是 `.mirror-screen` 的 CSS 宽）。
 *
 * 画面宽拿不到（0 / 非有限数）就**不夹**：宁可按真实锚点摆，也不要凭空把胶囊拽到左边。
 */
function clampLeftToScreen(left, width, screenWidth) {
  if (!Number.isFinite(screenWidth) || screenWidth <= 0) return left
  return Math.max(0, Math.min(left, screenWidth - width))
}

/**
 * 「手机光标那一行」的矩形 → **胶囊矩形**（`.mirror-screen` 内的 CSS px）。
 *
 * 竞品的排布是**三层**：正文行 → 胶囊 → 系统候选条，自上而下。做法是把**胶囊自己的矩形**
 * 当成 caret 矩形交给 macOS（原生应用能自己实现 `NSTextInputClient.firstRectForCharacterRange:`
 * 返回任意矩形）。Electron 里改不了那条方法，但**收字字段摆哪就是哪个矩形**，所以同一个效果
 * 靠"把字段挪到胶囊那一格"拿到 —— 见 `App.vue` 的 `macTextAnchorStyle`。
 *
 * - 横向贴锚点（= 手机光标的 x），与旧版一致；
 * - 纵向**顶边贴在那一行的下沿**（`top + height`），这是与旧版唯一的语义变化
 *   （旧版是**以那一行为中心**，胶囊骑在行上，所以系统候选条只能落在行下、与胶囊同层）；
 * - 高度按 `CAPSULE_HEIGHT_RATIO` 放大；
 * - 宽度**固定**（`CAPSULE_WIDTH_RATIO`），并**夹进画面**（`left + width ≤ screenWidth`）。
 *
 * ⚠️ 夹的是**这个矩形本身**，也就是**字段位置与胶囊一起夹** —— 两层同源是前几轮一直在守的
 * 不变量。只夹胶囊、不夹字段的话，两层会在同一屏里错开，那是更坏的结果。
 * 代价：靠近画面右缘打字时矩形整体左移，候选窗跟着左移，与手机光标错开**最多一个胶囊宽**。
 *
 * ⚠️ 退化输入（`null` / 非有限数 / `height <= 0`）返回 `null`，由调用方决定跳过；
 * 不许兜底成 0 —— 那是把胶囊和候选窗一起锚回画面左上角。
 *
 * @param {{ left: number, top: number, height: number } | null} css
 * @param {number} [screenWidth] `.mirror-screen` 的宽（CSS px）；缺省/0 表示未知，不夹
 * @returns {{ left: number, top: number, height: number, width: number } | null}
 */
export function capsuleRect(css, screenWidth = 0) {
  if (!css || !Number.isFinite(css.left) || !Number.isFinite(css.top) || !Number.isFinite(css.height)) {
    return null
  }
  if (css.height <= 0) return null
  const height = css.height * CAPSULE_HEIGHT_RATIO
  const width = height * CAPSULE_WIDTH_RATIO
  return {
    left: clampLeftToScreen(css.left, width, screenWidth),
    top: css.top + css.height,
    height,
    width,
  }
}

/**
 * CSS px 字符串：保留两位小数。
 *
 * ⚠️ 不是洁癖：`26 × 3.4` 在浮点里是 `88.39999999999999`，不收敛的话宽度会绑成
 * `width: 88.39999999999999px` —— 浏览器认，但样式表与快照里全是噪声。
 */
function px(value) {
  return `${Math.round(value * 100) / 100}px`
}

/**
 * 胶囊矩形 → 组件要绑的样式（多一个字号）。
 *
 * @param {{ left: number, top: number, height: number } | null} css
 * @param {number} [screenWidth] 同 `capsuleRect`
 * @returns {{ left: string, top: string, width: string, height: string, fontSize: string } | null}
 */
export function capsuleBox(css, screenWidth = 0) {
  const rect = capsuleRect(css, screenWidth)
  if (!rect) return null
  return {
    left: px(rect.left),
    top: px(rect.top),
    width: px(rect.width),
    height: px(rect.height),
    fontSize: px(Math.max(CAPSULE_MIN_FONT_PX, rect.height * CAPSULE_FONT_RATIO)),
  }
}
