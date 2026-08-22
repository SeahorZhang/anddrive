import Bonjour from 'bonjour-service'

// mDNS 发现：
// - adb-tls-pairing：配对握手服务（扫码阶段）
// - adb-tls-connect：无线连接服务。成功判定不依赖它（走 track-devices），
//   但它是显式 connect 端口的即时来源——配对后密钥同步存在竞态，
//   自动连接常以 offline 收场，需要拿到端口主动重连。
let bonjour = null
/** @type {import('bonjour-service').Browser|null} */
let pairingBrowser = null
/** @type {import('bonjour-service').Browser|null} */
let connectBrowser = null
/** @type {Set<(address: string) => void>} */
const pairingListeners = new Set()
/** @type {Set<(address: string) => void>} */
const connectListeners = new Set()
/** @type {Set<string>} 已广播过的目标，避免重复通知 */
const announced = new Set()

const firstLanAddress = (svc) => svc.addresses?.find((a) => !a.includes(':') && a !== '127.0.0.1')

/**
 * 订阅新发现的配对服务。返回取消订阅函数。
 * @param {(address: string) => void} listener
 * @returns {() => void}
 */
export function onDiscovered(listener) {
  pairingListeners.add(listener)
  return () => pairingListeners.delete(listener)
}

/**
 * 订阅新发现的无线连接服务（用于配对后的主动重连）。返回取消订阅函数。
 * @param {(address: string) => void} listener
 * @returns {() => void}
 */
export function onConnectTarget(listener) {
  connectListeners.add(listener)
  return () => connectListeners.delete(listener)
}

export function startDiscovery() {
  stopDiscovery()
  bonjour = new Bonjour()
  pairingBrowser = bonjour.find({ type: 'adb-tls-pairing' }, (svc) =>
    announce('pairing', svc, pairingListeners),
  )
  connectBrowser = bonjour.find({ type: 'adb-tls-connect' }, (svc) =>
    announce('connect', svc, connectListeners),
  )
}

function announce(kind, svc, listeners) {
  const ip = firstLanAddress(svc)
  if (!ip) return
  const address = `${kind}:${ip}:${svc.port}`
  if (announced.has(address)) return
  announced.add(address)
  const payload = `${ip}:${svc.port}`
  for (const listener of listeners) listener(payload)
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
