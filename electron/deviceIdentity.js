// ---------------------------------------------------------------------------
// 稳定设备标识
//
// 问题：adb 的「传输地址」不稳定。同一台手机无线重连一次就换一个端口
// （实测 `192.168.100.91:41185` → `:41335` → `:41759`），走 mDNS 时还会变成
// `adb-af3d7abd-XXXX._adb-tls-connect._tcp` 这种形式。凡是拿传输地址当持久化键的
// 东西（收藏、应用/图标缓存）每次重连都变成孤儿数据 —— 用户看到的就是「收藏记不住设备」。
//
// 解法：用设备自身的稳定序列号 `ro.serialno`（实测 `af3d7abd`，mDNS 服务名里嵌的也正是它），
// 拿不到再退 `ro.boot.serialno` → `settings secure android_id` → 传输地址（至少不比原来差）。
// ---------------------------------------------------------------------------

/** 稳定序列号不接受的取值：空、adb 在 Android 12+ 常给的占位值。 */
const INVALID_IDS = new Set(["", "unknown", "null", "0"]);

/**
 * 从若干候选值里挑第一个能用的（调用方按优先级传）。
 * @param {string[]} candidates
 * @param {string} fallback 全不可用时回退到传输地址
 * @returns {string}
 */
export function pickStableId(candidates, fallback) {
  for (const raw of candidates ?? []) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value && !INVALID_IDS.has(value.toLowerCase())) return value;
  }
  return String(fallback ?? "").trim();
}
