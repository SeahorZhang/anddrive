/**
 * @typedef {object} InstalledApp
 * @property {string} packageName
 * @property {string} label
 * @property {string | null} iconUrl
 */

/**
 * @typedef {InstalledApp & { iconUpdatedAt: number | null }} CachedInstalledApp
 */

/**
 * @typedef {object} AppCacheSnapshotInput
 * @property {number} authoritativeAt
 * @property {number} writtenAt
 * @property {CachedInstalledApp[]} apps
 */

/**
 * @typedef {AppCacheSnapshotInput & { version: number }} AppCacheSnapshot
 */

/**
 * Domain payload the renderer submits to launch an app via scrcpy.
 * CLI arguments are constructed in the main process.
 * @typedef {object} ScrcpyRequest
 * @property {string} serial
 * @property {string} packageName
 * @property {string} label
 */

export {}
