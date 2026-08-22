/**
 * 唯一 IPC channel 契约。
 * channel 字符串只允许出现在本文件、electron/main.js 与 electron/preload.js；
 * 渲染进程一律通过 src/services/desktopApi.js 访问，不得引用 channel 或 window.electronAPI。
 *
 * payload 类型定义见 shared/types.js：
 * - adb:pairDevice      (host, port, code) → Promise<serial>；编排 配对→连接→按需安装 Helper，
 *                       进度经 adb:pairing-event 即时推送（回调驱动，无轮询）；
 *                       等待上线期间自动清理不可达的僵尸传输
 * - adb:pairing-event   事件 → PairingEvent（phase：pairing/paired/connecting/connected/installing/installed）
 * - adb:restoreDevice   () → Promise<serial | null>；应用启动时主动经 adb mDNS 视图
 *                       重连已配对设备（mDNS 自动连接已被禁用），超时返回 null
 * - adb:startDiscovery  () → boolean；配对服务出现经 adb:discovered-target 推送
 * - adb:discovered-target 事件 → string（pairing 服务地址 "ip:port"，每目标只推一次）
 * - adb:devices-changed 事件 → AdbDevice[]（adb track-devices 变更即推，无轮询）
 * - adb:stopDiscovery   () → boolean
 * - adb:getDevices      () → AdbDevice[]（返回前先探测并清理不可达的无线僵尸传输）
 * - adb:disconnect      (serial) → boolean（已离线视为成功）
 * - adb:getDeviceInfo   (serial) → DeviceInfo
 * - adb:getCachedInstalledApps (serial) → AppCacheSnapshot | null
 * - adb:loadInstalledApps (serial, loadId) → void；进度经 adb:installed-app 事件推送
 * - adb:cancelInstalledAppsLoad (loadId) → boolean
 * - adb:installed-app   事件 → AppLoadEvent（authoritative/icons/complete/error，带 loadId）
 * - scrcpy:start        (ScrcpyLaunchInput) → boolean；CLI args 由 main 侧构建
 */

export const IPC = {
  pairDevice: 'adb:pairDevice',
  restoreDevice: 'adb:restoreDevice',
  pairingEvent: 'adb:pairing-event',
  startDiscovery: 'adb:startDiscovery',
  discoveredTargetEvent: 'adb:discovered-target',
  devicesChangedEvent: 'adb:devices-changed',
  stopDiscovery: 'adb:stopDiscovery',
  getDevices: 'adb:getDevices',
  disconnect: 'adb:disconnect',
  getDeviceInfo: 'adb:getDeviceInfo',
  getCachedInstalledApps: 'adb:getCachedInstalledApps',
  loadInstalledApps: 'adb:loadInstalledApps',
  cancelInstalledAppsLoad: 'adb:cancelInstalledAppsLoad',
  installedAppEvent: 'adb:installed-app',
  startScrcpy: 'scrcpy:start',
}
