import Bonjour from "bonjour-service";

let bonjour = null;
let pairingBrowser = null;
let connectBrowser = null;

const ipOf = (svc) => {
  return svc.addresses?.find((a) => !a.includes(":") && a !== "127.0.0.1");
};

/**
 * 发现 ADB Pairing Service
 *
 * 用于首次配对：
 *
 * adb-tls-pairing
 *      ↓
 * Pairing Endpoint
 *      ↓
 * 手机扫码 / 配对
 *
 * @returns {Promise<{given_name?: string, name?: string, serial?: string, address: string}>}
 */
export function findDevice() {
  stopPairingDiscovery();

  if (!bonjour) {
    bonjour = new Bonjour();
  }

  return new Promise((resolve) => {
    bonjour.find({ type: "adb-tls-pairing" }, (svc) => {
      const ip = ipOf(svc);
      if (!ip) return;
      const { txt = {}, port } = svc;
      resolve({
        given_name: txt.given_name,
        name: txt.name,
        serial: txt.serial,
        address: `${ip}:${port}`,
      });
      stopPairingDiscovery();
    });
  });
}

/**
 * 停止 Pairing Discovery
 */
export function stopPairingDiscovery() {
  if (pairingBrowser) {
    pairingBrowser.stop?.();
    pairingBrowser = null;
  }
}

/**
 * 发现 ADB Connect Service
 *
 * 用于已经配对的设备：
 *
 * adb-tls-connect
 *      ↓
 * 当前 ADB TLS Endpoint
 *      ↓
 * adb connect
 *
 * @returns {Promise<{given_name?: string, name?: string, serial?: string, address: string}>}
 */
export function resolveConnectAddress() {
  stopConnectDiscovery();

  if (!bonjour) {
    bonjour = new Bonjour();
  }

  return new Promise((resolve) => {
    bonjour.find({ type: "adb-tls-connect" }, (svc) => {
      const ip = ipOf(svc);
      if (!ip) return;
      const { txt = {}, port } = svc;
      resolve({
        given_name: txt.given_name,
        name: txt.name,
        serial: txt.serial,
        address: `${ip}:${port}`,
      });
      stopConnectDiscovery();
    });
  });
}

/**
 * 停止 Connect Discovery
 */
export function stopConnectDiscovery() {
  if (connectBrowser) {
    connectBrowser.stop?.();
    connectBrowser = null;
  }
}
