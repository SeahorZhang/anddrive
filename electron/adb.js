import Bonjour from "bonjour-service";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getAdbPath() {
  const bin = { darwin: "mac/adb", win32: "win/adb.exe", linux: "linux/adb" }[process.platform];
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
  return path.join(base, "adb", bin);
}

let serverStarted = false;

async function ensureServer() {
  if (serverStarted) return;
  await new Promise((resolve, reject) => {
    execFile(getAdbPath(), ["start-server"], (err) => {
      if (err) reject(err);
      else { serverStarted = true; resolve(); }
    });
  });
}

export function pair(host, port, code) {
  return ensureServer().then(() => new Promise((resolve, reject) => {
    execFile(getAdbPath(), ["pair", `${host}:${port}`, code], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  }));
}

// mDNS discovery
let bonjour = null;
let browser = null;
let discovered = new Map();

export function startDiscovery() {
  stopDiscovery();
  discovered = new Map();
  bonjour = new Bonjour();
  browser = bonjour.find({ type: "adb-tls-pairing" }, (svc) => {
    const ip = svc.addresses?.find(a => !a.includes(":") && a !== "127.0.0.1");
    if (ip) discovered.set(`${ip}:${svc.port}`, { name: svc.name, address: `${ip}:${svc.port}` });
  });
}

export function getDiscoveredDevices() {
  return Array.from(discovered.values());
}

export function stopDiscovery() {
  browser?.stop(); browser = null;
  bonjour?.destroy(); bonjour = null;
  discovered = new Map();
}

export function getDevices() {
  return ensureServer().then(() => new Promise((resolve, reject) => {
    execFile(getAdbPath(), ["devices"], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else {
        const lines = stdout.trim().split('\n').slice(1); // 跳过第一行 "List of devices attached"
        const devices = lines
          .filter(line => line.includes('device'))
          .map(line => {
            const [serial, state] = line.split('\t');
            return { serial, state };
          });
        resolve(devices);
      }
    });
  }));
}

function adbShell(serial, ...args) {
  return new Promise((resolve, reject) => {
    execFile(getAdbPath(), ["-s", serial, "shell", ...args], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

export async function getDeviceInfo(serial) {
  await ensureServer();

  // 参考 anddrive: 并行执行所有 adb shell 命令
  const [model, brand, marketname, batteryOutput, storageOutput] = await Promise.all([
    adbShell(serial, "getprop", "ro.product.model").catch(() => ""),
    adbShell(serial, "getprop", "ro.product.brand").catch(() => ""),
    adbShell(serial, "getprop", "ro.product.marketname").catch(() => ""),
    adbShell(serial, "dumpsys", "battery").catch(() => ""),
    adbShell(serial, "df", "-h").catch(() => ""),
  ]);

  // 设备名称：优先市场名，加上品牌前缀（避免重复）
  const deviceName = marketname
    ? (brand && !marketname.startsWith(brand) ? `${brand} ${marketname}` : marketname)
    : `${brand} ${model}`.trim();

  // 解析电量
  const battery = batteryOutput.match(/level:\s*(\d+)/)?.[1]
    ? parseInt(batteryOutput.match(/level:\s*(\d+)/)[1])
    : -1;

  // 解析充电状态: status 2 = Charging
  const isCharging = batteryOutput.match(/status:\s*(\d+)/)?.[1] === '2';

  // 解析存储信息 - 参考 anddrive: 取 df -h 输出
  const storageLines = storageOutput.trim().split('\n');
  let storage = '';
  let storagePercent = 0;
  for (const line of storageLines) {
    const trimmedLine = line.trim();
    if (trimmedLine.endsWith(' /data')) {
      const parts = trimmedLine.split(/\s+/).filter(Boolean);
      // 格式: Filesystem Size Used Avail Use% Mounted
      if (parts.length >= 5) {
        storage = `${parts[2]}/${parts[1]}`; // 如 "162G/477G"
        storagePercent = parseInt(parts[4]) || 0; // 如 "34%"
      }
      break;
    }
  }

  return {
    serial,
    model,
    deviceName,
    battery,
    isCharging,
    storage,
    storagePercent,
  };
}
