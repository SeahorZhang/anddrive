/**
 * Unified IPC contract. Channel strings live only here, in electron/preload.js
 * and in the electron/main.js handler map.
 *
 * Invoke errors cross the bridge as `Error` instances whose `message` is a
 * user-displayable string produced by the main-process handlers.
 */
export const CHANNELS = {
  adbPair: 'adb:pair',
  adbStartDiscovery: 'adb:startDiscovery',
  adbGetDiscoveredDevices: 'adb:getDiscoveredDevices',
  adbStopDiscovery: 'adb:stopDiscovery',
  adbGetActiveSession: 'adb:getActiveSession',
  adbDisconnect: 'adb:disconnect',
  adbGetDeviceInfo: 'adb:getDeviceInfo',
  adbGetCachedInstalledApps: 'adb:getCachedInstalledApps',
  adbDeleteAppCache: 'adb:deleteAppCache',
  adbInstallHelper: 'adb:installHelper',
  adbUninstallHelper: 'adb:uninstallHelper',
  adbLoadInstalledApps: 'adb:loadInstalledApps',
  adbCancelInstalledAppsLoad: 'adb:cancelInstalledAppsLoad',

  /** Main → renderer push channel; payload is an AppLoadEvent (shared/types.js). */
  installedAppEvent: 'adb:installed-app',

  /** Payload is a ScrcpyRequest (shared/types.js). */
  scrcpyStart: 'start_scrcpy',
}
