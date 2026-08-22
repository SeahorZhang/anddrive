// electron/preload.js 通过 contextBridge 暴露到 window 的 API 类型。
// 与 preload.js 的导出保持一致；类型复用 shared/types.js 里的 typedef。
interface AndDriveElectronApi {
  platform: string
  startScrcpy: (options: import('../../shared/types.js').ScrcpyLaunchInput) => Promise<unknown>
  adb: {
    pair: (host: string, port: number, code: string) => Promise<string>
    startDiscovery: () => Promise<void>
    getDiscoveredDevices: () => Promise<{ name: string; address: string }[]>
    getDiscoveredConnectTargets: () => Promise<string[]>
    connectDevice: (host: string, port: number) => Promise<string>
    stopDiscovery: () => Promise<void>
    getDevices: () => Promise<import('../../shared/types.js').AdbDevice[]>
    disconnect: (serial: string) => Promise<boolean>
    getDeviceInfo: (serial: string) => Promise<import('../../shared/types.js').DeviceInfo>
    getCachedInstalledApps: (
      serial: string,
    ) => Promise<import('../../shared/types.js').AppCacheSnapshot | null>
    loadInstalledApps: (serial: string, loadId: number) => Promise<void>
    cancelInstalledAppsLoad: (loadId: number) => Promise<void>
    onInstalledApp: (
      callback: (event: import('../../shared/types.js').AppLoadEvent) => void,
    ) => () => void
  }
}

interface Window {
  electronAPI: AndDriveElectronApi
}
