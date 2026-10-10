// ---------------------------------------------------------------------------
// 自研镜像的输入控制映射（control）
//
// 只保留「语义事件 → Tango writer 入参」的应用层映射；scrcpy 控制协议的
// 序列化由 Tango 的 `ScrcpyControlMessageWriter` 完成（injectTouch/
// injectScroll/injectKeyCode/injectText 官方方法直用）。数值是稳定的 Android
// 常量，仅用于单测。
//
// 系统动作键这一整类 `kind:'action'` 消息于 2026-09-28 按产品决策删除；2026-10-10 用户点名把
// **返回 / Home / 多任务**三个放回来（右侧悬浮长条上的按键，见 `App.vue` 的 `RAIL_KEYS`），
// 走的就是这里已有的 `kind:'key'` → `injectKeyCode` 那条路，**不另开 adb 进程**。
// 同一晚又点名要**关屏使用** ⇒ `kind:'screen'`（`setDisplayPower`）也回来了，同样是用户主动按的按钮。
// 音量 / 旋转 / 通知栏仍然不提供入口；**自动**的息屏干预依旧不做
// （原「启动后息屏」偏好连同 `controller.setDisplayPower(false)` 于 2026-09-29 删除，那条"自动"没恢复）。
// ---------------------------------------------------------------------------

import { KEY_META } from "../../shared/keys.js";
import {
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  AndroidScreenPowerMode,
} from "@yume-chan/scrcpy";

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

export { KEY_META };

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

/**
 * 「关屏使用 / 恢复亮屏」→ `setDisplayPower` 的电源模式。
 * 上游只有两档：`Off`(0) 把屏关掉、`Normal`(2) 回到系统默认（会按设备的超时再自己睡）。
 * 走的是 scrcpy 控制消息，**不占 `INJECT_EVENTS`**（不同于 `input keyevent 224` 那条唤醒）。
 */
export function toScreenPowerMode(message) {
  return message.on ? AndroidScreenPowerMode.Normal : AndroidScreenPowerMode.Off;
}

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
    case 'screen':
      return controller.setDisplayPower(toScreenPowerMode(message));
    case 'text':
      return controller.injectText(String(message.text ?? ''));
    default:
      throw new Error(`未知控制消息：${message?.kind}`);
  }
}
