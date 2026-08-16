import Bonjour from "bonjour-service";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getAdbPath() {
  const bin = { darwin: "mac/adb", win32: "win/adb.exe", linux: "linux/adb" }[process.platform];
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
  return path.join(base, "adb", bin);
}

function getHelperApkPath() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
  return path.join(base, "helper-app.apk");
}

const HELPER_PACKAGE = "com.anddrive.helper";
const HELPER_PORT = 18923;

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
        const lines = stdout.trim().split('\n').slice(1);
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

function adbExec(...args) {
  return new Promise((resolve, reject) => {
    execFile(getAdbPath(), args, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

function adbShell(serial, ...args) {
  return adbExec("-s", serial, "shell", ...args);
}

// 检查helper app是否已安装
async function isHelperInstalled(serial) {
  console.log('[isHelperInstalled] Checking...');
  try {
    const output = await adbShell(serial, "pm", "list", "packages", HELPER_PACKAGE);
    console.log('[isHelperInstalled] Output:', output);
    return output.includes(HELPER_PACKAGE);
  } catch (err) {
    console.error('[isHelperInstalled] Error:', err.message);
    return false;
  }
}

// 安装helper app
async function installHelper(serial) {
  console.log('[installHelper] Installing...');
  const apkPath = getHelperApkPath();
  console.log('[installHelper] APK path:', apkPath);
  if (!fs.existsSync(apkPath)) {
    throw new Error("Helper APK not found: " + apkPath);
  }
  console.log('[installHelper] Running adb install...');
  const result = await adbExec("-s", serial, "install", "-r", apkPath);
  console.log('[installHelper] Install result:', result);
}

// 启动helper app
async function startHelper(serial) {
  await adbShell(
    serial,
    "am", "start", "-n",
    `${HELPER_PACKAGE}/.MainActivity`
  );
  // 等待服务启动（增加到2秒）
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// 停止helper app
async function stopHelper(serial) {
  try {
    await adbShell(serial, "am", "force-stop", HELPER_PACKAGE);
  } catch {}
}

// 设置端口转发
async function forwardPort(serial) {
  await adbExec("-s", serial, "forward", `tcp:${HELPER_PORT}`, `tcp:${HELPER_PORT}`);
}

// 移除端口转发
async function removeForward(serial) {
  try {
    await adbExec("-s", serial, "forward", "--remove", `tcp:${HELPER_PORT}`);
  } catch {}
}

// 通过HTTP请求（带重试）
function httpGet(url, retries = 3, parseJson = true) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const req = http.get(url, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          if (parseJson) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              if (remaining > 0) {
                setTimeout(() => attempt(remaining - 1), 1000);
              } else {
                reject(new Error("Failed to parse response: " + e.message));
              }
            }
          } else {
            resolve(data);
          }
        });
      });
      req.on("error", (err) => {
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 1000);
        } else {
          reject(err);
        }
      });
      req.setTimeout(30000, () => {
        req.destroy();
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 1000);
        } else {
          reject(new Error("Request timeout"));
        }
      });
    };
    attempt(retries);
  });
}

// 通过helper app获取app列表（一次性获取名称和图标）
export async function getInstalledApps(serial) {
  await ensureServer();

  console.log('[getInstalledApps] Starting for serial:', serial);

  // 检查并安装helper app
  const installed = await isHelperInstalled(serial);
  console.log('[getInstalledApps] Helper installed:', installed);
  if (!installed) {
    console.log('[getInstalledApps] Installing helper...');
    await installHelper(serial);
    console.log('[getInstalledApps] Helper installed successfully');
  }

  // 启动helper app
  console.log('[getInstalledApps] Starting helper...');
  await startHelper(serial);
  console.log('[getInstalledApps] Helper started');

  // 设置端口转发
  console.log('[getInstalledApps] Forwarding port...');
  await forwardPort(serial);
  console.log('[getInstalledApps] Port forwarded');

  try {
    // 从helper获取app列表
    console.log('[getInstalledApps] Fetching apps from helper...');
    const result = await httpGet(`http://127.0.0.1:${HELPER_PORT}/apps`, 3, true);
    const apps = result.apps || [];
    console.log('[getInstalledApps] Got', apps.length, 'apps');

    // 逐个获取图标
    console.log('[getInstalledApps] Fetching icons...');
    for (const app of apps) {
      try {
        const iconData = await httpGet(`http://127.0.0.1:${HELPER_PORT}/icon?pkg=${app.packageName}`, 1, false);
        if (iconData && !iconData.includes('Not Found')) {
          app.icon = iconData;
        }
      } catch {
        // 图标获取失败，忽略
      }
    }
    console.log('[getInstalledApps] Icons fetched');

    return apps.map(app => ({
      packageName: app.packageName,
      label: app.label || app.packageName,
      icon: app.icon || null,
      detailsLoaded: true,
    }));
  } catch (err) {
    console.error('[getInstalledApps] Error:', err.message);
    throw err;
  } finally {
    // 只移除端口转发，不停止helper app（保持运行以便下次使用）
    console.log('[getInstalledApps] Cleaning up...');
    await removeForward(serial);
    console.log('[getInstalledApps] Cleanup done');
  }
}

// 兼容旧接口（现在不需要了，因为getInstalledApps一次返回所有数据）
export async function getAppDetails(serial, apkPath) {
  return { label: null, icon: null };
}

export async function getAppName(serial, packageName) {
  return packageName.split('.').pop();
}

export async function getAppIcon(serial, packageName) {
  return null;
}

export async function getDeviceInfo(serial) {
  await ensureServer();

  const [model, brand, marketname, batteryOutput, storageOutput] = await Promise.all([
    adbShell(serial, "getprop", "ro.product.model").catch(() => ""),
    adbShell(serial, "getprop", "ro.product.brand").catch(() => ""),
    adbShell(serial, "getprop", "ro.product.marketname").catch(() => ""),
    adbShell(serial, "dumpsys", "battery").catch(() => ""),
    adbShell(serial, "df", "-h").catch(() => ""),
  ]);

  const deviceName = marketname
    ? (brand && !marketname.startsWith(brand) ? `${brand} ${marketname}` : marketname)
    : `${brand} ${model}`.trim();

  const battery = batteryOutput.match(/level:\s*(\d+)/)?.[1]
    ? parseInt(batteryOutput.match(/level:\s*(\d+)/)[1])
    : -1;

  const isCharging = batteryOutput.match(/status:\s*(\d+)/)?.[1] === '2';

  const storageLines = storageOutput.trim().split('\n');
  let storage = '';
  let storagePercent = 0;
  for (const line of storageLines) {
    const trimmedLine = line.trim();
    if (trimmedLine.endsWith(' /data')) {
      const parts = trimmedLine.split(/\s+/).filter(Boolean);
      if (parts.length >= 5) {
        storage = `${parts[2]}/${parts[1]}`;
        storagePercent = parseInt(parts[4]) || 0;
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
