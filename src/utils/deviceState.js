/**
 * 设备行的状态判断与文案：右上角切换下拉和扫码弹窗的「可用设备」共用一套，
 * 两处对同一个 state 的说法不能不一样。
 */

/** 列表里每台设备的状态文案：未授权要点手机，USB 插着没调试授权时最常见。 */
export function stateText(device) {
  if (device.connected) return '可连接'
  if (device.state === 'unauthorized' || device.state === 'authorizing') return '待授权'
  return '离线'
}

export function stateClass(device) {
  if (device.connected) return 'bg-[#34c759]/12 text-[#248a3d] dark:text-[#30d158]'
  if (stateText(device) === '待授权') return 'bg-[#ff9500]/14 text-[#b25f00] dark:text-[#ff9f0a]'
  return 'bg-fill text-ink-3'
}

export function stateDotClass(device) {
  if (device.connected) return 'bg-[#34c759]'
  return stateText(device) === '待授权' ? 'bg-[#ff9500]' : 'bg-ink-4'
}

/** 待授权时地址那一行改成操作提示，否则用户只看到一串序列号不知道要点什么。 */
export function deviceHint(device) {
  if (stateText(device) === '待授权') {
    return device.transport === 'usb' ? '请在手机上点「允许 USB 调试」' : '请在手机上允许此电脑调试'
  }
  return device.displayAddress || device.address
}
