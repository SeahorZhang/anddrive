import { renderSVG } from 'uqr'
import { adb } from '../services/desktopApi'

const randCode = () => String(Date.now() % 1000000).padStart(6, '0')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 配对完成后等待设备可连接的时间上限
const CONNECT_TIMEOUT_MS = 30000

export function usePairing() {
  const { startDiscovery, getDiscoveredDevices, getDiscoveredConnectTargets, stopDiscovery } = adb
  const { pair, connectDevice, getDevices } = adb

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
   * 配对只建立信任，设备不会自动出现在 adb devices。三条路径谁先到都算成功：
   * 1. 权威判定：轮询设备列表——adb server 自带 mdns 会自动连接已配对设备（实测最可靠）
   * 2. 显式连接：对我们浏览到的 tls-connect 目标执行 connect（优先配对时同 IP）
   * 3. 超时失败：设备离线/关屏等导致始终不可达时给出明确错误
   * @param {string} pairHost 配对目标的 IP
   */
  const establishConnection = async (pairHost) => {
    statusMessage.value = '配对成功，正在建立连接...'
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    let lastError = new Error('未发现设备的无线调试连接服务')

    while (Date.now() < deadline) {
      if (status.value !== 'pairing') return false // 弹窗已关闭，停止流程
      try {
        const devices = await getDevices()
        if (devices.some((device) => device.state === 'device')) return true
      } catch {
        // 设备列表查询失败不致命，下轮重试
      }
      try {
        const targets = await getDiscoveredConnectTargets()
        const target =
          targets.find((candidate) => candidate.startsWith(`${pairHost}:`)) || targets[0]
        if (target) {
          const [host, port] = target.split(':')
          await connectDevice(host, Number(port))
          return true
        }
      } catch (e) {
        lastError = e // 刚配完 TLS 握手可能未就绪，等下一轮重试
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
