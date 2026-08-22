import { renderSVG } from 'uqr'
import { adb } from '../services/desktopApi'

const randCode = () => String(Date.now() % 1000000).padStart(6, '0')

// pairDevice 编排各阶段完成即推送事件；此处只映射提示文案
const PHASE_MESSAGES = {
  paired: '配对成功，正在建立无线连接...',
  connecting: '正在建立无线连接...',
  connected: '连接成功，检查 Helper...',
  installing: '正在安装 Helper App（无线传输需数秒）...',
  installed: 'Helper 安装完成！',
}

export function usePairing() {
  const { startDiscovery, stopDiscovery, pairDevice, onPairingEvent, onDiscoveredTarget } = adb

  const qrDataUrl = ref('')
  const status = ref('idle') // idle | waiting | pairing | success | error
  const statusMessage = ref('')
  let password = ''
  let offTarget = null
  let offProgress = null

  function clearListeners() {
    offTarget?.()
    offTarget = null
    offProgress?.()
    offProgress = null
  }

  /**
   * 扫码后 pairing 服务一出现即触发（mDNS up 事件，无轮询）。
   */
  const start = async () => {
    password = randCode()
    const ssid = `d${randCode()}`
    qrDataUrl.value = `data:image/svg+xml;base64,${btoa(renderSVG(`WIFI:T:ADB;S:${ssid};P:${password};;`, { ecc: 'M', pixelSize: 8 }))}`

    status.value = 'waiting'
    statusMessage.value = '等待设备扫码...'

    try {
      await startDiscovery()
      offTarget = onDiscoveredTarget(({ kind, address }) => {
        if (status.value !== 'waiting' || kind !== 'pairing') return
        void doPair(address)
      })
    } catch (e) {
      status.value = 'error'
      statusMessage.value = `启动发现失败: ${e.message}`
    }
  }

  /**
   * 一次调用交给 main 编排：配对 → 建立连接 → 按需安装 Helper。
   * 各阶段完成经 pairing-event 即时反馈到界面，promise resolve 即全部就绪。
   * @param {string} address
   */
  const doPair = async (address) => {
    status.value = 'pairing'
    statusMessage.value = `正在配对 ${address}...`

    const [host, port] = address.split(':')
    offProgress = onPairingEvent(({ phase }) => {
      if (PHASE_MESSAGES[phase]) statusMessage.value = PHASE_MESSAGES[phase]
    })
    try {
      await pairDevice(host, Number(port), password)
      // 弹窗已关闭（stop 复位状态）时不误报成功
      if (status.value !== 'pairing') return
      status.value = 'success'
      statusMessage.value = '配对成功！'
    } catch (e) {
      if (status.value === 'idle') return
      status.value = 'error'
      statusMessage.value = `连接失败: ${e.message}`
    } finally {
      offProgress?.()
      offProgress = null
    }
  }

  const stop = () => {
    clearListeners()
    stopDiscovery()
    status.value = 'idle'
    statusMessage.value = ''
    password = ''
  }

  onUnmounted(stop)

  return { qrDataUrl, status, statusMessage, start, stop }
}
