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

/** 看起来像 adb 传输地址（而不是稳定序列号）的持久化键。 */
export function isAddressLikeKey(key) {
  const value = String(key ?? "");
  if (!value) return false;
  // ip:port 或 hostname:port
  if (/^[^\s/]+:\d+$/.test(value)) return true;
  // mDNS 服务实例名，例如 adb-af3d7abd-Zvci5V._adb-tls-connect._tcp
  if (value.endsWith("._adb-tls-connect._tcp") || value.includes("._adb-")) return true;
  // USB 直连时 adb 也会用设备名形式；带连字符 + 随机尾缀的一律当地址看
  return /^adb-[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(value);
}

/**
 * 把旧的「按传输地址存」的桶并进稳定键。收藏只是界面置顶/分组，多并几条不认识的包名
 * 不会有害（应用列表里查不到的项目不显示），而漏并就等于用户数据丢了 —— 所以这里
 * 采取「并入所有地址形桶」的宽松策略，调用方负责先备份原文件。
 *
 * @param {Record<string, string[]>} store
 * @param {string} stableKey
 * @returns {{ store: Record<string, string[]>, mergedCount: number }}
 */
export function collapseAddressKeys(store, stableKey) {
  const result = {};
  const merged = new Set(store[stableKey] ?? []);
  let mergedCount = 0;
  for (const [key, list] of Object.entries(store)) {
    if (key === stableKey) continue;
    if (!isAddressLikeKey(key)) {
      result[key] = list;
      continue;
    }
    for (const pkg of list) {
      if (!merged.has(pkg)) {
        merged.add(pkg);
        mergedCount += 1;
      }
    }
  }
  if (merged.size) result[stableKey] = [...merged];
  return { store: result, mergedCount };
}
