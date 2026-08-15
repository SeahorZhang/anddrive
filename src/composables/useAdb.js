export function useAdb() {
  const api = window.electronAPI?.adb;

  if (!api) {
    console.warn("ADB API not available. Are you running in Electron?");
  }

  const getDevices = async () => {
    if (!api) return [];
    return api.getDevices();
  };

  const shell = async (serial, command) => {
    if (!api) throw new Error("ADB API not available");
    return api.shell(serial, command);
  };

  const install = async (serial, apkPath) => {
    if (!api) throw new Error("ADB API not available");
    return api.install(serial, apkPath);
  };

  const push = async (serial, localPath, remotePath) => {
    if (!api) throw new Error("ADB API not available");
    return api.push(serial, localPath, remotePath);
  };

  const pull = async (serial, remotePath, localPath) => {
    if (!api) throw new Error("ADB API not available");
    return api.pull(serial, remotePath, localPath);
  };

  const screencap = async (serial) => {
    if (!api) throw new Error("ADB API not available");
    const base64 = await api.screencap(serial);
    return `data:image/png;base64,${base64}`;
  };

  const getDeviceProps = async (serial) => {
    if (!api) throw new Error("ADB API not available");
    return api.getDeviceProps(serial);
  };

  const forward = async (serial, local, remote) => {
    if (!api) throw new Error("ADB API not available");
    return api.forward(serial, local, remote);
  };

  const getDHCPIpAddress = async (serial) => {
    if (!api) throw new Error("ADB API not available");
    return api.getDHCPIpAddress(serial);
  };

  return {
    getDevices,
    shell,
    install,
    push,
    pull,
    screencap,
    getDeviceProps,
    forward,
    getDHCPIpAddress,
  };
}
