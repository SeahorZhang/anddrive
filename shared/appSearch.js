// 应用列表的搜索匹配（纯函数，主/渲染层都能用）。

/**
 * 汉字表有 280KB，所以**不在模块顶层 import**：只有用户真的开始敲字母时才动态加载。
 * 加载完成前 `pinyinInitials` 返回空串 —— 名字与包名两条路照常工作，不会因为多等一次
 * 网络/磁盘而搜不到东西。
 */
let pinyin = null;
let pending = null;

/** 加载拼音表；重复调用共用同一次加载。 */
export function ensurePinyin() {
  pending ??= import("pinyin-pro").then((mod) => {
    pinyin = mod.pinyin;
  });
  return pending;
}

/** 拼音表是否已经就位（调用方用它建立响应式依赖，加载完成后重算列表）。 */
export function pinyinReady() {
  return pinyin !== null;
}

const initialsCache = new Map();

/**
 * 「抖音」→ `dy`、「重庆」→ `cq`（多音字按词判，这是选 pinyin-pro 而不是 ICU 排序区间的唯一理由）；
 * 非汉字原样保留（`QQ浏览器` → `qqllq`）。表没加载完时返回空串。
 */
export function pinyinInitials(text) {
  const raw = String(text ?? "");
  if (!pinyin) return "";
  const cached = initialsCache.get(raw);
  if (cached !== undefined) return cached;
  const out = pinyin(raw, {
    pattern: "first",
    type: "array",
    toneType: "none",
    nonZh: "consecutive",
  }).join("").toLowerCase();
  // 应用名数量有限；到顶就整表丢，不让它无上限长。
  if (initialsCache.size > 2000) initialsCache.clear();
  initialsCache.set(raw, out);
  return out;
}

/**
 * 搜索词已经过 trim + 小写；空串表示不过滤。
 * 命中任一即算：名字、包名（`set` 能找到 `com.android.settings`）、名字的拼音首字母（`dy` 能找到「抖音」）。
 * @param {{label?: string, packageName?: string}} app @param {string} query
 */
export function matchesAppQuery(app, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const label = String(app?.label ?? "");
  return (
    label.toLowerCase().includes(q) ||
    String(app?.packageName ?? "").toLowerCase().includes(q) ||
    pinyinInitials(label).includes(q)
  );
}
