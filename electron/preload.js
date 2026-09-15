import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "./ipcContract.js";

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

// 镜像窗口：主进程用普通 IPC 送初始信息与视频包。带 ArrayBuffer 的消息经
// contextBridge 转发会走结构化克隆，这里直接在 preload 里转到页面主世界。
function forwardToPage(channel, kind) {
  ipcRenderer.on(channel, (_event, payload) => {
    window.postMessage({ __anddriveMirror: kind, payload }, "*");
  });
}
forwardToPage(CHANNELS.mirrorInit, "init");
forwardToPage(CHANNELS.mirrorVideo, "packet");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  startScrcpy: (options) => invoke(CHANNELS.scrcpyStart, options),
  mirror: {
    start: (options) => invoke(CHANNELS.mirrorStart, options),
    list: () => invoke(CHANNELS.mirrorList),
    stop: (id) => invoke(CHANNELS.mirrorStop, id),
    stopAll: () => invoke(CHANNELS.mirrorStopAll),
    focus: (id) => invoke(CHANNELS.mirrorFocus, id),
    control: (message) => ipcRenderer.send(CHANNELS.mirrorControl, message),
    onError: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(CHANNELS.mirrorError, listener);
      return () => ipcRenderer.removeListener(CHANNELS.mirrorError, listener);
    },
    onExit: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(CHANNELS.mirrorExit, listener);
      return () => ipcRenderer.removeListener(CHANNELS.mirrorExit, listener);
    },
  },
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
