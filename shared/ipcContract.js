/**
 * 唯一 IPC channel 契约。
 * channel 字符串只允许出现在本文件、electron/main.js 与 electron/preload.js；
 * 渲染进程一律通过 src/services/desktopApi.js 访问，不得引用 channel 或 window.electronAPI。
 *
 * payload 类型定义见 shared/types.js：
 * - adb:pair            (host, port, code) → string
 * - adb:startDiscovery  () → boolean（同时浏览 pairing 与 tls-connect 两类服务）
 * - adb:getDiscoveredDevices () → DiscoveryDevice[]（{ name, address }）
 * - adb:getDiscoveredConnectTargets () → string[]（tls-connect 目标 "ip:port"）
 * - adb:connectDevice   (host, port) → string；"already connected" 视为成功
 * - adb:stopDiscovery   () → boolean
 * - adb:getDevices      () → AdbDevice[]
 * - adb:disconnect      (serial) → boolean（已离线视为成功）
 * - adb:getDeviceInfo   (serial) → DeviceInfo
 * - adb:getCachedInstalledApps (serial) → AppCacheSnapshot | null
 * - adb:loadInstalledApps (serial, loadId) → void；进度经 adb:installed-app 事件推送
 * - adb:cancelInstalledAppsLoad (loadId) → boolean
 * - adb:installed-app   事件 → AppLoadEvent（authoritative/icons/complete/error，带 loadId）
 * - scrcpy:start        (ScrcpyLaunchInput) → boolean；CLI args 由 main 侧构建
 */

export const IPC = {
  pair: 'adb:pair',
  startDiscovery: 'adb:startDiscovery',
  getDiscoveredDevices: 'adb:getDiscoveredDevices',
  getDiscoveredConnectTargets: 'adb:getDiscoveredConnectTargets',
  connectDevice: 'adb:connectDevice',
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
