// electron/preload.js 通过 contextBridge 暴露到 window 的 API 类型。
// 与 preload.js 的导出保持一致；类型复用 shared/types.js 里的 typedef。
interface DiagnosticItem {
  id: string
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

interface DiagnosticSighting {
  type: string
  address: string
  name?: string
}

interface AndDriveElectronApi {
  platform: string
  startScrcpy: (options: import('../../shared/types.js').ScrcpyLaunchInput) => Promise<unknown>
  diagnostics: {
    run: () => Promise<{ items: DiagnosticItem[] }>
    listenPairingBroadcast: (windowMs?: number) => Promise<DiagnosticSighting[]>
  }
  adb: {
    pairDevice: (host: string, port: number, code: string) => Promise<string>
    restoreDevice: () => Promise<string | null>
    onPairingEvent: (
      callback: (event: import('../../shared/types.js').PairingEvent) => void,
    ) => () => void
    startDiscovery: () => Promise<boolean>
    stopDiscovery: () => Promise<boolean>
    onDiscoveredTarget: (callback: (address: string) => void) => () => void
    onDevicesChanged: (
      callback: (devices: import('../../shared/types.js').AdbDevice[]) => void,
    ) => () => void
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
