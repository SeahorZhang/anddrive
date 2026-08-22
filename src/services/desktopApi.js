// 渲染进程访问桌面能力的唯一入口（preload contextBridge 桥接）。
// 业务代码禁止直接引用 window.electronAPI 或任何 IPC channel 字符串：
// channel 契约见 shared/ipcContract.js，桥接类型见 src/electron-api.d.ts。
const bridge = window.electronAPI

export const adb = bridge.adb
export const platform = bridge.platform
export const startScrcpy = bridge.startScrcpy
export const diagnostics = bridge.diagnostics
