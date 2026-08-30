import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "./ipcContract.js";

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  startScrcpy: (options) => invoke(CHANNELS.scrcpyStart, options),
  adb: {
    connect: (address) => invoke("adb:connect", address),
    pair: (device, password) => invoke(CHANNELS.adbPair, device, password),
    findDevice: () => invoke("adb:findDevice"),
    resolveConnectAddress: (serial) => invoke("adb:resolveConnectAddress", serial),
    installHelpera: (address) => invoke("adb:installHelper", address),
    loadInstalledApps: (address) => invoke("adb:loadInstalledApps", address),
    getAppIcons: (serial, packages) => invoke(CHANNELS.adbGetAppIcons, serial, packages),

    // connectDevice: (device) => invoke("adb:connectDevice", device),
    // getDiscoveredDevices: () => invoke(CHANNELS.adbGetDiscoveredDevices),
    // stopPairingDiscovery: () => {
    //   ipcRenderer.removeAllListeners(CHANNELS.adbOnPairingDevice)
    //   return invoke(CHANNELS.adbStopPairingDiscovery)
    // },
    // startConnectDiscovery: (onDevice) => {
    //   ipcRenderer.on(CHANNELS.adbOnConnectDevice, (_, device) => onDevice?.(device))
    //   return invoke(CHANNELS.adbStartConnectDiscovery)
    // },
    // getConnectEndpoints: () => invoke(CHANNELS.adbGetConnectEndpoints),
    // stopConnectDiscovery: () => {
    //   ipcRenderer.removeAllListeners(CHANNELS.adbOnConnectDevice)
    //   return invoke(CHANNELS.adbStopConnectDiscovery)
    // },
    // stopDiscovery: () => {
    //   ipcRenderer.removeAllListeners(CHANNELS.adbOnPairingDevice)
    //   ipcRenderer.removeAllListeners(CHANNELS.adbOnConnectDevice)
    //   return invoke(CHANNELS.adbStopDiscovery)
    // },
    // getActiveSession: () => invoke(CHANNELS.adbGetActiveSession),
    // getDevices: () => invoke(CHANNELS.adbGetDevices),
    // disconnect: (serial) => invoke(CHANNELS.adbDisconnect, serial),
    // getDeviceInfo: (serial) => invoke(CHANNELS.adbGetDeviceInfo, serial),
    // getSavedDevices: () => invoke(CHANNELS.adbGetSavedDevices),
    // saveDevice: (device) => invoke(CHANNELS.adbSaveDevice, device),
    // resolveConnectAddress: (serial) => invoke(CHANNELS.adbResolveConnectAddress, serial),
    // getCachedInstalledApps: (serial) => invoke(CHANNELS.adbGetCachedInstalledApps, serial),
    deleteAppCache: (serial) => invoke(CHANNELS.adbDeleteAppCache, serial),
    // installHelper: (serial) => invoke(CHANNELS.adbInstallHelper, serial),
    uninstallHelper: (serial) => invoke(CHANNELS.adbUninstallHelper, serial),
  },
});
