import { toast } from "vue-sonner";
import { readableError } from "@/utils/errors";

/**
 * 全局通知封装，统一走 vue-sonner。
 *
 * 对外 API 保持不变，便于各模块调用：
 * - notify(options) / notify.success|error|info|loading(message, options)
 * - notify.update(id, patch)：把 loading 更新为 success/error（同 id 原地更新）
 * - dismiss(id)
 *
 * options: { title?, message?, duration?, action?, key? }
 * - title 作为标题，message 作为描述；只有 message 时 message 作为标题
 * - key 作为 sonner 的 id，相同 key 的通知会覆盖旧的一条
 * - action: { label, handler, dismiss? }，点击执行 handler，成功后自动关闭
 */
const DEFAULT_DURATION = 4500;
const ERROR_DURATION = 8000;

/** @type {Map<string, { id: string, type: string, title: string, message: string, duration?: number, action?: any }>} */
const registry = new Map();
let seq = 0;

const TYPE_FN = {
  success: toast.success,
  error: toast.error,
  info: toast.info,
  warning: toast.warning,
  loading: toast.loading,
};

function resolveDuration(type, duration) {
  if (duration !== undefined) return duration === 0 ? Infinity : duration;
  if (type === "loading") return Infinity;
  if (type === "error") return ERROR_DURATION;
  return DEFAULT_DURATION;
}

function buildAction(action, id) {
  if (!action) return undefined;
  return {
    label: action.label,
    // 先关闭当前通知再执行，避免重试失败时新错误被随后的 dismiss 一并清掉。
    onClick: () => {
      if (action.dismiss !== false) dismiss(id);
      Promise.resolve()
        .then(() => action.handler?.())
        .catch((error) => notifyError(error));
    },
  };
}

function emit(item) {
  const { id, type = "info", title, message, duration, action } = item;
  const text = title || message || "";
  const description = title ? message : undefined;
  const options = {
    id,
    description,
    duration: resolveDuration(type, duration),
    action: buildAction(action, id),
  };
  const fn = TYPE_FN[type] || toast;
  fn(text, options);
}

/** @param {string} id */
export function dismiss(id) {
  registry.delete(id);
  toast.dismiss(id);
}

/**
 * 更新一条通知（如把 loading 变成 success/error），同 id 原地更新。
 * @param {string} id
 * @param {Record<string, unknown>} patch
 */
export function update(id, patch) {
  const item = registry.get(id);
  if (!item) return null;
  // 类型变化时清掉旧的 duration，让新类型套用默认时长（loading → success）。
  if ("type" in patch && patch.duration === undefined) item.duration = undefined;
  Object.assign(item, patch);
  emit(item);
  return item;
}

/**
 * @param {{ type?: string, title?: string, message?: string, duration?: number,
 *   action?: { label: string, handler: () => unknown, dismiss?: boolean } | null,
 *   key?: string, id?: string }} [options]
 * @returns {string} 通知 id
 */
export function notify(options = {}) {
  const id = options.id || options.key || `toast-${++seq}`;
  const item = {
    type: "info",
    title: "",
    message: "",
    duration: undefined,
    action: null,
    ...options,
    id,
  };
  registry.set(id, item);
  emit(item);
  return id;
}

notify.success = (message, options = {}) => notify({ ...options, type: "success", message });
notify.error = (message, options = {}) => notify({ ...options, type: "error", message });
notify.info = (message, options = {}) => notify({ ...options, type: "info", message });
notify.loading = (message, options = {}) => notify({ ...options, type: "loading", message });
notify.dismiss = dismiss;
notify.update = update;

/**
 * 直接展示 unknown error 的可读文案。
 * @param {unknown} error
 * @param {Record<string, unknown>} [options]
 */
export function notifyError(error, options = {}) {
  return notify.error(readableError(error), options);
}

export function useNotifications() {
  return { toast, notify, dismiss, update };
}
