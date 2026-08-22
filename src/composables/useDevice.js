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
  const { getDevices, getDeviceInfo } = adb
  const device = ref(createEmptyDevice())

  /**
   * 选择唯一在线设备并拉取设备信息。
   * 行为像一次 api 调用：成功返回 true（device 已填充），
   * 没有可用设备返回 false；多台在线或获取信息失败时抛错，由调用方展示冲突/错误。
   * @returns {Promise<boolean>} 是否成功连接到一台可用设备
   */
  const connect = async () => {
    const selection = selectDevice(await getDevices())
    if (selection.status === 'conflict') {
      const serials = selection.devices.map((d) => d.serial).join(', ')
      throw new Error(
        `检测到 ${selection.devices.length} 台已连接设备（${serials}），请断开多余设备后再连接`,
      )
    }
    if (selection.status === 'none') return false

    const info = await getDeviceInfo(selection.device.serial)
    device.value = { ...createEmptyDevice(), ...info, serial: selection.device.serial }
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
