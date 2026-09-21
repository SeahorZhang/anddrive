import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "./ipcContract.js";

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);


// 直连形态的镜像窗口（contextIsolation 关闭）直接用 ipcRenderer 收发，
// 只有隔离窗口才需要 contextBridge 暴露。
const expose = (name, api) => {
  if (process.contextIsolated) contextBridge.exposeInMainWorld(name, api);
  else {
    window[name] = api;
    // 直连镜像窗口（非隔离）直接使用 ipcRenderer。
    window.__anddriveIpc = ipcRenderer;
  }
};

expose("electronAPI", {
  platform: process.platform,
  mirror: {
    start: (options) => invoke(CHANNELS.mirrorStart, options),
    list: () => invoke(CHANNELS.mirrorList),
    stop: (id) => invoke(CHANNELS.mirrorStop, id),
    stopAll: () => invoke(CHANNELS.mirrorStopAll),
    focus: (id) => invoke(CHANNELS.mirrorFocus, id),
    onExit: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(CHANNELS.mirrorExit, listener);
      return () => ipcRenderer.removeListener(CHANNELS.mirrorExit, listener);
    },
  },
  adb: {
    connect: (address) => invoke(CHANNELS.adbConnect, address),
    pair: (device, password) => invoke(CHANNELS.adbPair, device, password),
    findDevice: () => invoke(CHANNELS.adbFindDevice),
    resolveConnectAddress: (serial) => invoke(CHANNELS.adbResolveConnectAddress, serial),
    listConnectDevices: () => invoke(CHANNELS.adbListConnectDevices),
    getConnectedDevice: () => invoke(CHANNELS.adbGetConnectedDevice),
    getDeviceState: (serial) => invoke(CHANNELS.adbGetDeviceState, serial),
    reconnect: (serial) => invoke(CHANNELS.adbReconnect, serial),
    installHelpera: (address) => invoke(CHANNELS.adbInstallHelper, address),
    loadInstalledApps: (address) => invoke(CHANNELS.adbLoadInstalledApps, address),
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
    getDeviceStats: (serial, force) => invoke(CHANNELS.adbGetDeviceStats, serial, force),
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
  scrcpyConfig: {
    get: () => invoke(CHANNELS.scrcpyConfigGet),
    set: (config) => invoke(CHANNELS.scrcpyConfigSet, config),
  },
  shortcuts: {
    create: (payload) => invoke(CHANNELS.shortcutCreate, payload),
    reveal: (filePath) => invoke(CHANNELS.shortcutReveal, filePath),
    onMirrorResult: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(CHANNELS.mirrorResult, listener);
      return () => ipcRenderer.removeListener(CHANNELS.mirrorResult, listener);
    },
  },
});
