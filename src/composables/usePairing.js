import { renderSVG } from 'uqr'
import { adb } from '../services/desktopApi'

const randCode = () => String(Date.now() % 1000000).padStart(6, '0')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 配对完成后等待设备广播 tls-connect 服务的时间上限
const CONNECT_TIMEOUT_MS = 20000

export function usePairing() {
  const { startDiscovery, getDiscoveredDevices, getDiscoveredConnectTargets, stopDiscovery } = adb
  const { pair, connectDevice } = adb

  const qrDataUrl = ref('')
  const status = ref('idle') // idle | waiting | pairing | success | error
  const statusMessage = ref('')
  let pollTimer = null
  let password = ''

  const start = async () => {
    password = randCode()
    const ssid = `d${randCode()}`
    qrDataUrl.value = `data:image/svg+xml;base64,${btoa(renderSVG(`WIFI:T:ADB;S:${ssid};P:${password};;`, { ecc: 'M', pixelSize: 8 }))}`

    status.value = 'waiting'
    statusMessage.value = '等待设备扫码...'

    try {
      await startDiscovery()
      pollTimer = setInterval(async () => {
        try {
          const devices = await getDiscoveredDevices()
          if (devices.length > 0) {
            clearInterval(pollTimer)
            pollTimer = null
            await doPair(devices[0].address)
          }
        } catch (e) {
          clearInterval(pollTimer)
          pollTimer = null
          status.value = 'error'
          statusMessage.value = `发现设备失败: ${e.message}`
        }
      }, 1000)
    } catch (e) {
      status.value = 'error'
      statusMessage.value = `启动发现失败: ${e.message}`
    }
  }

  const doPair = async (address) => {
    status.value = 'pairing'
    statusMessage.value = `正在配对 ${address}...`

    const [host, port] = address.split(':')
    try {
      await pair(host, port, password)
      await establishConnection(host)
      if (status.value !== 'pairing') return // 弹窗已关闭，不误报成功
      status.value = 'success'
      statusMessage.value = '配对成功！'
    } catch (e) {
      // 用户关闭弹窗（stop 已复位状态）时不再覆盖为错误
      if (status.value === 'idle') return
      status.value = 'error'
      statusMessage.value = `连接失败: ${e.message}`
    }
  }

  /**
   * 配对只建立信任，还需对设备 tls-connect 端口执行 adb connect 才会出现在设备列表。
   * 优先选择与配对目标同 IP 的服务；刚配对完 TLS 握手可能未就绪，轮询重试直至超时。
   * @param {string} pairHost 配对目标的 IP
   */
  const establishConnection = async (pairHost) => {
    statusMessage.value = '配对成功，正在建立连接...'
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    let lastError = new Error('未发现设备的无线调试连接服务')

    while (Date.now() < deadline) {
      if (status.value !== 'pairing') return // 弹窗已关闭，停止流程
      try {
        const targets = await getDiscoveredConnectTargets()
        const matched = targets.find((target) => target.startsWith(`${pairHost}:`))
        const target = matched || targets[0]
        if (target) {
          const [host, port] = target.split(':')
          await connectDevice(host, Number(port))
          return
        }
      } catch (e) {
        lastError = e
      }
      await sleep(1000)
    }
    throw lastError
  }

  const stop = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    stopDiscovery()
    status.value = 'idle'
    statusMessage.value = ''
    password = ''
  }

  onUnmounted(stop)

  return { qrDataUrl, status, statusMessage, start, stop }
}
