import { app, ipcMain } from "electron";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "./ipcContract.js";
import { browse } from "./mdns.js";
import helperVersion from "../resources/helper-app.version.json";

// ---------------------------------------------------------------------------
// 资源路径
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 打包后取 resources 目录，开发环境取项目 ./resources。 */
function resourcesBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
}

const adbPath = () => path.join(resourcesBase(), "adb", "mac", "adb");
const helperApkPath = () => path.join(resourcesBase(), "helper-app.apk");
const scrcpyPath = () => path.join(resourcesBase(), "scrcpy", "scrcpy");

// ---------------------------------------------------------------------------
// ADB 执行
// ---------------------------------------------------------------------------

let serverStarted = false;

async function ensureServer() {
  if (serverStarted) return;
  await new Promise((resolve, reject) => {
    execFile(adbPath(), ["start-server"], (err) => {
      if (err) reject(err);
      else {
        serverStarted = true;
        resolve();
      }
    });
  });
}

/** @param {...string} args */
function adbExec(...args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath(), args, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Like adbExec but never rejects: resolves with `{ code, stdout, stderr }` so
 * callers can inspect exit codes and device output. adb exits non-zero while
 * still printing a meaningful message (e.g. uninstalling a missing package).
 * @param {...string} args
 */
function adbExecSafe(...args) {
  return new Promise((resolve) => {
    execFile(adbPath(), args, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code ?? 1) : 0,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || "",
      });
    });
  });
}

/**
 * Disconnect a wireless ADB transport. Missing transports are idempotent.
 * @param {string} serial
 */
async function disconnectTransport(serial) {
  await ensureServer();
  try {
    await adbExec("disconnect", serial);
  } catch (error) {
    if (isAlreadyDisconnectedError(error)) return true;
    throw error;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ADB 错误分类
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDisconnectSerial(value) {
  if (typeof value !== "string") throw new Error("设备序列号无效");
  const serial = value.trim();
  if (!serial || serial.length > 1024 || /\s/.test(serial)) {
    throw new Error("设备序列号无效");
  }
  return serial;
}

/** @param {unknown} error */
export function isAlreadyDisconnectedError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\bno such device\b|\bdevice(?:\s+['"\w.:[\]-]+)?\s+not found\b|\bnot connected\b/i.test(
    message,
  );
}

// ---------------------------------------------------------------------------
// mDNS 设备发现（使用 adb 自带的 mdns discovery）
// ---------------------------------------------------------------------------

/**
 * 解析 `adb mdns services` 的输出。每行形如：
 * `adb-XXXX	_adb-tls-connect._tcp	192.168.1.5:37000`
 * @param {string} output
 * @returns {{ name: string, type: string, address: string }[]}
 */
export function parseMdnsServices(output) {
  const services = [];
  for (const line of String(output ?? "").split("\n")) {
    const [name, type, address] = line.trim().split(/\s+/);
    if (!name || !type || !address || !type.startsWith("_")) continue;
    services.push({ name, type, address });
  }
  return services;
}

/**
 * 解析 `adb devices` 输出，返回 serial → 状态（device / offline / unauthorized）。
 * 无线调试自动连接后 serial 形如 `adb-XXXX._adb-tls-connect._tcp`，
 * 手动 connect 后形如 `192.168.1.5:37000`。
 * @param {string} output
 * @returns {Map<string, string>}
 */
export function parseAdbDevices(output) {
  const devices = new Map();
  for (const line of String(output ?? "").split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(device|offline|unauthorized)\b/);
    if (match) devices.set(match[1], match[2]);
  }
  return devices;
}

// 递增令牌用于取消上一次仍在轮询的发现，语义与旧浏览器 stop 后 promise 悬挂一致。
let discoveryToken = 0;

/**
 * 轮询 `adb mdns services`，直到出现指定类型的服务。
 * @param {string} serviceType 如 `_adb-tls-pairing._tcp`
 * @returns {Promise<{ name: string, type: string, address: string }>}
 */
async function waitForMdnsService(serviceType) {
  const token = ++discoveryToken;
  await ensureServer();
  while (token === discoveryToken) {
    const output = await adbExec("mdns", "services");
    if (token !== discoveryToken) break;
    const service = parseMdnsServices(output).find((s) => s.type === serviceType);
    if (service) return service;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return new Promise(() => null);
}

/**
 * 发现 ADB Pairing Service，用于首次配对：
 *
 * adb-tls-pairing → Pairing Endpoint → 手机扫码 / 配对
 *
 * @returns {Promise<{name: string, address: string}>}
 */
async function findDevice() {
  return waitForMdnsService("_adb-tls-pairing._tcp");
}

/**
 * 发现 ADB Connect Service，解析设备当前可用的连接地址：
 *
 * adb-tls-connect → 当前 ADB TLS Endpoint → adb connect
 *
 * @returns {Promise<{name: string, address: string}>}
 */
async function resolveConnectAddress() {
  return waitForMdnsService("_adb-tls-connect._tcp");
}

let connectBrowser = null;
/** @type {Map<string, string>} 服务实例名（adb-XXXX）→ TXT 里的设备名称 */
const connectNames = new Map();

function ensureConnectBrowser() {
  if (connectBrowser) return;
  connectBrowser = browse("adb-tls-connect", (service) => {
    const given = service.txt?.given_name;
    if (typeof given === "string" && given.trim()) {
      connectNames.set(service.name.split("._")[0], given.trim());
    }
  });
}

/** @type {Map<string, string | null>} serial → 手机展示的名称 */
const deviceNames = new Map();

/**
 * 读取手机上展示的设备名称（蓝牙名 / 设备名，其次市场名）。按 serial 缓存。
 * @param {string} serial
 */
async function deviceDisplayName(serial) {
  if (deviceNames.has(serial)) return deviceNames.get(serial);
  const shell = async (...args) => {
    try {
      return (await adbExec("-s", serial, "shell", ...args)).trim() || null;
    } catch {
      return null;
    }
  };
  const clean = (value) => (value && value !== "null" ? value : null);
  const [bluetoothName, deviceName, marketName] = await Promise.all([
    shell("settings", "get", "secure", "bluetooth_name"),
    shell("settings", "get", "global", "device_name"),
    shell("getprop", "ro.product.marketname"),
  ]);
  const name = clean(bluetoothName) || clean(deviceName) || clean(marketName) || null;
  deviceNames.set(serial, name);
  return name;
}

/**
 * 以 `adb devices` 为准，返回所有已连接/已配对的设备（含 USB、老式 tcpip、
 * 无线调试），未配对过、只广播的 mDNS 设备不展示。
 *
 * 名称优先取 mDNS TXT 的 given_name，其次读设备上的展示名称。
 * `address` 一律取 adb 的 serial（可直接用于 `adb -s`），展示用 displayAddress。
 * @returns {Promise<{ name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean }[]>}
 */
async function listConnectDevices() {
  ensureConnectBrowser();
  await ensureServer();
  const [mdnsOutput, devicesOutput] = await Promise.all([
    adbExec("mdns", "services"),
    adbExec("devices"),
  ]);

  const mdns = parseMdnsServices(mdnsOutput).filter((s) => s.type === "_adb-tls-connect._tcp");
  /** @type {Map<string, { name: string, type: string, address: string }>} serial → mDNS 服务 */
  const bySerial = new Map();
  for (const s of mdns) {
    bySerial.set(`${s.name}._adb-tls-connect._tcp`, s);
    if (!bySerial.has(s.address)) bySerial.set(s.address, s);
  }

  const entries = [...parseAdbDevices(devicesOutput)].filter(
    ([serial, state]) => state !== "unauthorized" && !serial.startsWith("emulator-"),
  );

  return Promise.all(
    entries.map(async ([serial, state]) => {
      const svc = bySerial.get(serial);
      const label =
        (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null;
      return {
        name: svc?.name || serial,
        type: svc?.type || "_adb-tls-connect._tcp",
        address: serial,
        displayAddress: svc?.address || serial,
        label,
        connected: state === "device",
      };
    }),
  );
}

/**
 * 返回当前 adb 已连接（状态 device）的设备，供启动时接管其他工具
 * （Android Studio / 终端 adb 等）已建立的连接。优先无线设备，
 * address 用 adb 的 serial，可直接用于后续 `adb -s`。
 * @returns {Promise<{ name: string, address: string, displayAddress: string, label: string | null } | null>}
 */
async function getConnectedDevice() {
  await ensureServer();
  const devices = parseAdbDevices(await adbExec("devices"));
  const online = [...devices]
    .filter(([serial, state]) => state === "device" && !serial.startsWith("emulator-"))
    .map(([serial]) => serial);
  if (!online.length) return null;

  const address =
    online.find((s) => s.includes(":") || s.endsWith("._adb-tls-connect._tcp")) ?? online[0];

  let name = address;
  let label = await deviceDisplayName(address);
  let displayAddress = address;
  try {
    ensureConnectBrowser();
    const services = parseMdnsServices(await adbExec("mdns", "services"));
    const matched = services.find(
      (s) =>
        s.type === "_adb-tls-connect._tcp" &&
        (`${s.name}._adb-tls-connect._tcp` === address || s.address === address),
    );
    if (matched) {
      name = matched.name;
      label = connectNames.get(matched.name) || label;
      displayAddress = matched.address;
    }
  } catch {
    // ignore
  }
  return { name, address, displayAddress, label };
}

// ---------------------------------------------------------------------------
// scrcpy 镜像窗口
// ---------------------------------------------------------------------------

/** child process → { serial }; serial comes from the `-s` CLI arg. */
const scrcpyProcesses = new Map();

function serialOf(args) {
  const index = args.indexOf("-s");
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

/**
 * Kill running mirror processes. With a serial only that device's mirrors die;
 * without one everything is stopped (quit / disconnect-all paths).
 * @param {string} [serial]
 */
export function stopScrcpy(serial) {
  for (const [child, info] of scrcpyProcesses) {
    if (serial && info.serial !== serial) continue;
    child.kill("SIGKILL");
    scrcpyProcesses.delete(child);
  }
}

/**
 * Launch a scrcpy mirror window with a single command line.
 * @param {string[]} args full scrcpy CLI arguments
 */
function startScrcpy(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(scrcpyPath(), args, {
      stdio: "ignore",
      // 打包的 adb 不在 PATH 上，scrcpy 通过 ADB 环境变量定位它；server 与可执行文件同目录自动找到。
      env: { ...process.env, ADB: adbPath() },
    });

    scrcpyProcesses.set(child, { serial: serialOf(args) });
    child.once("spawn", () => resolve(true));
    child.once("error", (error) => {
      scrcpyProcesses.delete(child);
      reject(error);
    });
    child.once("exit", () => {
      scrcpyProcesses.delete(child);
    });
  });
}

// ---------------------------------------------------------------------------
// 应用列表缓存
// ---------------------------------------------------------------------------

export const CACHE_VERSION = 2;
export const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const CACHE_TMP_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_DEVICE_CACHES = 20;
const MAX_APPS = 5000;
const MAX_ICON_BYTES = 512 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** @param {unknown} value */
function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** @param {unknown} iconUrl */
export function sanitizeIcon(iconUrl) {
  if (iconUrl == null) return null;
  if (typeof iconUrl !== "string" || !iconUrl.startsWith(PNG_DATA_URL_PREFIX)) return null;
  const encoded = iconUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  if (Buffer.byteLength(encoded, "base64") > MAX_ICON_BYTES) return null;
  return iconUrl;
}

/** @param {unknown} value */
export function sanitizeApp(value) {
  if (!value || typeof value !== "object") return null;
  const entry = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof entry.packageName !== "string" ||
    !entry.packageName ||
    entry.packageName.length > 512
  ) {
    return null;
  }
  const label =
    typeof entry.label === "string" && entry.label ? entry.label.slice(0, 1024) : entry.packageName;
  const iconUrl = sanitizeIcon(entry.iconUrl);
  const iconUpdatedAt =
    iconUrl && validTimestamp(entry.iconUpdatedAt)
      ? /** @type {number} */ (entry.iconUpdatedAt)
      : null;
  return { packageName: entry.packageName, label, iconUrl, iconUpdatedAt };
}

/**
 * @param {unknown} value
 * @param {{ allowExpired?: boolean, now?: number }=} options
 * @returns {import('../shared/types.js').AppCacheSnapshot | null}
 */
export function sanitizeSnapshot(value, { allowExpired = false, now = Date.now() } = {}) {
  if (!value || typeof value !== "object") return null;
  const snapshot = /** @type {Record<string, unknown>} */ (value);
  if (snapshot.version !== CACHE_VERSION || !Array.isArray(snapshot.apps)) return null;
  if (!validTimestamp(snapshot.authoritativeAt) || !validTimestamp(snapshot.writtenAt)) return null;
  if (!allowExpired && now - /** @type {number} */ (snapshot.writtenAt) > CACHE_MAX_AGE_MS) {
    return null;
  }
  if (snapshot.apps.length > MAX_APPS) return null;

  const seen = new Set();
  const apps = [];
  for (const valueApp of snapshot.apps) {
    const cachedApp = sanitizeApp(valueApp);
    if (!cachedApp || seen.has(cachedApp.packageName)) return null;
    seen.add(cachedApp.packageName);
    apps.push(cachedApp);
  }
  return {
    version: CACHE_VERSION,
    authoritativeAt: /** @type {number} */ (snapshot.authoritativeAt),
    writtenAt: /** @type {number} */ (snapshot.writtenAt),
    apps,
  };
}

/**
 * @param {import('../shared/types.js').AppCacheSnapshotInput} snapshot
 * @returns {string | null}
 */
export function serializeSnapshot(snapshot) {
  const sanitized = sanitizeSnapshot(
    { ...snapshot, version: CACHE_VERSION },
    { allowExpired: true },
  );
  if (!sanitized) return null;

  let data = JSON.stringify(sanitized);
  if (Buffer.byteLength(data) <= MAX_SNAPSHOT_BYTES) return data;
  for (const cachedApp of sanitized.apps) {
    cachedApp.iconUrl = null;
    cachedApp.iconUpdatedAt = null;
  }
  data = JSON.stringify(sanitized);
  return Buffer.byteLength(data) <= MAX_SNAPSHOT_BYTES ? data : null;
}

const cacheRoot = () => path.join(app.getPath("userData"), "app-cache", "apps-v1");
const cacheKey = (serial) => createHash("sha256").update(serial).digest("hex");
const cachePath = (serial) => path.join(cacheRoot(), `${cacheKey(serial)}.json`);

async function removeFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Failed to remove app cache:", error);
  }
}

export async function readAppCache(serial) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) return null;
  const filePath = cachePath(serial);
  try {
    const data = await fs.readFile(filePath);
    if (data.length > MAX_SNAPSHOT_BYTES) {
      await removeFile(filePath);
      return null;
    }
    const snapshot = sanitizeSnapshot(JSON.parse(data.toString("utf8")));
    if (!snapshot) await removeFile(filePath);
    return snapshot;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("Failed to read app cache:", error);
      await removeFile(filePath);
    }
    return null;
  }
}

/** Delete the cached snapshot of one device. Idempotent. */
async function deleteAppCache(serial) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) return false;
  await removeFile(cachePath(serial));
  return true;
}

/** Cached app list for one device, or [] when absent. */
async function getCachedApps(serial) {
  return (await readAppCache(serial))?.apps || [];
}

async function pruneCaches(protectedPath) {
  try {
    const root = cacheRoot();
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const filePath = path.join(root, entry.name);
      if (!entry.isFile()) continue;
      if (entry.name.includes(".tmp")) {
        // Only reclaim stale temps: a fresh one may belong to a concurrent
        // writeAppCache that is about to rename it into place.
        try {
          const stats = await fs.stat(filePath);
          if (Date.now() - stats.mtimeMs > CACHE_TMP_MAX_AGE_MS) await removeFile(filePath);
        } catch (error) {
          if (error?.code !== "ENOENT") console.warn("Failed to prune app cache temp:", error);
        }
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const stats = await fs.stat(filePath);
      if (Date.now() - stats.mtimeMs > CACHE_MAX_AGE_MS && filePath !== protectedPath) {
        await removeFile(filePath);
      } else {
        files.push({ filePath, mtimeMs: stats.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files.slice(MAX_DEVICE_CACHES)) {
      if (file.filePath !== protectedPath) await removeFile(file.filePath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Failed to prune app caches:", error);
  }
}

/**
 * @param {string} serial
 * @param {import('../shared/types.js').AppCacheSnapshotInput} snapshot
 */
export async function writeAppCache(serial, snapshot) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) return false;
  const data = serializeSnapshot(snapshot);
  if (data == null) {
    await removeFile(cachePath(serial));
    return false;
  }

  const root = cacheRoot();
  const filePath = cachePath(serial);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(tempPath, data, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
    await pruneCaches(filePath);
    return true;
  } catch (error) {
    console.warn("Failed to write app cache:", error);
    await removeFile(tempPath);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper：应用列表与图标
// ---------------------------------------------------------------------------

const HELPER_PACKAGE = "com.anddrive.helper";

/**
 * Message prefix marking failures where the helper cannot be installed or run
 * on the device; the renderer turns these into an actionable install prompt.
 */
const HELPER_SETUP_ERROR_PREFIX = "HELPER_SETUP:";

const HELPER_ENTRY_CLASS = "com.anddrive.helper.ListMain";
const LIST_TIMEOUT_MS = 120000;
const LIST_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * A package may linger in `pm list` as a ghost after user-0 removal while its
 * APK is gone, so trust `pm path` (real APK location) instead.
 */
async function isHelperInstalled(serial) {
  return (await deviceApkPath(serial)) != null;
}

/** @returns {Promise<string | null>} on-device base.apk path of the helper */
async function deviceApkPath(serial) {
  try {
    const output = await adbExec("-s", serial, "shell", "pm", "path", HELPER_PACKAGE);
    const line = output.split("\n").find((l) => l.startsWith("package:"));
    return line ? line.slice("package:".length).trim() || null : null;
  } catch {
    return null;
  }
}

/** 安装 helper APK；adb 报错或输出不含 Success 均视为失败。 */
async function installHelper(serial) {
  const stdout = await adbExec("-s", serial, "install", "-r", helperApkPath());
  if (!/Success/i.test(stdout)) throw new Error(stdout || "安装失败");
  return "安装成功";
}

/**
 * Remove the helper from the device with a plain `adb uninstall`.
 * Some ROMs print a spurious `Failure [...]` here while actually succeeding,
 * so the output is not treated as authoritative either way.
 * @param {string} serial
 */
async function uninstallHelper(serial) {
  // adbExecSafe never rejects: on this ROM a *successful* uninstall still
  // exits 1 and prints "Failure [...]". Output is logged, not trusted.
  return await adbExecSafe("-s", serial, "uninstall", HELPER_PACKAGE);
}

/** @returns {Promise<string | null>} versionName of the on-device Helper */
async function getInstalledHelperVersion(serial) {
  try {
    const output = await adbExec("-s", serial, "shell", "dumpsys", "package", HELPER_PACKAGE);
    const match = output.match(/versionName=(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** 设备上未安装或版本与随包不一致时才安装。 */
async function ensureLatestHelper(serial) {
  if ((await getInstalledHelperVersion(serial)) !== helperVersion.versionName) {
    await installHelper(serial);
  }
}

/**
 * Run the one-shot ListMain entry inside app_process as shell (uid 2000) and
 * resolve with its stdout text. The installed helper serves purely as the
 * classpath: no component starts and no permission is granted to the package.
 * @param {string} serial
 */
function runHelperList(serial, extraArgs = []) {
  return deviceApkPath(serial).then((apkPath) => {
    if (!apkPath) {
      throw new Error(HELPER_SETUP_ERROR_PREFIX + "设备上未找到 Helper");
    }
    return new Promise((resolve, reject) => {
      execFile(
        adbPath(),
        [
          "-s",
          serial,
          "exec-out",
          `CLASSPATH=${apkPath}`,
          "app_process",
          "/system/bin",
          HELPER_ENTRY_CLASS,
          ...extraArgs,
        ],
        { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && !stdout && !stderr) reject(new Error(String(error.message)));
          else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        },
      );
    });
  });
}

/**
 * Parse ListMain stdout into renderer-shaped apps.
 * @param {string} text raw JSON line: {"apps":[{"packageName","label","iconPng"?}]}
 */
export function normalizeListOutput(stdout, stderr = "") {
  const raw = String(stdout ?? "");
  // Some ROMs print linker/ART noise around the JSON line; extract the object
  // between the outermost braces instead of parsing the whole stdout.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const detail = [stderr.trim().split("\n").slice(-3).join(" | "), raw.slice(0, 200)]
    .filter(Boolean)
    .join(" ␤ ");
  if (start === -1 || end <= start) {
    throw new Error(`Invalid helper output: ${detail || "(empty)"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error(`Invalid helper output: ${detail}`);
  }
  if (!parsed || !Array.isArray(parsed.apps)) {
    throw new Error(`Invalid helper output: no apps array`);
  }
  return parsed.apps.map((/** @type {any} */ app) => ({
    packageName: typeof app?.packageName === "string" ? app.packageName : "",
    label: typeof app?.label === "string" && app.label ? app.label : "",
    iconUrl:
      typeof app?.iconPng === "string" && app.iconPng
        ? `data:image/png;base64,${app.iconPng}`
        : null,
  }));
}

/** @param {{ packageName: string, label?: string, iconUrl?: string | null }} app */
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

/**
 * Load the installed-app list (labels and icons inline) for one device.
 * The app_process run is one-shot, so this resolves with the complete list.
 * @param {string} serial
 */
async function loadInstalledApps(serial) {
  await ensureServer();
  // 进入首页后再确保 Helper 就绪：未安装则安装，版本不一致则升级
  if (!(await isHelperInstalled(serial))) {
    await installHelper(serial);
  } else {
    await ensureLatestHelper(serial);
  }
  const { stdout } = await runHelperList(serial);
  const apps = uniqueApps(normalizeListOutput(stdout));

  // Phase 1 carries no icons; overlay the ones from the local cache so the
  // renderer can paint a complete-looking list before batch fetching starts.
  const now = Date.now();
  const cache = await readAppCache(serial);
  const cachedByPackage = new Map((cache?.apps || []).map((app) => [app.packageName, app]));
  const merged = apps.map((app) => {
    const cachedIcon = cachedByPackage.get(app.packageName);
    return {
      ...app,
      iconUrl: cachedIcon?.iconUrl || null,
      iconUpdatedAt: cachedIcon?.iconUpdatedAt || null,
    };
  });
  await writeAppCache(serial, snapshot(now, merged));
  return merged;
}

/** Shared snapshot shape for the app cache. */
function snapshot(now, apps) {
  return { authoritativeAt: now, writtenAt: now, apps: [...apps] };
}

/**
 * Fetch icons (base64 PNG data URLs) for one batch of packages — the renderer
 * calls this repeatedly, ~20 packages at a time.
 * @param {string} serial
 * @param {string[]} packages
 */
async function getAppIcons(serial, packages) {
  const { stdout } = await runHelperList(serial, ["--icons", packages.join(",")]);
  const now = Date.now();
  // Stamp the fetch time so the renderer can tell fresh icons from expired ones.
  const fetched = normalizeListOutput(stdout)
    .filter((app) => app.iconUrl)
    .map((app) => ({ ...app, iconUpdatedAt: now }));

  // Persist each batch so the next cold start paints icons immediately.
  const cache = await readAppCache(serial);
  const byPackage = new Map((cache?.apps || []).map((app) => [app.packageName, { ...app }]));
  for (const app of fetched) {
    byPackage.set(app.packageName, {
      ...(byPackage.get(app.packageName) || app),
      iconUrl: app.iconUrl,
      iconUpdatedAt: now,
    });
  }
  await writeAppCache(serial, snapshot(cache?.authoritativeAt || now, [...byPackage.values()]));
  return fetched;
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// 连接设备
ipcMain.handle("adb:connect", async (_, address) => {
  const output = await adbExec("connect", address);
  if (!/connected to /i.test(output)) throw new Error(output || "连接失败");
  return output.trim();
});

// 发现设备
ipcMain.handle("adb:findDevice", findDevice);

// 通过 mDNS 解析设备当前的连接地址（adb-tls-connect 端口，与配对端口不同）
ipcMain.handle("adb:resolveConnectAddress", (_, serial) => resolveConnectAddress(serial));

// 一次性列出当前可连接的设备（供渲染层轮询展示）
ipcMain.handle("adb:listConnectDevices", listConnectDevices);

// 当前已连接（其他工具建立）的设备，供启动时接管
ipcMain.handle("adb:getConnectedDevice", getConnectedDevice);

// 配对设备
ipcMain.handle(CHANNELS.adbPair, async (event, device, password) => {
  return adbExec("pair", device.address, password);
});

// 断开设备：先停掉该设备的 scrcpy 镜像，再断开无线 ADB 传输
ipcMain.handle(CHANNELS.adbDisconnect, async (_, rawSerial) => {
  const serial = normalizeDisconnectSerial(rawSerial);
  stopScrcpy(serial);
  return disconnectTransport(serial);
});

// 安装 Helper
ipcMain.handle("adb:installHelper", async (event, serial) => {
  return installHelper(serial);
});

/**
 * Load the installed-app list for one device. The app_process run is
 * one-shot, so this resolves with the complete list.
 * @param {string} address
 */
ipcMain.handle("adb:loadInstalledApps", async (event, address) => {
  return loadInstalledApps(address);
});

// 批量获取应用图标（渲染层按每组 20 个包名调用）
ipcMain.handle("adb:getAppIcons", async (event, address, packages) => {
  return getAppIcons(address, packages);
});

// 卸载 Helper（部分 ROM 卸载成功也返回 code 1 + Failure，输出仅记录，不作判断）
ipcMain.handle("adb:uninstallHelper", async (event, address) => {
  return uninstallHelper(address);
});

// 清除该设备的应用列表缓存
ipcMain.handle("adb:deleteAppCache", async (event, address) => {
  return deleteAppCache(address);
});

// 读取该设备的应用列表缓存，供界面秒开
ipcMain.handle(CHANNELS.adbGetCachedApps, async (event, address) => {
  return getCachedApps(address);
});

// 通过 scrcpy 启动应用镜像窗口（渲染层只传 { serial, packageName, label }，一条命令启动）
ipcMain.handle(CHANNELS.scrcpyStart, (_, options) => {
  return startScrcpy([
    "-s",
    options.serial,
    "--new-display=1920x1080/320",
    `--start-app=${options.packageName}`,
    "--keep-active",
    "--video-codec=h265",
    "-b",
    "24M",
    "--window-x=auto",
    "--window-y=auto",
    `--window-title=${options.label}`,
  ]);
});
