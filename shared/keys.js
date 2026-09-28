// 主进程（输入控制映射）与渲染层（DOM 键盘映射）共用的 Android 键值常量。
// 键值与 metaState 位来自 Tango 官方常量（@yume-chan/scrcpy 的 android 模块），
// 这里只维护应用层语义命名与 DOM 键映射。

import { AndroidKeyCode, AndroidKeyEventMeta } from "@yume-chan/scrcpy";

/**
 * 常用 android.view.KeyEvent 键值（Tango `AndroidKeyCode` 的应用语义别名）。
 * 只列**真的会发出去**的键：系统动作键（Home / 多任务 / 电源 / 音量）那套
 * 2026-09-28 已按产品决策整体删除，不要为它再加别名。
 */
export const KEY_CODES = {
  back: AndroidKeyCode.AndroidBack,
  arrowUp: AndroidKeyCode.ArrowUp,
  arrowDown: AndroidKeyCode.ArrowDown,
  arrowLeft: AndroidKeyCode.ArrowLeft,
  arrowRight: AndroidKeyCode.ArrowRight,
  tab: AndroidKeyCode.Tab,
  space: AndroidKeyCode.Space,
  enter: AndroidKeyCode.Enter,
  backspace: AndroidKeyCode.Backspace,
  pageUp: AndroidKeyCode.PageUp,
  pageDown: AndroidKeyCode.PageDown,
  del: AndroidKeyCode.Delete,
};

/** DOM `KeyboardEvent.key` → Android 键值；未列出的可打印字符走文本注入。 */
export const KEYBOARD_KEYS = {
  Enter: KEY_CODES.enter,
  Backspace: KEY_CODES.backspace,
  Tab: KEY_CODES.tab,
  ' ': KEY_CODES.space,
  // Esc 映射为返回键（桌面习惯）。
  Escape: KEY_CODES.back,
  Delete: KEY_CODES.del,
  ArrowUp: KEY_CODES.arrowUp,
  ArrowDown: KEY_CODES.arrowDown,
  ArrowLeft: KEY_CODES.arrowLeft,
  ArrowRight: KEY_CODES.arrowRight,
  PageUp: KEY_CODES.pageUp,
  PageDown: KEY_CODES.pageDown,
};

/** android.view.KeyEvent metaState 位（Tango `AndroidKeyEventMeta` 官方值）。 */
export const KEY_META = AndroidKeyEventMeta;
