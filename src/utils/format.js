/** 字节数 → 人类可读（1024 进制）：内存这类按 KiB 计的量用它。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 || index < 2 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/**
 * 存储容量专用：**1000 进制**，GB 起保留一位小数。
 * 厂商标的 512 GB、手机设置里的「总空间」、AndroMeld 的读数全是十进制；
 * 用 1024 进制会把同一台 512 GB 的机器读成 477 GB —— 数字没错，单位说错了。
 * 保留一位小数是因为对齐的就是它的「255.8 GB / 528.0 GB」：取整会变成「256 / 528」，
 * 差 0.2 GB 看着就像两个来源。
 */
export function formatStorage(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000
    index += 1
  }
  return `${index >= 3 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
}

/** 百分比收成 0..100，非数字当 0（进度条宽度用）。 */
export function clampPercent(value) {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}
