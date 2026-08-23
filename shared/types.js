/**
 * @typedef {object} DeviceInfo
 * @property {string} serial
 * @property {string} model
 * @property {string} deviceName
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
 * @property {string=} code machine-readable error kind, e.g. 'helper-setup'
 * @property {string=} message
 */

/**
 * Domain payload the renderer submits to launch an app via scrcpy.
 * CLI arguments are constructed in the main process (electron/scrcpyRequest.js).
 * @typedef {object} ScrcpyRequest
 * @property {string} serial
 * @property {string} packageName
 * @property {string} label
 * @property {string} iconDataUrl
 */

export {}
