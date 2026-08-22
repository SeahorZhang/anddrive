import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipcContract.js'

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

// 事件订阅统一封装：返回取消订阅函数
const subscribe = (channel, callback) => {
  const handler = (_, data) => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  startScrcpy: (options) => invoke(IPC.startScrcpy, options),
  adb: {
    // 配对编排：一次调用完成 配对→连接→按需安装 Helper，进度经 onPairingEvent 即时推送
    pairDevice: (host, port, code) => invoke(IPC.pairDevice, host, port, code),
    onPairingEvent: (callback) => subscribe(IPC.pairingEvent, callback),
    startDiscovery: () => invoke(IPC.startDiscovery),
    stopDiscovery: () => invoke(IPC.stopDiscovery),
    onDiscoveredTarget: (callback) => subscribe(IPC.discoveredTargetEvent, callback),
    // adb track-devices 变更即推，无轮询
    onDevicesChanged: (callback) => subscribe(IPC.devicesChangedEvent, callback),
    getDevices: () => invoke(IPC.getDevices),
    disconnect: (serial) => invoke(IPC.disconnect, serial),
    getDeviceInfo: (serial) => invoke(IPC.getDeviceInfo, serial),
    getCachedInstalledApps: (serial) => invoke(IPC.getCachedInstalledApps, serial),
    loadInstalledApps: (serial, loadId) => invoke(IPC.loadInstalledApps, serial, loadId),
    cancelInstalledAppsLoad: (loadId) => invoke(IPC.cancelInstalledAppsLoad, loadId),
    onInstalledApp: (callback) => subscribe(IPC.installedAppEvent, callback),
  },
})
