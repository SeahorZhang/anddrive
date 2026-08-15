import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  adb: {
    getDevices: () => ipcRenderer.invoke('adb:getDevices'),
    shell: (serial, command) => ipcRenderer.invoke('adb:shell', serial, command),
    install: (serial, apkPath) => ipcRenderer.invoke('adb:install', serial, apkPath),
    push: (serial, localPath, remotePath) => ipcRenderer.invoke('adb:push', serial, localPath, remotePath),
    pull: (serial, remotePath, localPath) => ipcRenderer.invoke('adb:pull', serial, remotePath, localPath),
    screencap: (serial) => ipcRenderer.invoke('adb:screencap', serial),
    getDeviceProps: (serial) => ipcRenderer.invoke('adb:getDeviceProps', serial),
    forward: (serial, local, remote) => ipcRenderer.invoke('adb:forward', serial, local, remote),
    getDHCPIpAddress: (serial) => ipcRenderer.invoke('adb:getDHCPIpAddress', serial),
  },
})
