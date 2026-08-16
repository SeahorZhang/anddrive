const api = window.electronAPI?.adb;

export function useAdb() {
  return api;
}
