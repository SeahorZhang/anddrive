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
  adbGetCachedApps: 'adb:getCachedApps',
  adbUninstallHelper: 'adb:uninstallHelper',
  adbGetAppIcons: 'adb:getAppIcons',

  /** 应用操作（electron/adb.js）。 */
  adbForceStop: 'adb:forceStop',
  adbClearData: 'adb:clearData',
  adbUninstallApp: 'adb:uninstallApp',
  adbAppInfo: 'adb:getAppInfo',
  adbExportApk: 'adb:exportApk',

  /** 设备信息面板（electron/adb.js）。 */
  adbGetDeviceStats: 'adb:getDeviceStats',

  /** 自研镜像客户端（electron/mirror/session.js）。 */
  mirrorStart: 'mirror:start',
  mirrorList: 'mirror:list',
  mirrorStop: 'mirror:stop',
  mirrorStopAll: 'mirror:stopAll',
  mirrorFocus: 'mirror:focus',

  /** 镜像窗口启动参数（渲染层主动 invoke 拉取，避免时序竞态）。 */
  mirrorInitGet: 'mirror:initGet',
  /** 镜像会话意外结束（主进程 → 主窗口）。 */
  mirrorExit: 'mirror:exit',
  /** 镜像渲染层 → 主进程的状态上报（ready / exit）。 */
  mirrorState: 'mirror:state',
  /** 大屏（pad）模式：enter / settle / exit，见 `electron/mirror/padMode.js`。 */
  mirrorPadMode: 'mirror:padMode',

  /** macOS 系统权限（electron/permissions.js）。 */
  permissionsStatus: 'permissions:getStatus',
  permissionsRequest: 'permissions:request',
  permissionsOpenSettings: 'permissions:openSettings',

  /** 应用收藏（electron/favorites.js）。 */
  favoritesGet: 'favorites:get',
  favoritesToggle: 'favorites:toggle',

  /** scrcpy 全局默认参数（electron/scrcpyConfig.js，持久化在主进程）。 */
  scrcpyConfigGet: 'scrcpyConfig:get',
  scrcpyConfigSet: 'scrcpyConfig:set',

  /** 桌面投屏快捷方式（electron/shortcut.js）。 */
  shortcutCreate: 'shortcut:create',
  shortcutReveal: 'shortcut:reveal',

  /** 快捷方式唤起投屏的结果（主进程 → 渲染层）。 */
  mirrorResult: 'mirror:result',
}
