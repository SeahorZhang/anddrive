import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "./ipcContract.js";

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  startScrcpy: (options) => invoke(CHANNELS.scrcpyStart, options),
  scrcpy: {
    list: () => invoke(CHANNELS.scrcpyList),
    focus: (id) => invoke(CHANNELS.scrcpyFocus, id),
    stop: (id) => invoke(CHANNELS.scrcpyStop, id),
    stopAll: () => invoke(CHANNELS.scrcpyStopAll),
  },
  adb: {
    connect: (address) => invoke("adb:connect", address),
    pair: (device, password) => invoke(CHANNELS.adbPair, device, password),
    findDevice: () => invoke("adb:findDevice"),
    resolveConnectAddress: (serial) => invoke("adb:resolveConnectAddress", serial),
    listConnectDevices: () => invoke("adb:listConnectDevices"),
    getConnectedDevice: () => invoke("adb:getConnectedDevice"),
    getDeviceState: (serial) => invoke("adb:getDeviceState", serial),
    reconnect: (serial) => invoke("adb:reconnect", serial),
    installHelpera: (address) => invoke("adb:installHelper", address),
    loadInstalledApps: (address) => invoke("adb:loadInstalledApps", address),
    getCachedApps: (address) => invoke(CHANNELS.adbGetCachedApps, address),
    getAppIcons: (serial, packages) => invoke(CHANNELS.adbGetAppIcons, serial, packages),
    disconnect: (serial) => invoke(CHANNELS.adbDisconnect, serial),
    deleteAppCache: (serial) => invoke(CHANNELS.adbDeleteAppCache, serial),
    uninstallHelper: (serial) => invoke(CHANNELS.adbUninstallHelper, serial),
    forceStopApp: (serial, packageName) => invoke(CHANNELS.adbForceStop, serial, packageName),
    clearAppData: (serial, packageName) => invoke(CHANNELS.adbClearData, serial, packageName),
    uninstallApp: (serial, packageName) => invoke(CHANNELS.adbUninstallApp, serial, packageName),
    getAppInfo: (serial, packageName) => invoke(CHANNELS.adbAppInfo, serial, packageName),
    exportApk: (serial, packageName) => invoke(CHANNELS.adbExportApk, serial, packageName),
  },
  permissions: {
    getStatus: () => invoke(CHANNELS.permissionsStatus),
    request: (id) => invoke(CHANNELS.permissionsRequest, id),
    openSettings: (id) => invoke(CHANNELS.permissionsOpenSettings, id),
  },
  favorites: {
    get: (serial) => invoke(CHANNELS.favoritesGet, serial),
    toggle: (serial, packageName) => invoke(CHANNELS.favoritesToggle, serial, packageName),
  },
});
