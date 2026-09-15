const {
  connect,
  findDevice,
  pair,
  disconnect,
  resolveConnectAddress,
  listConnectDevices,
  getConnectedDevice,
  getDeviceState,
  reconnect,
  installHelpera,
  loadInstalledApps,
  getCachedApps,
  getAppIcons,
  uninstallHelper,
  deleteAppCache,
  forceStopApp,
  clearAppData,
  uninstallApp,
  getAppInfo,
  exportApk,
  getDeviceStats,
} = window.electronAPI.adb;

const { startScrcpy, platform } = window.electronAPI;

const {
  start: startMirror,
  list: listMirror,
  stop: stopMirror,
  stopAll: stopAllMirror,
  focus: focusMirror,
  onExit: onMirrorExit,
} = window.electronAPI.mirror;

const { list: listScrcpy, focus: focusScrcpy, stop: stopScrcpy, stopAll: stopAllScrcpy } =
  window.electronAPI.scrcpy;

const {
  getStatus: getPermissionStatus,
  request: requestPermission,
  openSettings: openPermissionSettings,
} = window.electronAPI.permissions;

const { get: getFavorites, toggle: toggleFavorite } = window.electronAPI.favorites;

const { get: getScrcpyConfig, set: setScrcpyConfig } = window.electronAPI.scrcpyConfig;

const {
  create: createShortcut,
  reveal: revealShortcut,
  onMirrorResult,
} = window.electronAPI.shortcuts;

export const isMac = platform === 'darwin';

export const connectApi = (address) => connect(address);

// 开始发现设备
export const findDeviceApi = () => findDevice();

// 开始配对设备
export const pairApi = (device, password) => pair(device, password);

// 断开设备
export const disconnectApi = (serial) => disconnect(serial);

// 解析设备当前可用的连接地址（配对端口不能用于 adb connect）
export const resolveConnectAddressApi = (serial) => resolveConnectAddress(serial);

// 一次性列出当前可连接的设备（供持续发现轮询）
export const listConnectDevicesApi = () => listConnectDevices();

// 当前已连接（其他工具建立）的设备，供启动时接管
export const getConnectedDeviceApi = () => getConnectedDevice();

// 读取单台设备的实时状态：device / offline / unauthorized / absent
export const getDeviceStateApi = (serial) => getDeviceState(serial);

// 断线重连：设备在线幂等返回，否则解析 mDNS 地址后重新连接
export const reconnectApi = (serial) => reconnect(serial);

// 安装app
export const installHelperApi = (address) => installHelpera(address);

// 获取手机app列表，无图标
export const loadInstalledAppsApi = (address) => loadInstalledApps(address);

// 读取应用列表缓存，用于秒开
export const getCachedAppsApi = (address) => getCachedApps(address);

// 批量获取应用图标（每批最多 20 个包名）
export const getAppIconsApi = (address, packages) => getAppIcons(address, packages);

// 卸载 Helper
export const uninstallHelperApi = (address) => uninstallHelper(address);

// 清除应用列表缓存
export const deleteAppCacheApi = (address) => deleteAppCache(address);

// 应用操作：强制停止 / 清除数据 / 卸载
export const forceStopAppApi = (serial, packageName) => forceStopApp(serial, packageName);
export const clearAppDataApi = (serial, packageName) => clearAppData(serial, packageName);
export const uninstallAppApi = (serial, packageName) => uninstallApp(serial, packageName);

// 读取应用信息（版本 / SDK / 安装时间 / APK 路径）
export const getAppInfoApi = (serial, packageName) => getAppInfo(serial, packageName);

// 导出应用 APK 到用户选择的目录
export const exportApkApi = (serial, packageName) => exportApk(serial, packageName);

// 读取设备信息（型号 / 系统 / 存储 / 电量 / 网络 / CPU / 内存），force 跳过缓存
export const getDeviceStatsApi = (serial, force = false) => getDeviceStats(serial, force);

// 通过 scrcpy 启动应用镜像窗口
export const startScrcpyApi = (options) => startScrcpy(options);

// 通过自研客户端启动原生镜像窗口（实验）
export const startMirrorApi = (options) => startMirror(options);

// 运行中的原生镜像会话
export const listMirrorApi = () => listMirror();

// 关闭指定原生镜像窗口
export const stopMirrorApi = (id) => stopMirror(id);

// 关闭全部原生镜像窗口
export const stopAllMirrorApi = () => stopAllMirror();

// 聚焦指定原生镜像窗口
export const focusMirrorApi = (id) => focusMirror(id);

// 订阅原生镜像意外结束事件，返回取消订阅函数
export const onMirrorExitApi = (callback) => onMirrorExit(callback);

// 运行中的镜像会话列表
export const listScrcpyApi = () => listScrcpy();

// 聚焦指定镜像窗口
export const focusScrcpyApi = (id) => focusScrcpy(id);

// 关闭指定镜像窗口
export const stopScrcpyApi = (id) => stopScrcpy(id);

// 关闭全部镜像窗口，返回关闭数量
export const stopAllScrcpyApi = () => stopAllScrcpy();

// 读取 macOS 系统权限状态
export const getPermissionStatusApi = () => getPermissionStatus();

// 触发 macOS 系统授权流程
export const requestPermissionApi = (id) => requestPermission(id);

// 打开系统设置中对应的隐私面板
export const openPermissionSettingsApi = (id) => openPermissionSettings(id);

// 读取某台设备的收藏包名列表（跨重启保留）
export const getFavoritesApi = (serial) => getFavorites(serial);

// 切换收藏状态，返回更新后的收藏列表
export const toggleFavoriteApi = (serial, packageName) => toggleFavorite(serial, packageName);

// 在桌面创建 `.adr` 投屏快捷方式
export const createAppShortcutApi = (payload) => createShortcut(payload);

// 在访达中定位快捷方式
export const revealShortcutApi = (filePath) => revealShortcut(filePath);

// 订阅快捷方式唤起投屏的结果，返回取消订阅函数
export const onMirrorResultApi = (callback) => onMirrorResult(callback);

// 读取 scrcpy 全局默认参数（主进程持久化），返回 { config, stored }
export const getScrcpyConfigApi = () => getScrcpyConfig();

// 保存 scrcpy 全局默认参数，返回归一化后的结果
export const setScrcpyConfigApi = (config) => setScrcpyConfig(config);
