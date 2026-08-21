import { adb } from "../electronApi";

const createEmptyDevice = () => ({
  serial: "",
  model: "",
  brand: "",
  deviceName: "",
  battery: -1,
  isCharging: false,
  storage: "",
  storagePercent: 0,
  error: null,
});

export function useDevice() {
  const { getDevices, getDeviceInfo } = adb;
  const device = ref(createEmptyDevice());

  /**
   * 找到第一个已连接的设备并拉取设备信息。
   * 行为像一次 api 调用：成功返回 true（device 已填充），
   * 没有可用设备返回 false，异常向上抛出。
   * @returns {Promise<boolean>} 是否成功连接到一台可用设备
   */
  const connect = async () => {
    const devices = await getDevices();
    const connected = devices.find((d) => d.state === "device");
    if (!connected) return false;
    console.log(22, connected);

    const info = await getDeviceInfo(connected.serial);
    device.value = { ...createEmptyDevice(), ...info, serial: connected.serial };
    return true;
  };

  /**
   * 重新拉取设备信息（充电状态、电量、名称可能已变化）。
   * 失败时保持旧数据不动，由调用方决定是否告警。
   */
  const refresh = async () => {
    if (!device.value.serial) return;
    const info = await getDeviceInfo(device.value.serial);
    device.value = { ...createEmptyDevice(), ...info, serial: device.value.serial };
  };

  return { device, connect, refresh };
}
