/**
 * Unified IPC contract. Channel strings live only here, in electron/preload.js
 * and in the electron/main.js handler map.
 *
 * Invoke errors cross the bridge as `Error` instances whose `message` is a
 * user-displayable string produced by the main-process handlers.
 */
export const CHANNELS = {
  adbPair: 'adb:pair',
  adbDisconnect: 'adb:disconnect',
  adbDeleteAppCache: 'adb:deleteAppCache',
  adbUninstallHelper: 'adb:uninstallHelper',
  adbGetAppIcons: 'adb:getAppIcons',

  /** Payload is a ScrcpyRequest (shared/types.js). */
  scrcpyStart: 'start_scrcpy',

  /** Main → renderer push of the current auto-update status. */
  updateStatus: 'update:status',
  /** Renderer → main: current update status (on mount). */
  updateGetStatus: 'update:getStatus',
  /** Renderer → main: persist release notes and restart to install. */
  updateInstall: 'update:install',
  /** Renderer → main: consume release notes saved before the last restart. */
  updateNotes: 'update:getNotes',
}
