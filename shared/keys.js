// 主进程（输入控制映射）与渲染层（DOM 键盘映射）共用的 Android 键值常量。

/** 常用 android.view.KeyEvent 键值。 */
export const KEY_CODES = {
  home: 3,
  back: 4,
  arrowUp: 19,
  arrowDown: 20,
  arrowLeft: 21,
  arrowRight: 22,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  tab: 61,
  space: 62,
  enter: 66,
  backspace: 67,
  pageUp: 92,
  pageDown: 93,
  escape: 111,
  del: 112,
  appSwitch: 187,
};

/** DOM `KeyboardEvent.key` → Android 键值；未列出的可打印字符走文本注入。 */
export const KEYBOARD_KEYS = {
  Enter: KEY_CODES.enter,
  Backspace: KEY_CODES.backspace,
  Tab: KEY_CODES.tab,
  ' ': KEY_CODES.space,
  Escape: KEY_CODES.back,
  Delete: KEY_CODES.del,
  ArrowUp: KEY_CODES.arrowUp,
  ArrowDown: KEY_CODES.arrowDown,
  ArrowLeft: KEY_CODES.arrowLeft,
  ArrowRight: KEY_CODES.arrowRight,
  PageUp: KEY_CODES.pageUp,
  PageDown: KEY_CODES.pageDown,
};

/** android.view.KeyEvent metaState 位。 */
export const KEY_META = { shift: 0x01, alt: 0x02, ctrl: 0x1000, meta: 0x10000 };
