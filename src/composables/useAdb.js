const unavailableError = () => new Error('Electron preload did not expose electronAPI.adb')

const unavailableApi = {
  pair: async () => {
    throw unavailableError()
  },
  startDiscovery: async () => {
    throw unavailableError()
  },
  getDiscoveredDevices: async () => {
    throw unavailableError()
  },
  stopDiscovery: () => {},
  getDevices: async () => {
    throw unavailableError()
  },
  getDeviceInfo: async () => {
    throw unavailableError()
  },
  getCachedInstalledApps: async () => {
    throw unavailableError()
  },
  loadInstalledApps: async () => {
    throw unavailableError()
  },
  cancelInstalledAppsLoad: () => {},
  onInstalledApp: () => () => {},
}

export function useAdb() {
  return Reflect.get(window, 'electronAPI')?.adb || unavailableApi
}
