export const CACHE_VERSION = 2
export const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024

const MAX_APPS = 5000
const MAX_ICON_BYTES = 512 * 1024
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

/** @param {unknown} value */
function validTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** @param {unknown} iconUrl */
export function sanitizeIcon(iconUrl) {
  if (iconUrl == null) return null
  if (typeof iconUrl !== 'string' || !iconUrl.startsWith(PNG_DATA_URL_PREFIX)) return null
  const encoded = iconUrl.slice(PNG_DATA_URL_PREFIX.length)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null
  if (Buffer.byteLength(encoded, 'base64') > MAX_ICON_BYTES) return null
  return iconUrl
}

/** @param {unknown} value */
export function sanitizeApp(value) {
  if (!value || typeof value !== 'object') return null
  const app = /** @type {Record<string, unknown>} */ (value)
  if (typeof app.packageName !== 'string' || !app.packageName || app.packageName.length > 512) {
    return null
  }
  const label =
    typeof app.label === 'string' && app.label ? app.label.slice(0, 1024) : app.packageName
  const iconUrl = sanitizeIcon(app.iconUrl)
  const iconUpdatedAt =
    iconUrl && validTimestamp(app.iconUpdatedAt) ? /** @type {number} */ (app.iconUpdatedAt) : null
  return { packageName: app.packageName, label, iconUrl, iconUpdatedAt }
}

/**
 * @param {unknown} value
 * @param {{ allowExpired?: boolean, now?: number }=} options
 * @returns {import('../../shared/types.js').AppCacheSnapshot | null}
 */
export function sanitizeSnapshot(value, { allowExpired = false, now = Date.now() } = {}) {
  if (!value || typeof value !== 'object') return null
  const snapshot = /** @type {Record<string, unknown>} */ (value)
  if (snapshot.version !== CACHE_VERSION || !Array.isArray(snapshot.apps)) return null
  if (!validTimestamp(snapshot.authoritativeAt) || !validTimestamp(snapshot.writtenAt)) return null
  if (!allowExpired && now - /** @type {number} */ (snapshot.writtenAt) > CACHE_MAX_AGE_MS) {
    return null
  }
  if (snapshot.apps.length > MAX_APPS) return null

  const seen = new Set()
  const apps = []
  for (const valueApp of snapshot.apps) {
    const cachedApp = sanitizeApp(valueApp)
    if (!cachedApp || seen.has(cachedApp.packageName)) return null
    seen.add(cachedApp.packageName)
    apps.push(cachedApp)
  }
  return {
    version: CACHE_VERSION,
    authoritativeAt: /** @type {number} */ (snapshot.authoritativeAt),
    writtenAt: /** @type {number} */ (snapshot.writtenAt),
    apps,
  }
}

/**
 * @param {import('../../shared/types.js').AppCacheSnapshotInput} snapshot
 * @returns {string | null}
 */
export function serializeSnapshot(snapshot) {
  const sanitized = sanitizeSnapshot(
    { ...snapshot, version: CACHE_VERSION },
    { allowExpired: true },
  )
  if (!sanitized) return null

  let data = JSON.stringify(sanitized)
  if (Buffer.byteLength(data) <= MAX_SNAPSHOT_BYTES) return data
  for (const cachedApp of sanitized.apps) {
    cachedApp.iconUrl = null
    cachedApp.iconUpdatedAt = null
  }
  data = JSON.stringify(sanitized)
  return Buffer.byteLength(data) <= MAX_SNAPSHOT_BYTES ? data : null
}
