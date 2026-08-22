import Bonjour from 'bonjour-service'

// mDNS 发现：adb-tls-pairing（配对握手）与 adb-tls-connect（无线连接）。
// 配对只建立信任，设备要进入 `adb devices` 还需对其 tls-connect 端口执行 adb connect。
// 自持生命周期，不依赖 renderer。
let bonjour = null
/** @type {import('bonjour-service').Browser|null} */
let pairingBrowser = null
/** @type {import('bonjour-service').Browser|null} */
let connectBrowser = null
/** @type {Map<string, { name: string, address: string }>} */
let discovered = new Map()
/** @type {string[]} */
let connectTargets = []

const firstLanAddress = (svc) => svc.addresses?.find((a) => !a.includes(':') && a !== '127.0.0.1')

export function startDiscovery() {
  stopDiscovery()
  discovered = new Map()
  connectTargets = []
  bonjour = new Bonjour()
  pairingBrowser = bonjour.find({ type: 'adb-tls-pairing' }, (svc) => {
    const ip = firstLanAddress(svc)
    if (ip) discovered.set(`${ip}:${svc.port}`, { name: svc.name, address: `${ip}:${svc.port}` })
  })
  connectBrowser = bonjour.find({ type: 'adb-tls-connect' }, (svc) => {
    const ip = firstLanAddress(svc)
    if (!ip) return
    const target = `${ip}:${svc.port}`
    if (!connectTargets.includes(target)) connectTargets.push(target)
  })
}

export function getDiscoveredDevices() {
  return Array.from(discovered.values())
}

/** @returns {string[]} 无线连接目标（"ip:port"，即 adb connect 参数） */
export function getDiscoveredConnectTargets() {
  return [...connectTargets]
}

export function stopDiscovery() {
  pairingBrowser?.stop()
  connectBrowser?.stop()
  pairingBrowser = null
  connectBrowser = null
  bonjour?.destroy()
  bonjour = null
  discovered = new Map()
  connectTargets = []
}
