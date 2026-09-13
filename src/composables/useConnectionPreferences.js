import { ref } from "vue";

/**
 * 连接相关偏好（模块级单例，设置页与连接流程共用）。
 * 持久化在 P0-4 统一处理，这里先提供会话内开关。
 */

/** 连接中断后是否自动尝试重连。默认开启。 */
export const autoReconnect = ref(true);

export function useConnectionPreferences() {
  return { autoReconnect };
}
