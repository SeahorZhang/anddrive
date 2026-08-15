const api = window.electronAPI?.adb

export function useAdb() {
  return {
    pair: (h, p, c) => api.pair(h, p, c),
    startDiscovery: () => api.startDiscovery(),
    getDiscoveredDevices: () => api.getDiscoveredDevices(),
    stopDiscovery: () => api.stopDiscovery(),
    getDevices: () => api.getDevices(),
    getDeviceInfo: (serial) => api.getDeviceInfo(serial),
  }
}
