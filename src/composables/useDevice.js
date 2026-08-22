import { adb } from '../services/desktopApi'
import { selectDevice } from '../../shared/selectDevice.js'

const createEmptyDevice = () => ({
  serial: '',
  model: '',
  brand: '',
  deviceName: '',
  battery: -1,
  isCharging: false,
  storage: '',
  storagePercent: 0,
  error: null,
})

export function useDevice() {
  const { getDevices, getDeviceInfo, restoreDevice } = adb
  const device = ref(createEmptyDevice())

  /**
   * @param {string} serials
   */
  const conflictError = (serials) =>
    new Error(`检测到多台已连接设备（${serials}），请断开多余设备后再连接`)

  const apply = (serial, info) => {
    device.value = { ...createEmptyDevice(), ...info, serial }
  }

  /**
   * 选择唯一在线设备并拉取设备信息。
   * adb server 的 mDNS 自动连接已被禁用（断开后不得静默重连）。
   * 首查未发现传输时不阻塞等待：立即返回 false 让 UI 进入扫码页，
   * 同时触发后台持续重连——设备上线经 devices-changed 推送，由 App 自动进入 home。
   * 行为像一次 api 调用：成功返回 true（device 已填充），
   * 没有可用设备返回 false；多台在线或获取信息失败时抛错，由调用方展示。
   * @returns {Promise<boolean>} 是否成功连接到一台可用设备
   */
  const connect = async () => {
    /** @returns {Promise<boolean>} */
    const attempt = async () => {
      const selection = selectDevice(await getDevices())
      if (selection.status === 'conflict')
        throw conflictError(selection.devices.map((d) => d.serial).join(', '))
      if (selection.status !== 'ok') return false
      apply(selection.device.serial, await getDeviceInfo(selection.device.serial))
      return true
    }

    if (await attempt()) return true

    // 后台恢复不阻塞关键路径：成败均由 devices-changed 事件驱动后续流转
    void restoreDevice().catch(() => null)
    return false
  }

  /**
   * 重新拉取设备信息（充电状态、电量、名称可能已变化）。
   * 失败时保持旧数据不动，由调用方决定是否告警。
   */
  const refresh = async () => {
    if (!device.value.serial) return
    const info = await getDeviceInfo(device.value.serial)
    device.value = { ...createEmptyDevice(), ...info, serial: device.value.serial }
  }

  /**
   * 重置为空设备状态，供断开连接后回到添加设备页时使用。
   */
  const reset = () => {
    device.value = createEmptyDevice()
  }

  return { device, connect, refresh, reset }
}
