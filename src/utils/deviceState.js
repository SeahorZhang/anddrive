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

/**
 * 这一行设备包含的接法。列表行和接管记录都由主进程的 `deviceListRow` 生成，
 * 所以「这台现在几种接法」只在主进程算一次，界面只读不算。
 */
export function deviceTransports(device) {
  return device.transports
}

/** 接法文案：两种同时连着就两个都标，不挑一个代表。 */
export function transportText(transport) {
  return transport === 'usb' ? 'USB' : '无线'
}

/**
 * 会话正在用的那条 transport 的实时状态。不是整台手机的状态：拔了数据线但无线
 * 还连着时，这台机器仍然在列表里，只有 USB 那一条变成 absent。
 * @param {{ connections: { address: string, state: string }[] }[]} devices 设备列表（已按手机归并）
 * @param {string} address 会话用的 adb serial
 */
export function transportState(devices, address) {
  for (const row of devices) {
    const connection = row.connections.find((c) => c.address === address)
    if (connection) return connection.state
  }
  return 'absent'
}
