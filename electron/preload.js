import { contextBridge, ipcRenderer } from 'electron'

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  startScrcpy: (options) => invoke('start_scrcpy', options),
  adb: {
    pair: (h, p, c) => invoke('adb:pair', h, p, c),
    startDiscovery: () => invoke('adb:startDiscovery'),
    getDiscoveredDevices: () => invoke('adb:getDiscoveredDevices'),
    stopDiscovery: () => invoke('adb:stopDiscovery'),
    getDevices: () => invoke('adb:getDevices'),
    getDeviceInfo: (serial) => invoke('adb:getDeviceInfo', serial),
    getCachedInstalledApps: (serial) => invoke('adb:getCachedInstalledApps', serial),
    loadInstalledApps: (serial, loadId) => invoke('adb:loadInstalledApps', serial, loadId),
    cancelInstalledAppsLoad: (loadId) => invoke('adb:cancelInstalledAppsLoad', loadId),
    onInstalledApp: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on('adb:installed-app', handler)
      return () => ipcRenderer.removeListener('adb:installed-app', handler)
    },
  },
})
