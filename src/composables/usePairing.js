import { renderSVG } from "uqr";
const adb = window.electronAPI.adb;

const randCode = () => String(Date.now() % 1000000).padStart(6, "0");

const DISCOVER_TIMEOUT = 10000;

export function usePairing() {
  const qrDataUrl = ref("");
  const status = ref("idle"); // idle-闲置 | waiting-等待 | pairing-配对中 | connecting-连接中 | success-成功 | error-错误
  const statusMessage = ref("");
  let password = "";

  const start = async () => {
    password = randCode();
    const ssid = `d${randCode()}`;
    qrDataUrl.value = `data:image/svg+xml;base64,${btoa(renderSVG(`WIFI:T:ADB;S:${ssid};P:${password};;`, { ecc: "M", pixelSize: 8 }))}`;

    status.value = "waiting";
    statusMessage.value = "等待设备扫码...";

    try {
      await adb.startPairingDiscovery((device) => {
        if (status.value !== "waiting") return;
        status.value = "pairing";
        statusMessage.value = `正在配对 ${device.address}...`;
        void doPair(device);
      });
    } catch (e) {
      status.value = "error";
      statusMessage.value = `启动发现失败: ${e.message}`;
    }
  };

  const doPair = async (device) => {
    try {
      await adb.pair(device.ip, device.port, password);
      statusMessage.value = "配对成功！";
      // void savePairedDevice();
      await discoverAndConnect();
    } catch (e) {
      status.value = "error";
      statusMessage.value = `配对失败: ${e.message}`;
    } finally {
      await adb.stopPairingDiscovery();
    }
  };

  /** 配对完成后：切到 connect 发现，拿到当前 endpoint 后 adb connect */
  const discoverAndConnect = async () => {
    status.value = "connecting";
    statusMessage.value = "正在发现设备连接端口...";
    let timer;

    try {
      const address = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("未发现设备连接端口")), DISCOVER_TIMEOUT);

        adb.startConnectDiscovery((device) => {
          clearTimeout(timer);
          resolve(device.address);
        });
      });

      statusMessage.value = `正在连接 ${address}...`;

      await adb.connect(address);

      status.value = "success";
      statusMessage.value = "连接成功！";
    } catch (e) {
      status.value = "error";
      statusMessage.value = `连接失败: ${e.message}`;
    } finally {
      clearTimeout(timer);
      await adb.stopConnectDiscovery();
    }
  };

  /** 扫码配对成功后，把设备信息保存到本机（失败不影响配对流程） */
  // async function savePairedDevice() {
  //   try {
  //     await new Promise((resolve) => setTimeout(resolve, 1500));
  //     const session = await adb.getActiveSession();
  //     if (session.status !== "connected") return;
  //     const info = await adb.getDeviceInfo(session.serial);
  //     const address = /^\d+(\.\d+){3}:\d+$/.test(session.serial) ? session.serial : "";
  //     await adb.saveDevice({ serial: session.serial, address, deviceName: info?.deviceName || "" });
  //   } catch {
  //     // 保存失败不影响配对流程
  //   }
  // }

  const stop = async () => {
    await adb.stopDiscovery();
    status.value = "idle";
    statusMessage.value = "";
    password = "";
  };

  onUnmounted(stop);

  return { qrDataUrl, status, statusMessage, start, stop };
}
