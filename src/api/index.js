const { connect, findDevice, pair, startConnectDiscovery, resolveConnectAddress } = window.electronAPI.adb;

export const connectApi = (address) => connect(address);

// 开始发现设备
export const findDeviceApi = () => findDevice();

// 开始配对设备
export const pairApi = (device, password) => pair(device, password);

// 解析设备当前可用的连接地址（配对端口不能用于 adb connect）
export const resolveConnectAddressApi = (serial) => resolveConnectAddress(serial);

// 开始连接设备
export const startConnectDiscoveryApi = (device) => startConnectDiscovery(device);
