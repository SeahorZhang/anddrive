import Bonjour from "bonjour-service";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { app } from "electron";
import { ICON_REFRESH_MS, readAppCache, writeAppCache } from "./appCache.js";
import { parseAdbDevices, parseIconBatch } from "./adb/parsers.js";
import {
  isAlreadyDisconnectedError,
  isMissingForwardError,
  normalizeDisconnectSerial,
} from "./adbDisconnect.js";

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
const HELPER_PROTOCOL_VERSION = 4;
const HELPER_PORT = 18923;
const DEVICE_INFO_LOAD_ID = "device-info";
const ICON_BATCH_SIZE = 24;
const ICON_BATCH_CONCURRENCY = 4;

let serverStarted = false;
const activeAppLoads = new Map();
let activeForward = null;
let forwardQueue = Promise.resolve();
const helperUpgradeAttempted = new Set();

const helperUrl = (path) => `http://127.0.0.1:${HELPER_PORT}${path}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireForwardLock() {
  const previous = forwardQueue;
  let release;
  forwardQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

async function ensureServer() {
  if (serverStarted) return;
  await new Promise((resolve, reject) => {
    execFile(getAdbPath(), ["start-server"], (err) => {
      if (err) reject(err);
      else {
        serverStarted = true;
        resolve();
      }
    });
  });
}

export function pair(host, port, code) {
  return adbExec("pair", `${host}:${port}`, code);
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
    const ip = svc.addresses?.find((a) => !a.includes(":") && a !== "127.0.0.1");
    if (ip) discovered.set(`${ip}:${svc.port}`, { name: svc.name, address: `${ip}:${svc.port}` });
  });
}

export function getDiscoveredDevices() {
  return Array.from(discovered.values());
}

export function stopDiscovery() {
  browser?.stop();
  browser = null;
  bonjour?.destroy();
  bonjour = null;
  discovered = new Map();
}

function isAppLoadActive(loadId) {
  return activeAppLoads.has(loadId);
}

function cancelAppLoadsForSerial(serial) {
  for (const [loadId, loadSerial] of activeAppLoads) {
    if (loadSerial === serial) activeAppLoads.delete(loadId);
  }
}

function httpRequest(url, { retries = 0, timeout = 10000, parse = "json" } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const req = http.get(url, (res) => {
        if (parse === "buffer") {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            if (remaining > 0) {
              setTimeout(() => attempt(remaining - 1), 300);
            } else {
              reject(new Error("Failed to parse response: " + e.message));
            }
          }
        });
      });

      req.on("error", (err) => {
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 300);
        } else {
          reject(err);
        }
      });

      req.setTimeout(timeout, () => {
        req.destroy();
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 300);
        } else {
          reject(new Error("Request timeout"));
        }
      });
    };
    attempt(retries);
  });
}

const httpGet = (url, retries = 1) => httpRequest(url, { retries });
const httpGetBuffer = (url) => httpRequest(url, { parse: "buffer", timeout: 5000 });

async function isHelperInstalled(serial) {
  try {
    const output = await adbShell(serial, "pm", "list", "packages", HELPER_PACKAGE);
    return output.includes(HELPER_PACKAGE);
  } catch {
    return false;
  }
}

async function installHelper(serial) {
  const apkPath = getHelperApkPath();
  if (!fs.existsSync(apkPath)) {
    throw new Error("Helper APK not found: " + apkPath);
  }
  await adbExec("-s", serial, "install", "-r", apkPath);
}

async function forwardPort(serial, loadId) {
  await adbExec("-s", serial, "forward", `tcp:${HELPER_PORT}`, `tcp:${HELPER_PORT}`);
  activeForward = { serial, loadId };
}

async function removeForward(serial, loadId) {
  if (activeForward?.serial !== serial || activeForward.loadId !== loadId) return;
  activeForward = null;
  try {
    await adbExec("-s", serial, "forward", "--remove", `tcp:${HELPER_PORT}`);
  } catch (error) {
    if (!isMissingForwardError(error)) throw error;
  }
}

async function removeForwardForSerial(serial) {
  if (activeForward?.serial !== serial) return;
  activeForward = null;
  try {
    await adbExec("-s", serial, "forward", "--remove", `tcp:${HELPER_PORT}`);
  } catch (error) {
    if (!isMissingForwardError(error)) throw error;
  }
}

async function startHelperService(serial) {
  try {
    await adbShell(
      serial,
      "am",
      "start-foreground-service",
      "-n",
      `${HELPER_PACKAGE}/.HelperService`,
    );
  } catch {
    await adbShell(serial, "am", "start", "-n", `${HELPER_PACKAGE}/.MainActivity`);
  }
}

async function pingHelper() {
  try {
    await httpGet(helperUrl("/ping"), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHelper(maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await pingHelper()) return true;
    await sleep(100);
  }
  return false;
}

async function ensureHelperReady(serial, loadId) {
  await forwardPort(serial, loadId);
  if (await pingHelper()) return;

  await startHelperService(serial);
  if (!(await waitForHelper())) {
    throw new Error("Helper service failed to start");
  }
}

async function ensureHelperProtocol(serial) {
  // 协议版本不匹配时原地重装一次 helper，保证 /device-info 等新端点可用。
  if (helperUpgradeAttempted.has(serial)) return;
  const capabilities = await httpGet(helperUrl("/ping"), 0).catch(() => ({}));
  if (capabilities.protocol === HELPER_PROTOCOL_VERSION) return;
  helperUpgradeAttempted.add(serial);
  try {
    await installHelper(serial);
    await adbShell(serial, "am", "force-stop", HELPER_PACKAGE);
    await startHelperService(serial);
    await waitForHelper();
  } catch (error) {
    console.warn("In-place helper upgrade failed:", error);
  }
}

function normalizeApp(app) {
  return {
    packageName: app.packageName,
    label: app.label || app.packageName,
    iconUrl: app.iconUrl || null,
  };
}

function uniqueApps(apps) {
  const seen = new Set();
  return apps.map(normalizeApp).filter((app) => {
    if (!app.packageName || seen.has(app.packageName)) return false;
    seen.add(app.packageName);
    return true;
  });
}

function reconcileCachedApps(apps, cache, now) {
  const cachedByPackage = new Map(cache?.apps.map((app) => [app.packageName, app]) || []);
  const snapshotApps = [];
  const iconsToFetch = [];
  for (const app of apps) {
    const cached = cachedByPackage.get(app.packageName);
    const iconUrl = cached?.iconUrl || null;
    const iconUpdatedAt = cached?.iconUpdatedAt || null;
    const reconciled = { ...app, iconUrl, iconUpdatedAt };
    snapshotApps.push(reconciled);
    if (
      !iconUrl ||
      !iconUpdatedAt ||
      now - iconUpdatedAt >= ICON_REFRESH_MS ||
      cached.label !== app.label
    ) {
      iconsToFetch.push(app);
    }
  }
  return { snapshotApps, iconsToFetch };
}

function rendererApps(apps) {
  return apps.map(({ packageName, label, iconUrl }) => ({ packageName, label, iconUrl }));
}

async function fetchIconsLegacy(apps, emit, loadId) {
  let index = 0;
  async function worker() {
    while (index < apps.length) {
      if (!isAppLoadActive(loadId)) return;
      const app = apps[index++];
      try {
        const buffer = await httpGetBuffer(
          helperUrl(`/icon-bin?pkg=${encodeURIComponent(app.packageName)}`),
        );
        if (buffer?.length > 0)
          emit({
            packageName: app.packageName,
            iconUrl: `data:image/png;base64,${buffer.toString("base64")}`,
          });
      } catch {
        // A missing icon should not fail the rest of the list.
      }
    }
  }
  await Promise.all(Array.from({ length: ICON_BATCH_CONCURRENCY }, () => worker()));
}

async function fetchIcons(apps, emit, loadId, batchIcons) {
  if (!batchIcons) return fetchIconsLegacy(apps, emit, loadId);
  let index = 0;
  let fallback = false;
  async function worker() {
    while (!fallback && index < apps.length) {
      if (!isAppLoadActive(loadId)) return;
      const batch = apps.slice(index, (index += ICON_BATCH_SIZE));
      try {
        const packages = batch.map((app) => app.packageName).join(",");
        const buffer = await httpGetBuffer(
          helperUrl(`/icons-bin?pkgs=${encodeURIComponent(packages)}`),
        );
        if (buffer?.length > 0) emit(parseIconBatch(buffer));
        else fallback = true;
      } catch {
        fallback = true;
      }
    }
  }
  await Promise.all(Array.from({ length: ICON_BATCH_CONCURRENCY }, () => worker()));
  if (fallback && isAppLoadActive(loadId)) await fetchIconsLegacy(apps, emit, loadId);
}

export async function loadInstalledApps(serial, loadId, sender) {
  activeAppLoads.set(loadId, serial);
  const releaseForwardLock = await acquireForwardLock();
  const emit = (phase, apps) => {
    if (!isAppLoadActive(loadId)) return;
    sender.send(
      "adb:installed-app",
      apps === undefined ? { loadId, phase } : { loadId, phase, apps },
    );
  };

  try {
    if (!isAppLoadActive(loadId)) return;
    if (!(await isHelperInstalled(serial))) await installHelper(serial);
    if (!isAppLoadActive(loadId)) return;
    await ensureHelperReady(serial, loadId);
    await ensureHelperProtocol(serial);
    const capabilities = await httpGet(helperUrl("/ping"), 0).catch(() => ({}));
    const response = await httpGet(helperUrl("/apps"));
    if (!response || !Array.isArray(response.apps)) throw new Error("Invalid app list response");
    const now = Date.now();
    const normalizedApps = uniqueApps(response.apps);
    const cache = await readAppCache(serial);
    const { snapshotApps, iconsToFetch } = reconcileCachedApps(normalizedApps, cache, now);
    const snapshotByPackage = new Map(snapshotApps.map((app) => [app.packageName, app]));
    const createSnapshot = () => ({
      authoritativeAt: now,
      writtenAt: Date.now(),
      apps: [...snapshotByPackage.values()],
    });

    await writeAppCache(serial, createSnapshot());
    emit("authoritative", rendererApps(snapshotApps));
    if (!isAppLoadActive(loadId)) return;

    let iconChanged = false;
    const emitIcons = (apps) => {
      if (!isAppLoadActive(loadId)) return;
      const updates = [];
      for (const app of Array.isArray(apps) ? apps : [apps]) {
        const existing = snapshotByPackage.get(app.packageName);
        if (!existing || !app.iconUrl) continue;
        existing.iconUrl = app.iconUrl;
        existing.iconUpdatedAt = Date.now();
        updates.push({ packageName: app.packageName, iconUrl: app.iconUrl });
      }
      if (updates.length > 0) {
        iconChanged = true;
        emit("icons", updates);
      }
    };
    await fetchIcons(iconsToFetch, emitIcons, loadId, capabilities.batchIcons === true);
    if (!isAppLoadActive(loadId)) return;
    if (iconChanged) await writeAppCache(serial, createSnapshot());
    emit("complete");
  } finally {
    activeAppLoads.delete(loadId);
    try {
      await removeForward(serial, loadId);
    } catch (error) {
      console.warn("Failed to remove helper forward:", error);
    }
    releaseForwardLock();
  }
}

export function cancelInstalledAppsLoad(loadId) {
  activeAppLoads.delete(loadId);
}

/**
 * Cancel Helper work and remove the forward owned by one device.
 * @param {string} serial
 */
export async function cleanupDevice(serial) {
  serial = normalizeDisconnectSerial(serial);
  cancelAppLoadsForSerial(serial);
  const releaseForwardLock = await acquireForwardLock();
  try {
    await removeForwardForSerial(serial);
  } finally {
    releaseForwardLock();
  }
}

/**
 * Disconnect a wireless ADB transport. Missing transports are idempotent.
 * @param {string} serial
 */
export async function disconnectDevice(serial) {
  serial = normalizeDisconnectSerial(serial);
  await cleanupDevice(serial);
  try {
    await adbExec("disconnect", serial);
  } catch (error) {
    if (isAlreadyDisconnectedError(error)) return true;
    throw error;
  }
  return true;
}

export function getDevices() {
  return adbExec("devices").then(parseAdbDevices);
}

async function adbExec(...args) {
  // adb 是 client/server 架构：所有 adb 命令前先确保守护进程已启动（幂等）。
  await ensureServer();
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

export async function getDeviceInfo(serial) {
  // 走 helper 的 HTTP 端点（本地转发，不受无线 adb 断连影响）。
  const releaseForwardLock = await acquireForwardLock();
  try {
    await ensureServer();
    if (!(await isHelperInstalled(serial))) await installHelper(serial);
    await ensureHelperReady(serial, DEVICE_INFO_LOAD_ID);
    await ensureHelperProtocol(serial);
    const info = await httpGet(helperUrl("/device-info"), 0);
    if (info && info.model) return { serial, ...info };
    throw new Error("Helper /device-info returned no model");
  } finally {
    try {
      await removeForward(serial, DEVICE_INFO_LOAD_ID);
    } catch (error) {
      console.warn("Failed to remove helper forward:", error);
    }
    releaseForwardLock();
  }
}
