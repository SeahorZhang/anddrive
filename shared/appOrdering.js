/**
 * App 列表重排与 MRU 维护的纯函数。
 * 原 AppList.vue 中 replaceApps（列表替换）与 promoteApp（启动置顶）
 * 各自维护一份等价的 Map 重排逻辑，此处合并为唯一实现：
 * 以 packageName 去重后，MRU 命中的排前面（按 MRU 顺序），其余按到达顺序追加。
 */

/**
 * @typedef {import('./types.js').InstalledApp} InstalledApp
 */

/**
 * 按 MRU 优先排列 apps：以 packageName 去重（后者覆盖前者），
 * MRU 中仍存在的包按 MRU 顺序排在前面，其余按到达顺序追加；
 * 同时返回修剪后的 MRU（剔除已不存在的包并去重），供调用方持久化。
 * 不修改入参，始终返回新数组与新 Map 无关的普通数组。
 *
 * @param {(InstalledApp | null | undefined)[]} apps
 * @param {string[]} mruPackages
 * @returns {{ apps: InstalledApp[], mru: string[] }}
 */
export function orderAppsByMru(apps, mruPackages) {
  const byPackage = new Map()
  for (const app of apps || []) {
    if (app?.packageName) byPackage.set(app.packageName, app)
  }

  const ordered = []
  const keptMru = []
  const seen = new Set()
  for (const pkg of mruPackages || []) {
    if (seen.has(pkg)) continue
    seen.add(pkg)
    const app = byPackage.get(pkg)
    if (!app) continue
    keptMru.push(pkg)
    ordered.push(app)
  }
  for (const [pkg, app] of byPackage) {
    if (!seen.has(pkg)) ordered.push(app)
  }
  return { apps: ordered, mru: keptMru }
}

/**
 * 将 packageName 提升到 MRU 首位（若已存在则去重移动），返回新数组。
 *
 * @param {string[]} mruPackages
 * @param {string} packageName
 * @returns {string[]}
 */
export function promoteToMruFront(mruPackages, packageName) {
  return [packageName, ...(mruPackages || []).filter((pkg) => pkg !== packageName)]
}
