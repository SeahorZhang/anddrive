import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from './ipcContract.js'

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  startScrcpy: (options) => invoke(CHANNELS.scrcpyStart, options),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on(CHANNELS.updateStatus, listener)
    return () => ipcRenderer.removeListener(CHANNELS.updateStatus, listener)
  },
  getUpdateStatus: () => invoke(CHANNELS.updateGetStatus),
  installUpdate: () => invoke(CHANNELS.updateInstall),
  getUpdateNotes: () => invoke(CHANNELS.updateNotes),
  adb: {
    connect: (address) => invoke('adb:connect', address),
    pair: (device, password) => invoke(CHANNELS.adbPair, device, password),
    findDevice: () => invoke('adb:findDevice'),
    resolveConnectAddress: (serial) => invoke('adb:resolveConnectAddress', serial),
    installHelpera: (address) => invoke('adb:installHelper', address),
    loadInstalledApps: (address) => invoke('adb:loadInstalledApps', address),
    getAppIcons: (serial, packages) => invoke(CHANNELS.adbGetAppIcons, serial, packages),
    disconnect: (serial) => invoke(CHANNELS.adbDisconnect, serial),
    deleteAppCache: (serial) => invoke(CHANNELS.adbDeleteAppCache, serial),
    uninstallHelper: (serial) => invoke(CHANNELS.adbUninstallHelper, serial),
  },
})
