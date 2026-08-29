import Bonjour from "bonjour-service";

let bonjour = null;
let pairingBrowser = null;
let connectBrowser = null;

let pairingEndpoints = new Map();
let connectEndpoints = new Map();

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
 * @param {(device: {name: string, address: string, ip: string, port: number, service: string}) => void} [onDevice]
 */
export function startPairingDiscovery(onDevice) {
  stopPairingDiscovery();

  if (!bonjour) {
    bonjour = new Bonjour();
  }

  pairingEndpoints = new Map();

  pairingBrowser = bonjour.find({ type: "adb-tls-pairing" }, (svc) => {
    const ip = ipOf(svc);
    if (!ip) return;

    const device = {
      name: svc.name,
      address: `${ip}:${svc.port}`,
      ip,
      port: svc.port,
      service: "adb-tls-pairing",
    };

    pairingEndpoints.set(device.address, device);

    onDevice?.(device);
  });

  return pairingBrowser;
}

/**
 * 停止 Pairing Discovery
 */
export function stopPairingDiscovery() {
  if (pairingBrowser) {
    pairingBrowser.stop?.();
    pairingBrowser = null;
  }

  pairingEndpoints.clear();
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
 * @param {(device: {name: string, address: string, ip: string, port: number, service: string}) => void} [onDevice]
 */
export function startConnectDiscovery(onDevice) {
  stopConnectDiscovery();

  if (!bonjour) {
    bonjour = new Bonjour();
  }

  connectBrowser = bonjour.find({ type: "adb-tls-connect" }, (svc) => {
    const ip = ipOf(svc);
    if (!ip) return;

    onDevice({
      name: svc.name,
      ip,
      port: svc.port,
      address: `${ip}:${svc.port}`,
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

  connectEndpoints.clear();
}

/** @returns {Array<{name: string, address: string, ip: string, port: number, service: string}>} */
export function getDiscoveredDevices() {
  return Array.from(pairingEndpoints.values());
}

/** @returns {Array<{name: string, address: string, ip: string, port: number, service: string}>} */
export function getConnectEndpoints() {
  return Array.from(connectEndpoints.values());
}

/**
 * Resolve the current connect address (`ip:port`) advertised by one wireless
 * device, matched by the guid embedded in its mDNS-form serial.
 * @param {string} serial e.g. "adb-af3d7abd-Zvci5V._adb-tls-connect._tcp"
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>} fresh address, or '' when not found in time
 */
export async function resolveConnectAddress(serial, { timeoutMs = 6000 } = {}) {
  startConnectDiscovery();
  const guid = (serial.match(/adb-([^-]+)/) || [])[1] || "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const hit = getConnectEndpoints().find((e) => !guid || e.name.includes(guid));
      if (hit) return hit.address;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } finally {
    stopConnectDiscovery();
  }
  return "";
}

/**
 * 停止所有 Discovery
 */
export function stopDiscovery() {
  stopPairingDiscovery();
  stopConnectDiscovery();

  if (bonjour) {
    bonjour.destroy?.();
    bonjour = null;
  }

  pairingEndpoints.clear();
  connectEndpoints.clear();
}
