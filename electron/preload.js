import { contextBridge, ipcRenderer } from 'electron'

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  adb: {
    pair: (h, p, c) => invoke('adb:pair', h, p, c),
    startDiscovery: () => invoke('adb:startDiscovery'),
    getDiscoveredDevices: () => invoke('adb:getDiscoveredDevices'),
    stopDiscovery: () => invoke('adb:stopDiscovery'),
    getDevices: () => invoke('adb:getDevices'),
  },
})
