/**
 * Unified IPC contract. Channel strings live only here, in electron/preload.js
 * and in the electron/main.js handler map.
 *
 * Invoke errors cross the bridge as `Error` instances whose `message` is a
 * user-displayable string produced by the main-process handlers.
 */
export const CHANNELS = {
  /** 连接、发现与设备状态（electron/adb.js）。 */
  adbConnect: 'adb:connect',
  adbFindDevice: 'adb:findDevice',
  adbResolveConnectAddress: 'adb:resolveConnectAddress',
  adbListConnectDevices: 'adb:listConnectDevices',
  adbGetConnectedDevice: 'adb:getConnectedDevice',
  adbGetDeviceState: 'adb:getDeviceState',
  adbInstallHelper: 'adb:installHelper',
  adbUninstallHelper: 'adb:uninstallHelper',
  adbLoadInstalledApps: 'adb:loadInstalledApps',
  adbGetAppIcons: 'adb:getAppIcons',
  adbPair: 'adb:pair',
  adbDisconnect: 'adb:disconnect',
  /** 只释放设备资源（存储 / 连接池 / 缓存），保留 ADB transport，供切换设备用；带 `keepMirror` 时镜像不动。 */
  adbReleaseDevice: 'adb:releaseDevice',
  adbDeleteAppCache: 'adb:deleteAppCache',
  adbGetCachedApps: 'adb:getCachedApps',

  /** 应用操作（electron/adb.js）。 */
  adbForceStop: 'adb:forceStop',
  adbClearData: 'adb:clearData',
  adbUninstallApp: 'adb:uninstallApp',
  adbAppInfo: 'adb:getAppInfo',
  adbExportApk: 'adb:exportApk',

  /** 设备信息面板（electron/adb.js）。 */
  adbGetDeviceStats: 'adb:getDeviceStats',
  /** 设备存储按卷列表（electron/storage.js）。 */
  adbStorageVolumes: 'adb:storageVolumes',
  /** 把某个卷挂到本机 / 取消挂载 / 在访达里打开（electron/storage.js）。 */
  adbStorageMount: 'adb:storageMount',
  adbStorageUnmount: 'adb:storageUnmount',
  adbStorageReveal: 'adb:storageReveal',
  /** 设备侧能编码哪些视频（设置页标记 + 会话落地 `auto`）。 */
  adbVideoCodecs: 'adb:videoCodecs',

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
  /** 镜像 → 设备：目标应用当前在哪个 root task / 哪块显示上。 */
  mirrorAppTask: 'mirror:appTask',
  /** 镜像 → 设备：把应用的任务搬到本窗口的虚拟显示上（不重启应用）。 */
  mirrorMoveTask: 'mirror:moveTask',
  /**
   * 镜像窗口 → 主进程：长条那颗「桌面模式」——把手机主屏上**正在用的应用**抽到一块新的虚拟屏窗口里
   * （与首页点应用同一条路，包名由主进程现问设备）。只有整机镜像 + Android 14+ 才有这个入口。
   */
  mirrorDesktopMode: 'mirror:desktopMode',
  /** 设备电源两条读数：`mWakefulness`（睡没睡，「已休眠」看它）+ SF 的 `powerMode`（面板亮没亮，「关屏使用」那颗看它）。 */
  mirrorPowerState: 'mirror:powerState',
  /** 镜像 → 设备：点亮屏幕（用户点「继续使用」；只唤醒不解密码锁）。 */
  mirrorWake: 'mirror:wake',
  /** 主进程 → 镜像窗口：进/出 macOS 全屏（那一屏里长条不再占窗口宽度、红绿灯归系统藏，页面要换排法）。 */
  mirrorWindowButtons: 'mirror:windowButtons',
  mirrorFullscreen: 'mirror:fullscreen',
  /** 镜像窗口 → 主进程：淡入/收起边框时一起开关红绿灯（透明窗口里浮着的圆点会破坏「就是个手机」的样子）。 */
  /** 镜像窗口 → 主进程：dev 调试边栏要占多少宽（0 = 收起）。主进程把窗口撑宽同样的量，画面那块才不被挤小。 */
  mirrorWindowHud: 'mirror:windowHud',
  /**
   * 镜像窗口 → 主进程：右侧那条操作栏现在**浮在画面里没有**（画面够宽时它不再占窗口右边那一格）。
   * 形态一变，不参与比例的余量就差一条长条宽 ⇒ 主进程要按新余量重设一次拖拽比例锁。
   */
  mirrorRailFloat: 'mirror:railFloat',
  /**
   * 主进程 → 镜像窗口：**这台设备的音频会话改由你承载**（原来那条窗口关掉了）。
   * 音频是设备级的（只有一条 `REMOTE_SUBMIX`），同一台设备同时只能有一条采集 ⇒
   * 「谁带音频」由主进程按「该设备最早的窗口」选举，窗口关掉时把这一位交出去。
   */
  mirrorAudioHost: 'mirror:audioHost',
  /**
   * 镜像窗口 → 主进程：**现在设备侧那条 `REMOTE_SUBMIX` 采集放开了吗**（起新的音频会话前问一句）。
   * Android 只有一条采集、且释放要 ~1.3s，不等它拆干净就起来会让新那条从此静音 ——
   * 实测读数与机制见 `electron/mirror/session.js` 的 `waitAudioCaptureReleased`。
   */
  mirrorAudioIdle: 'mirror:audioIdle',
  /** 镜像窗口 → 主进程：长条那颗「使用 Mac 键盘」。`on` 抢过设备输入法、`off` 还原、`state` 只问当前归属。 */
  mirrorMacKeyboard: 'mirror:macKeyboard',
  /** 主进程 → 镜像窗口：Mac 键盘的输入法归属 `{ state, token, socket }`（state: `active` / `switched_away` / `unavailable` / `parked` / `off`）。 */
  mirrorMacKeyboardState: 'mirror:macKeyboardState',
  /** 镜像窗口 → 主进程：设备侧胶囊上的 × 被按了（桥收到 `yield`），让出输入法。 */
  mirrorMacKeyboardYield: 'mirror:macKeyboardYield',

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
