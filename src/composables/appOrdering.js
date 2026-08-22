/**
 * Build the display list for the app grid: apps referenced by `mruPackages`
 * come first in recency order, remaining apps follow in their original order.
 * Duplicate package names keep the last entry.
 *
 * Replaces the previously duplicated reordering logic of replaceApps and
 * promoteApp.
 *
 * @param {{ packageName?: string }[] | null | undefined} apps
 * @param {string[] | null | undefined} mruPackages
 * @returns {{ packageName: string }[]}
 */
export function orderApps(apps, mruPackages) {
  const byPackage = new Map()
  for (const app of apps || []) {
    if (app?.packageName) byPackage.set(app.packageName, app)
  }

  const ordered = []
  const seen = new Set()
  for (const pkg of mruPackages || []) {
    const app = byPackage.get(pkg)
    if (app && !seen.has(pkg)) {
      ordered.push(app)
      seen.add(pkg)
    }
  }
  for (const [pkg, app] of byPackage) {
    if (!seen.has(pkg)) ordered.push(app)
  }
  return ordered
}

/**
 * Drop recency entries whose app no longer exists.
 * @param {string[] | null | undefined} mruPackages
 * @param {{ packageName?: string }[] | null | undefined} apps
 * @returns {string[]}
 */
export function pruneMru(mruPackages, apps) {
  const known = new Set(
    (apps || []).filter((app) => app?.packageName).map((app) => app.packageName),
  )
  return (mruPackages || []).filter((pkg) => known.has(pkg))
}
