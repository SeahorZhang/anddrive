import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from './ipcContract.js'

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  startScrcpy: (options) => invoke(CHANNELS.scrcpyStart, options),
  adb: {
    pair: (h, p, c) => invoke(CHANNELS.adbPair, h, p, c),
    startDiscovery: () => invoke(CHANNELS.adbStartDiscovery),
    getDiscoveredDevices: () => invoke(CHANNELS.adbGetDiscoveredDevices),
    stopDiscovery: () => invoke(CHANNELS.adbStopDiscovery),
    getActiveSession: () => invoke(CHANNELS.adbGetActiveSession),
    disconnect: (serial) => invoke(CHANNELS.adbDisconnect, serial),
    getDeviceInfo: (serial) => invoke(CHANNELS.adbGetDeviceInfo, serial),
    getCachedInstalledApps: (serial) => invoke(CHANNELS.adbGetCachedInstalledApps, serial),
    loadInstalledApps: (serial, loadId) => invoke(CHANNELS.adbLoadInstalledApps, serial, loadId),
    cancelInstalledAppsLoad: (loadId) => invoke(CHANNELS.adbCancelInstalledAppsLoad, loadId),
    onInstalledApp: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on(CHANNELS.installedAppEvent, handler)
      return () => ipcRenderer.removeListener(CHANNELS.installedAppEvent, handler)
    },
  },
})
