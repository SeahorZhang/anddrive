import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from './ipcContract.js'

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  startScrcpy: (options) => invoke(CHANNELS.scrcpyStart, options),
  adb: {
    pair: (h, p, c) => invoke(CHANNELS.adbPair, h, p, c),
    connect: (address) => invoke(CHANNELS.adbConnect, address),
    startDiscovery: () => invoke(CHANNELS.adbStartDiscovery),
    getDiscoveredDevices: () => invoke(CHANNELS.adbGetDiscoveredDevices),
    stopDiscovery: () => invoke(CHANNELS.adbStopDiscovery),
    getActiveSession: () => invoke(CHANNELS.adbGetActiveSession),
    getDevices: () => invoke(CHANNELS.adbGetDevices),
    disconnect: (serial) => invoke(CHANNELS.adbDisconnect, serial),
    getDeviceInfo: (serial) => invoke(CHANNELS.adbGetDeviceInfo, serial),
    getCachedInstalledApps: (serial) => invoke(CHANNELS.adbGetCachedInstalledApps, serial),
    deleteAppCache: (serial) => invoke(CHANNELS.adbDeleteAppCache, serial),
    installHelper: (serial) => invoke(CHANNELS.adbInstallHelper, serial),
    uninstallHelper: (serial) => invoke(CHANNELS.adbUninstallHelper, serial),
    loadInstalledApps: (serial) => invoke(CHANNELS.adbLoadInstalledApps, serial),
    getAppIcons: (serial, packages) => invoke(CHANNELS.adbGetAppIcons, serial, packages),
  },
})
