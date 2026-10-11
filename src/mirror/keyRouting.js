// 键盘事件的归属判定（G1 续）。
//
// 抽成纯函数的原因：这里有两个"谁负责这个键"的判据叠在一起 —— 输入法有没有吃掉它、
// 可打印字符归收字字段还是归 `kind:'text'`。写成一行行 `if` 时很容易把某一条分支漏在
// 提前 `return` 后面（10-11 的空格重复就是这么来的），抽出来才能被单测钉住。
import { KEYBOARD_KEYS } from '../../shared/keys.js'

/** Android 给"输入法正在消化这个键"的哨兵 keyCode（`KeyEvent.KEYCODE_UNKNOWN` 在合成态的值）。 */
const IME_PROCESSING_KEYCODE = 229

/**
 * 输入法正在消化这个键吗？中文输入法用**空格 / 回车选候选**时就是这种键。
 *
 * ⚠️ 这种键**不能再当按键转发给手机** —— 手机上会多出一个空格 / 换行。
 * 用户 10-11：「输入中感觉会多个空格」。候选词本身由收字字段的 `compositionend`
 * 走文本那条路送（见 `macTextSink.js`），不靠这个键。
 *
 * Chromium 在合成态下把 `keydown` / `keyup` 标成 `isComposing`，部分实现只给
 * `keyCode === 229`，所以两条都查。
 */
export function isImeKey(event) {
  return event?.isComposing === true || event?.keyCode === IME_PROCESSING_KEYCODE
}

/**
 * 一次 `keydown` 该怎么走。
 *
 * @param {{ key: string, keyCode?: number, isComposing?: boolean,
 *   metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean }} event
 * @param {{ captureText?: boolean }} [options]
 *   `captureText` = 可打印字符由 Mac 键盘那条路（隐藏字段 `input` → 桥）负责。
 * @returns {'key' | 'text' | null}
 *   `'key'`  → 按 `KEYBOARD_KEYS` 转发按键（退格 / 方向键 / 回车…）
 *   `'text'` → 当可打印字符注入（`kind:'text'`）
 *   `null`   → 这个键不归我们管
 */
export function routeKeyDown(event, { captureText = false } = {}) {
  // Cmd 组合键交给系统与应用（Cmd+Q / Cmd+W 等）。
  if (event.metaKey) return null
  // ⚠️ 这条必须在 `KEYBOARD_KEYS` 之前：空格 / 回车都在那张表里，而选候选的空格
  //    恰恰是输入法吃掉的键 —— 放到表后面就会被提前 return 掉，永远轮不到。
  if (isImeKey(event)) return null
  if (KEYBOARD_KEYS[event.key] !== undefined) return 'key'
  // Ctrl / Alt 组合（复制粘贴等）暂不处理。
  if (event.ctrlKey || event.altKey) return null
  if (typeof event.key === 'string' && event.key.length === 1) {
    // Mac 键盘开着时这一格由隐藏字段的 `input` 负责（那条能送中文），这里再发一遍就是双送。
    return captureText ? null : 'text'
  }
  return null
}
