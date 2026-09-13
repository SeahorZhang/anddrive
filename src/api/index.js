const {
  connect,
  findDevice,
  pair,
  disconnect,
  resolveConnectAddress,
  listConnectDevices,
  getConnectedDevice,
  installHelpera,
  loadInstalledApps,
  getCachedApps,
  getAppIcons,
  uninstallHelper,
  deleteAppCache,
} = window.electronAPI.adb;

const { startScrcpy } = window.electronAPI;

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
