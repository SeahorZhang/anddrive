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

/** 启动恢复宽限窗：adb 自带 mDNS 自动连接通常在服务就绪后数秒内完成 */
const RESTORE_WINDOW_MS = 6000

export function useDevice() {
  const { getDevices, getDeviceInfo, onDevicesChanged } = adb
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
   * 应用启动时 adb 的 mDNS 自动连接可能在服务就绪后几秒才完成：
   * 首次查询未发现设备时，保持监听一个宽限窗，期间任何设备上线立即重试。
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

    const selection = await new Promise((resolve) => {
      const finish = (value) => {
        off()
        clearTimeout(timer)
        resolve(value)
      }
      // 直接评估事件快照，宽限窗内不做探测式重复查询
      const evaluate = (devices) => {
        const found = selectDevice(devices)
        if (found.status !== 'none') finish(found)
      }
      const off = onDevicesChanged(evaluate)
      const timer = setTimeout(() => finish(null), RESTORE_WINDOW_MS)
    })

    if (!selection) return false
    if (selection.status === 'conflict') {
      throw conflictError(selection.devices.map((d) => d.serial).join(', '))
    }
    apply(selection.device.serial, await getDeviceInfo(selection.device.serial))
    return true
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
