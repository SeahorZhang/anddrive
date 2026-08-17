import { renderSVG } from "uqr";
import { useAdb } from "./useAdb";

const randCode = () => String(Date.now() % 1000000).padStart(6, "0");

export function usePairing() {
  const { startDiscovery, getDiscoveredDevices, stopDiscovery, pair } = useAdb();

  const qrDataUrl = ref("");
  const status = ref("idle"); // idle | waiting | pairing | success | error
  const statusMessage = ref("");
  let pollTimer = null;
  let password = "";

  const start = async () => {
    password = randCode();
    const ssid = `d${randCode()}`;
    qrDataUrl.value = `data:image/svg+xml;base64,${btoa(renderSVG(`WIFI:T:ADB;S:${ssid};P:${password};;`, { ecc: "M", pixelSize: 8 }))}`;

    status.value = "waiting";
    statusMessage.value = "等待设备扫码...";

    try {
      await startDiscovery();
      pollTimer = setInterval(async () => {
        try {
          const devices = await getDiscoveredDevices();
          if (devices.length > 0) {
            clearInterval(pollTimer);
            pollTimer = null;
            await doPair(devices[0].address);
          }
        } catch (e) {
          clearInterval(pollTimer);
          pollTimer = null;
          status.value = "error";
          statusMessage.value = `发现设备失败: ${e.message}`;
        }
      }, 1000);
    } catch (e) {
      status.value = "error";
      statusMessage.value = `启动发现失败: ${e.message}`;
    }
  };

  const doPair = async (address) => {
    status.value = "pairing";
    statusMessage.value = `正在配对 ${address}...`;

    const [host, port] = address.split(":");
    try {
      await pair(host, port, password);
      status.value = "success";
      statusMessage.value = "配对成功！";
    } catch (e) {
      status.value = "error";
      statusMessage.value = `配对失败: ${e.message}`;
    }
  };

  const stop = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    stopDiscovery();
    status.value = "idle";
    statusMessage.value = "";
    password = "";
  };

  onUnmounted(stop);

  return { qrDataUrl, status, statusMessage, start, stop };
}
