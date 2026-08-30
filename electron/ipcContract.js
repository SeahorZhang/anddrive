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
}
