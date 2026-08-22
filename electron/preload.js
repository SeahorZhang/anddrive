import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipcContract.js'

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  startScrcpy: (options) => invoke(IPC.startScrcpy, options),
  adb: {
    pair: (h, p, c) => invoke(IPC.pair, h, p, c),
    startDiscovery: () => invoke(IPC.startDiscovery),
    getDiscoveredDevices: () => invoke(IPC.getDiscoveredDevices),
    stopDiscovery: () => invoke(IPC.stopDiscovery),
    getDevices: () => invoke(IPC.getDevices),
    disconnect: (serial) => invoke(IPC.disconnect, serial),
    getDeviceInfo: (serial) => invoke(IPC.getDeviceInfo, serial),
    getCachedInstalledApps: (serial) => invoke(IPC.getCachedInstalledApps, serial),
    loadInstalledApps: (serial, loadId) => invoke(IPC.loadInstalledApps, serial, loadId),
    cancelInstalledAppsLoad: (loadId) => invoke(IPC.cancelInstalledAppsLoad, loadId),
    onInstalledApp: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on(IPC.installedAppEvent, handler)
      return () => ipcRenderer.removeListener(IPC.installedAppEvent, handler)
    },
  },
})
