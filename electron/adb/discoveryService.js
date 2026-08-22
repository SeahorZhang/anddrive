import Bonjour from 'bonjour-service'

// mDNS 发现：仅浏览 adb-tls-pairing（配对握手）。
// 无线连接阶段不依赖本机 Bonjour——实测其对 adb-tls-connect 浏览不可靠；
// 设备上线信号由 adb server 自带 mdns（自动连接）经 track-devices 推送。
let bonjour = null
/** @type {import('bonjour-service').Browser|null} */
let pairingBrowser = null
/** @type {Set<(address: string) => void>} */
const listeners = new Set()
/** @type {Set<string>} 本次发现周期内已广播过的目标，避免重复通知 */
const announced = new Set()

const firstLanAddress = (svc) => svc.addresses?.find((a) => !a.includes(':') && a !== '127.0.0.1')

/**
 * 订阅新发现的配对服务。返回取消订阅函数。
 * @param {(address: string) => void} listener
 * @returns {() => void}
 */
export function onDiscovered(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function startDiscovery() {
  stopDiscovery()
  bonjour = new Bonjour()
  pairingBrowser = bonjour.find({ type: 'adb-tls-pairing' }, (svc) => {
    const ip = firstLanAddress(svc)
    if (!ip) return
    const address = `${ip}:${svc.port}`
    if (announced.has(address)) return
    announced.add(address)
    for (const listener of listeners) listener(address)
  })
}

export function stopDiscovery() {
  pairingBrowser?.stop()
  pairingBrowser = null
  bonjour?.destroy()
  bonjour = null
  announced.clear()
}
