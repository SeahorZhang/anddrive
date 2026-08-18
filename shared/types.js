/**
 * @typedef {object} DeviceInfo
 * @property {string} serial
 * @property {string} model
 * @property {string} deviceName
 * @property {number} battery
 * @property {boolean} isCharging
 * @property {string} storage
 * @property {number} storagePercent
 */

/**
 * @typedef {object} AdbDevice
 * @property {string} serial
 * @property {string} state
 */

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
 * @typedef {object} HelperCapabilities
 * @property {boolean=} ok
 * @property {number=} protocol
 * @property {boolean=} batchIcons
 */

/**
 * @typedef {'authoritative' | 'icons' | 'complete' | 'error'} AppLoadPhase
 */

/**
 * @typedef {object} AppLoadEvent
 * @property {number} loadId
 * @property {AppLoadPhase} phase
 * @property {InstalledApp[]=} apps
 * @property {string=} message
 */

/**
 * @typedef {object} ScrcpyRequest
 * @property {string[]} args
 * @property {string} packageName
 * @property {string} iconDataUrl
 */

export {}
