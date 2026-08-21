// 渲染进程侧访问 preload 暴露 API 的唯一入口。
// 只做转发，避免各处写 window.electronAPI.*；类型见 src/electron-api.d.ts。
export const adb = window.electronAPI.adb
export const platform = window.electronAPI.platform
export const startScrcpy = window.electronAPI.startScrcpy
