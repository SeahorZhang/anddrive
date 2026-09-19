// ---------------------------------------------------------------------------
// 「这台设备上的这个应用，是不是已经有镜像窗口在播了？」（纯逻辑，便于单测）
//
// 为什么需要：一个会话 = 一块虚拟显示。同一个应用开两个窗口时，后建的那块显示会把
// 应用搬走（真机量过：startApp 之后应用窗口从 138 挪到 139，138 上只剩 MIUI 的
// SecondaryDisplayLauncher），先开的窗口就变成一块没人用的启动器镜像 —— 两个窗口在
// 抢同一条画面。而虚拟显示与创建它的进程绑死（resize / 销毁都只有属主办得到），
// 要让两个窗口看同一块显示就得再养一个常驻持有者，代价太大。
//
// 落点（用户 2026-09-20 选定）：**同一设备 + 同一应用只开一个镜像窗口**，第二次从
// 快捷方式 / anddrive:// 唤起时不再建会话，直接把已有那个窗口唤到前台。
// ---------------------------------------------------------------------------

const SEP = "\u0000";

/** 匹配键：设备 + 包名（标签不同也算同一个应用）。序列号与包名里都不会出现 NUL。 */
export function appSessionKey({ serial, packageName } = {}) {
  return String(serial || "") + SEP + String(packageName || "");
}

/**
 * 找出已经在播这个应用的会话。
 * @template {{ serial: string, packageName: string }} T
 * @param {Iterable<T>} sessions 现有会话（或其快照）
 * @param {{ serial: string, packageName: string }} request
 * @returns {T | null}
 */
export function findAppSession(sessions, request) {
  const key = appSessionKey(request);
  for (const session of sessions) {
    if (appSessionKey(session) === key) return session;
  }
  return null;
}
