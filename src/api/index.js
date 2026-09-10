const {
  connect,
  findDevice,
  pair,
  disconnect,
  resolveConnectAddress,
  installHelpera,
  loadInstalledApps,
  getAppIcons,
  uninstallHelper,
  deleteAppCache,
} = window.electronAPI.adb

const { startScrcpy, onUpdateStatus, getUpdateStatus, installUpdate, getUpdateNotes } =
  window.electronAPI

export const connectApi = (address) => connect(address)

// 开始发现设备
export const findDeviceApi = () => findDevice()

// 开始配对设备
export const pairApi = (device, password) => pair(device, password)

// 断开设备
export const disconnectApi = (serial) => disconnect(serial)

// 解析设备当前可用的连接地址（配对端口不能用于 adb connect）
export const resolveConnectAddressApi = (serial) => resolveConnectAddress(serial)

// 安装app
export const installHelperApi = (address) => installHelpera(address)

// 获取手机app列表，无图标
export const loadInstalledAppsApi = (address) => loadInstalledApps(address)

// 批量获取应用图标（每批最多 20 个包名）
export const getAppIconsApi = (address, packages) => getAppIcons(address, packages)

// 卸载 Helper
export const uninstallHelperApi = (address) => uninstallHelper(address)

// 清除应用列表缓存
export const deleteAppCacheApi = (address) => deleteAppCache(address)

// 通过 scrcpy 启动应用镜像窗口
export const startScrcpyApi = (options) => startScrcpy(options)

// 订阅自动更新状态（主进程推送）
export const onUpdateStatusApi = (handler) => onUpdateStatus(handler)

// 读取当前自动更新状态
export const getUpdateStatusApi = () => getUpdateStatus()

// 保存更新内容并重启安装
export const installUpdateApi = () => installUpdate()

// 读取（并消费）上次重启后待展示的更新内容
export const getUpdateNotesApi = () => getUpdateNotes()
