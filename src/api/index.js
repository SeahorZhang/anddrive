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
} = window.electronAPI.adb;

const { startScrcpy, platform } = window.electronAPI;

const {
  getStatus: getPermissionStatus,
  request: requestPermission,
  openSettings: openPermissionSettings,
} = window.electronAPI.permissions;

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

// 通过 scrcpy 启动应用镜像窗口
export const startScrcpyApi = (options) => startScrcpy(options);

// 读取 macOS 系统权限状态
export const getPermissionStatusApi = () => getPermissionStatus();

// 触发 macOS 系统授权流程
export const requestPermissionApi = (id) => requestPermission(id);

// 打开系统设置中对应的隐私面板
export const openPermissionSettingsApi = (id) => openPermissionSettings(id);
