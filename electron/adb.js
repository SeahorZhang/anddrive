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
