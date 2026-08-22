import Bonjour from 'bonjour-service'

// mDNS 发现：adb-tls-pairing（配对握手）与 adb-tls-connect（无线连接）。
// 服务出现时即时回调 onDiscovered 订阅者，无轮询。自持生命周期，不依赖 renderer。

let bonjour = null
/** @type {import('bonjour-service').Browser|null} */
let pairingBrowser = null
/** @type {import('bonjour-service').Browser|null} */
let connectBrowser = null
/** @type {Set<(target: import('../../shared/types.js').DiscoveredServiceTarget) => void>} */
const listeners = new Set()
/** @type {Set<string>} 本次发现周期内已广播过的目标，避免重复通知 */
const announced = new Set()

const firstLanAddress = (svc) => svc.addresses?.find((a) => !a.includes(':') && a !== '127.0.0.1')

/**
 * 订阅新发现的服务。返回取消订阅函数。
 * @param {(target: import('../../shared/types.js').DiscoveredServiceTarget) => void} listener
 * @returns {() => void}
 */
export function onDiscovered(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function startDiscovery() {
  stopDiscovery()
  bonjour = new Bonjour()
  pairingBrowser = bonjour.find({ type: 'adb-tls-pairing' }, (svc) => announce('pairing', svc))
  connectBrowser = bonjour.find({ type: 'adb-tls-connect' }, (svc) => announce('connect', svc))
}

function announce(kind, svc) {
  const ip = firstLanAddress(svc)
  if (!ip) return
  const address = `${ip}:${svc.port}`
  const key = `${kind}:${address}`
  if (announced.has(key)) return
  announced.add(key)
  const target = { kind, address }
  for (const listener of listeners) listener(target)
}

export function stopDiscovery() {
  pairingBrowser?.stop()
  connectBrowser?.stop()
  pairingBrowser = null
  connectBrowser = null
  bonjour?.destroy()
  bonjour = null
  announced.clear()
}
