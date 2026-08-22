import Bonjour from 'bonjour-service'

// mDNS 发现 adb-tls-pairing 服务。自持生命周期，不依赖 renderer。
let bonjour = null
/** @type {import('bonjour-service').Browser|null} */
let browser = null
/** @type {Map<string, { name: string, address: string }>} */
let discovered = new Map()

export function startDiscovery() {
  stopDiscovery()
  discovered = new Map()
  bonjour = new Bonjour()
  browser = bonjour.find({ type: 'adb-tls-pairing' }, (svc) => {
    const ip = svc.addresses?.find((a) => !a.includes(':') && a !== '127.0.0.1')
    if (ip) discovered.set(`${ip}:${svc.port}`, { name: svc.name, address: `${ip}:${svc.port}` })
  })
}

export function getDiscoveredDevices() {
  return Array.from(discovered.values())
}

export function stopDiscovery() {
  browser?.stop()
  browser = null
  bonjour?.destroy()
  bonjour = null
  discovered = new Map()
}
