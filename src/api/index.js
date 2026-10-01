// 主进程 API 的名字登记表：调用点用的都是 `xxxApi` 名字，这里直接绑 preload
// 暴露的函数本身，不再包一层箭头壳。改 IPC 通道先看 electron/preload.js。
const { platform, adb, mirror, permissions, favorites, scrcpyConfig, shortcuts } =
  window.electronAPI;

export const isMac = platform === 'darwin';

export const connectApi = adb.connect;

export const findDeviceApi = adb.findDevice;

export const pairApi = adb.pair;

export const disconnectApi = adb.disconnect;

// 释放设备资源但不断开 transport：切换设备时让上一台收摊，随时可以切回去
export const releaseDeviceApi = adb.releaseDevice;

// 配对端口不能用于 adb connect，要解析设备当前可用的连接地址
export const resolveConnectAddressApi = adb.resolveConnectAddress;

export const listConnectDevicesApi = adb.listConnectDevices;

// 已被其他工具连接的设备，供启动时接管
export const getConnectedDeviceApi = adb.getConnectedDevice;

export const getDeviceStateApi = adb.getDeviceState;

// 设备在线时幂等返回，否则解析 mDNS 地址后重连
export const reconnectApi = adb.reconnect;

export const installHelperApi = adb.installHelper;

export const loadInstalledAppsApi = adb.loadInstalledApps;

export const getCachedAppsApi = adb.getCachedApps;

// 批量获取应用图标（每批最多 20 个包名）
export const getAppIconsApi = adb.getAppIcons;

export const uninstallHelperApi = adb.uninstallHelper;

export const deleteAppCacheApi = adb.deleteAppCache;

export const forceStopAppApi = adb.forceStopApp;
export const clearAppDataApi = adb.clearAppData;
export const uninstallAppApi = adb.uninstallApp;

export const getAppInfoApi = adb.getAppInfo;

export const exportApkApi = adb.exportApk;

export const getDeviceStatsApi = adb.getDeviceStats;

export const getStorageVolumesApi = adb.getStorageVolumes;

export const mountStorageApi = adb.mountStorage;
export const unmountStorageApi = adb.unmountStorage;
export const revealStorageApi = adb.revealStorage;

// 设备侧能编码哪些（h264/h265/av1），设置页标记与 `auto` 落地都用它
export const getVideoCodecsApi = adb.getVideoCodecs;

export const startMirrorApi = mirror.start;

export const listMirrorApi = mirror.list;

export const stopMirrorApi = mirror.stop;

export const stopAllMirrorApi = mirror.stopAll;

export const focusMirrorApi = mirror.focus;

// 订阅镜像意外结束事件，返回取消订阅函数
export const onMirrorExitApi = mirror.onExit;

export const getPermissionStatusApi = permissions.getStatus;

export const requestPermissionApi = permissions.request;

export const openPermissionSettingsApi = permissions.openSettings;

export const getFavoritesApi = favorites.get;

export const toggleFavoriteApi = favorites.toggle;

export const getScrcpyConfigApi = scrcpyConfig.get;

export const setScrcpyConfigApi = scrcpyConfig.set;

// 在桌面创建 `.adr` 投屏快捷方式
export const createAppShortcutApi = shortcuts.create;

export const revealShortcutApi = shortcuts.reveal;

// 订阅快捷方式唤起投屏的结果，返回取消订阅函数
export const onMirrorResultApi = shortcuts.onMirrorResult;
