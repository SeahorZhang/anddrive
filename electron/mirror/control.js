// ---------------------------------------------------------------------------
// 自研镜像的输入控制映射（control）
//
// 只保留「语义事件 → Tango writer 入参」的应用层映射；scrcpy 控制协议的
// 序列化由 Tango 的 `ScrcpyControlMessageWriter` 完成（injectTouch/
// injectScroll/injectKeyCode/injectText/rotateDevice/setDisplayPower 等
// 官方方法直用）。数值是稳定的 Android 常量，仅用于单测。
// ---------------------------------------------------------------------------

import { KEY_CODES, KEY_META } from "../../shared/keys.js";
import { AndroidKeyEventAction, AndroidMotionEventAction, AndroidMotionEventButton } from "@yume-chan/scrcpy";

/** 语义动作（组件层事件的小写名）→ Tango 官方 `AndroidMotionEventAction`。 */
export const TOUCH_ACTION = {
  down: AndroidMotionEventAction.Down,
  move: AndroidMotionEventAction.Move,
  up: AndroidMotionEventAction.Up,
  cancel: AndroidMotionEventAction.Cancel,
};

/** 主键（左键/鼠标按下的手指）：Tango `AndroidMotionEventButton.Primary`。 */
export const TOUCH_BUTTON_PRIMARY = AndroidMotionEventButton.Primary;

/** android.view.KeyEvent 动作：Tango `AndroidKeyEventAction`（Down=0/Up=1）。 */
export const KEY_ACTION = AndroidKeyEventAction;

export { KEY_CODES, KEY_META };

/**
 * 键盘事件 → metaState 位。`preventDefault` 与否由渲染层判断（Cmd 组合键放行）。
 * @param {{ shiftKey?: boolean, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} event
 */
export function toMetaState(event) {
  let state = 0;
  if (event.shiftKey) state |= KEY_META.Shift;
  if (event.altKey) state |= KEY_META.Alt;
  if (event.ctrlKey) state |= KEY_META.Ctrl;
  if (event.metaKey) state |= KEY_META.Meta;
  return state;
}

/** 触摸事件 → `injectTouch` 参数。 */
export function toTouchMessage(message) {
  const up = message.action === 'up' || message.action === 'cancel'
  const down = message.action === 'down'
  return {
    action: TOUCH_ACTION[message.action] ?? TOUCH_ACTION.move,
    pointerId: 0n,
    pointerX: Math.round(message.x),
    pointerY: Math.round(message.y),
    videoWidth: Math.round(message.width),
    videoHeight: Math.round(message.height),
    pressure: message.pressure ?? (up ? 0 : 1),
    actionButton: down || message.action === 'up' ? TOUCH_BUTTON_PRIMARY : 0,
    buttons: up ? 0 : TOUCH_BUTTON_PRIMARY,
  };
}

/** 滚动事件 → `injectScroll` 参数（scrollX/Y 为浮点，由 Tango 累加成整数）。 */
export function toScrollMessage(message) {
  const clamp = (value) => Math.max(-1, Math.min(1, value))
  return {
    pointerX: Math.round(message.x),
    pointerY: Math.round(message.y),
    videoWidth: Math.round(message.width),
    videoHeight: Math.round(message.height),
    scrollX: clamp(message.scrollX),
    scrollY: clamp(message.scrollY),
  }
}

/** 按键事件 → `injectKeyCode` 参数。 */
export function toKeyMessage(message) {
  return {
    action: message.action === 'up' ? KEY_ACTION.Up : KEY_ACTION.Down,
    keyCode: message.keyCode,
    repeat: message.repeat ?? 0,
    metaState: message.metaState ?? 0,
  }
}

const TAP_ACTIONS = {
  back: KEY_CODES.back,
  home: KEY_CODES.home,
  appSwitch: KEY_CODES.appSwitch,
  power: KEY_CODES.power,
  volumeUp: KEY_CODES.volumeUp,
  volumeDown: KEY_CODES.volumeDown,
};

/**
 * 执行一条控制消息。会 await，调用方可 fire-and-forget。
 * @param {import("@yume-chan/scrcpy").ScrcpyControlMessageWriter} controller
 * @param {Record<string, unknown>} message
 */
export async function applyControl(controller, message) {
  switch (message?.kind) {
    case 'touch':
      return controller.injectTouch(toTouchMessage(message));
    case 'scroll':
      return controller.injectScroll(toScrollMessage(message));
    case 'key':
      return controller.injectKeyCode(toKeyMessage(message));
    case 'text':
      return controller.injectText(String(message.text ?? ''));
    case 'action':
      return applyAction(controller, String(message.action ?? ''));
    default:
      throw new Error(`未知控制消息：${message?.kind}`);
  }
}

/** @param {import("@yume-chan/scrcpy").ScrcpyControlMessageWriter} controller */
async function applyAction(controller, action) {
  if (action === 'rotate') return controller.rotateDevice();
  if (action === 'notification') return controller.expandNotificationPanel();
  if (action === 'screenOff') return controller.setDisplayPower(false);
  if (action === 'screenOn') return controller.setDisplayPower(true);
  const keyCode = TAP_ACTIONS[action];
  if (keyCode === undefined) throw new Error(`未知控制动作：${action}`);
  await controller.injectKeyCode({ action: KEY_ACTION.Down, keyCode, repeat: 0, metaState: 0 });
  await controller.injectKeyCode({ action: KEY_ACTION.Up, keyCode, repeat: 0, metaState: 0 });
}
