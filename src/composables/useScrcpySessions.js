import { ref } from "vue";
import { listMirrorApi } from "@/api";

/**
 * 运行中镜像会话（模块级单例）。
 * 会话由主进程维护，这里定时拉取快照，覆盖用户手动关闭窗口等外部变化。
 */

export const mirrorSessions = ref([]);

const POLL_INTERVAL_MS = 2000;
let timer = null;
let refreshing = false;

/** 拉取一次会话列表；主进程不可用时保留现有列表。 */
export async function refreshScrcpySessions() {
  if (refreshing) return;
  refreshing = true;
  try {
    const mirror = await listMirrorApi();
    mirrorSessions.value = mirror;
  } catch {
    // 忽略：下一次轮询会重试
  } finally {
    refreshing = false;
  }
}

/** 开始轮询（幂等）。 */
export function startScrcpySessionPolling() {
  if (timer) return;
  refreshScrcpySessions();
  timer = setInterval(refreshScrcpySessions, POLL_INTERVAL_MS);
}

/** 停止轮询。 */
export function stopScrcpySessionPolling() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function useScrcpySessions() {
  return { mirrorSessions, refreshScrcpySessions };
}
