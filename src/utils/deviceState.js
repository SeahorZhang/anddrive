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

/**
 * 是不是同一台手机。列表行按 stableId 归并过，但接管记录可能只带着其中一条
 * transport 的 address，所以先比稳定标识、再退回 address。
 */
export function sameDevice(a, b) {
  if (!a || !b) return false
  return (!!a.stableId && !!b.stableId && a.stableId === b.stableId) || a.address === b.address
}

/**
 * 盯住设备列表，返回**这一轮比上一轮新出现的、可以连接的**设备；当前在用的那台不算。
 * 「新」是按轮次做差集，不是「列表里有没有别的可连接设备」—— 从扫码页选中一台进首页时，
 * 另一台本来就在那份列表里，它不是新设备，不该提醒。
 * `seen` 由调用方持有并在函数里更新：这一轮见过的都记进去，从列表消失过的摘掉，
 * 所以同一台只在它第一次出现时报一次，拔掉再插回来会再报一次。
 * @param {{ stableId: string, connected: boolean }[]} devices 本轮设备列表
 * @param {Set<string>} seen 上一轮为止见过的 stableId
 * @param {{ stableId: string, address: string } | null} current 当前展示的设备
 */
export function watchNewConnectedDevices(devices, seen, current) {
  const fresh = devices.filter(
    (d) => d.connected && !seen.has(d.stableId) && !sameDevice(d, current),
  )
  const present = new Set(devices.map((d) => d.stableId))
  for (const stableId of seen) {
    if (!present.has(stableId)) seen.delete(stableId)
  }
  for (const stableId of present) seen.add(stableId)
  return fresh
}

/**
 * 把这份列表记为「已经认识」（播种用，不发提醒）：接管一台设备时先调它，
 * 之后只有真正新冒出来的设备才会被 `watchNewConnectedDevices` 报出来。
 * @param {{ stableId: string }[]} devices
 * @param {Set<string>} seen
 */
export function markDevicesKnown(devices, seen) {
  for (const d of devices) seen.add(d.stableId)
}

/**
 * 没连着设备时的静默接管规则：**只有一台**可连接才接管。
 * 两台以上就是「接管哪台」的决定，得留给用户点，随便挑一台等于把另一台顶掉。
 * @param {{ connected: boolean }[]} devices
 * @returns {{ connected: boolean } | null}
 */
export function pickAdoptableDevice(devices) {
  const candidates = devices.filter((d) => d.connected)
  return candidates.length === 1 ? candidates[0] : null
}
