import { app, dialog, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "./ipcContract.js";
import { browse } from "./mdns.js";
import { pickStableId } from "./deviceIdentity.js";
import { DEFAULT_SCRCPY_CONFIG, normalizeScrcpyConfig } from "./scrcpyConfig.js";
import { sanitizeIcon } from "./iconImage.js";
import helperVersion from "../resources/helper-app.version.json" with { type: "json" };

// 归一化逻辑在 ./scrcpyConfig.js（主进程参数持久化），这里转发导出保持既有引用。
export { DEFAULT_SCRCPY_CONFIG, normalizeScrcpyConfig };

// 图标校验在 ./iconImage.js，应用列表缓存也用它，这里转发导出保持既有引用。
export { sanitizeIcon };

// ---------------------------------------------------------------------------
// 资源路径
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 打包后取 resources 目录，开发环境取项目 ./resources。 */
function resourcesBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
}

export const adbPath = () => path.join(resourcesBase(), "adb", "mac", "adb");
const helperApkPath = () => path.join(resourcesBase(), "helper-app.apk");
export const scrcpyServerPath = () => path.join(resourcesBase(), "scrcpy", "scrcpy-server");

// ---------------------------------------------------------------------------
// ADB 执行
// ---------------------------------------------------------------------------

let serverStarted = false;

/**
 * adb 子进程超时。transport 半死（手机休眠、换地址、Wi-Fi 抖动）时 `adb` 会**一直挂着**：
 * 不退出、不报错，于是调用它的 IPC 永远不返回 —— 界面停在 spinner，重连和提示都无从触发。
 * 这里宁可报「设备无响应」也不能永久卡住。
 */
const ADB_TIMEOUT_MS = 15_000;
/** `adb connect` / `adb pair`：对端不响应时要等 TCP 超时，给得更宽。 */
const ADB_CONNECT_TIMEOUT_MS = 45_000;
/** 安装 / 卸载 / 拉文件是分钟级的正常慢操作，不能用默认超时去掐。 */
const ADB_TRANSFER_TIMEOUT_MS = 5 * 60_000;

/** @typedef {{ timeoutMs?: number }} AdbCallOptions */

/**
 * 把写在最前面的选项对象从 adb 参数里摘出来：
 * `adbExec({ timeoutMs: ADB_TRANSFER_TIMEOUT_MS }, "-s", serial, "install", …)`。
 * @param {(string | AdbCallOptions)[]} args
 * @returns {[AdbCallOptions, string[]]}
 */
function splitCallOptions(args) {
  const first = args[0];
  if (first && typeof first === "object") return [first, args.slice(1)];
  return [{}, args];
}

/**
 * execFile 被超时杀掉的特征：Node 置 `killed`/`signal`，部分版本给 `ETIMEDOUT`。
 * @param {unknown} error
 */
function isAdbTimeoutError(error) {
  if (!error || typeof error !== "object") return false;
  const { killed, code } = /** @type {{ killed?: boolean, code?: unknown }} */ (error);
  return killed === true || code === "ETIMEDOUT";
}

/** 超时对用户来说就是「手机没反应」，文案统一从这里出。 */
const ADB_TIMEOUT_MESSAGE = "设备无响应（命令超时），可能已息屏休眠或换了地址";

/** 超时错误保留 ETIMEDOUT 标记，好让上层（如 getDeviceState）认出这是超时。 */
function adbTimeoutError() {
  return Object.assign(new Error(ADB_TIMEOUT_MESSAGE), { code: "ETIMEDOUT" });
}

export async function ensureServer() {
  if (serverStarted) return;
  await new Promise((resolve, reject) => {
    execFile(adbPath(), ["start-server"], { timeout: ADB_TIMEOUT_MS }, (err) => {
      if (err) reject(err);
      else {
        serverStarted = true;
        resolve();
      }
    });
  });
}

/** @param {...(string | AdbCallOptions)} args */
function adbExec(...args) {
  const [{ timeoutMs = ADB_TIMEOUT_MS }, command] = splitCallOptions(args);
  return new Promise((resolve, reject) => {
    execFile(adbPath(), command, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(isAdbTimeoutError(err) ? adbTimeoutError() : new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Like adbExec but never rejects: resolves with `{ code, stdout, stderr }` so
 * callers can inspect exit codes and device output. adb exits non-zero while
 * still printing a meaningful message (e.g. uninstalling a missing package).
 * 超时也算「有结果」：`timedOut` 为真、`stderr` 是给用户看的中文说明。
 * @param {...(string | AdbCallOptions)} args
 */
function adbExecSafe(...args) {
  const [{ timeoutMs = ADB_TIMEOUT_MS }, command] = splitCallOptions(args);
  return new Promise((resolve) => {
    execFile(adbPath(), command, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const out = stdout?.trim() || "";
      if (!err) {
        resolve({ code: 0, stdout: out, stderr: stderr?.trim() || "" });
        return;
      }
      if (isAdbTimeoutError(err)) {
        resolve({ code: 1, stdout: out, stderr: ADB_TIMEOUT_MESSAGE, timedOut: true });
        return;
      }
      const code = typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: out, stderr: stderr?.trim() || err.message });
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
      warmDeviceStableId(serial);
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
// 连接健康检查与重连
// ---------------------------------------------------------------------------

/**
 * 读取某台设备在 `adb devices` 中的实时状态，用于连接健康检查：
 * - `device`：在线可用
 * - `offline`：仍登记在 adb 中但无法通信（设备休眠 / 网络抖动）
 * - `unauthorized`：未授权
 * - `absent`：transport 已断开，设备从列表消失
 * @param {string} serial
 * @returns {Promise<"device" | "offline" | "unauthorized" | "absent">}
 */
export async function getDeviceState(serial) {
  if (typeof serial !== "string" || !serial) return "absent";
  await ensureServer();
  try {
    return parseAdbDevices(await adbExec("devices")).get(serial) || "absent";
  } catch (error) {
    // 问不到状态就按「离线」上报：心跳与快捷方式都据此走重连分支。
    // 旧行为是让它一直挂着，调用方永远等不到答案。
    if (isAdbTimeoutError(error)) return "offline";
    throw error;
  }
}

/**
 * 从 mDNS 连接服务里解析设备当前可用的 `host:port`，供断线重连使用。
 * @param {string} serial
 * @returns {Promise<string | null>}
 */
async function resolveReconnectAddress(serial) {
  if (typeof serial !== "string" || !serial) return null;
  await ensureServer();
  const services = parseMdnsServices(await adbExec("mdns", "services")).filter(
    (s) => s.type === "_adb-tls-connect._tcp",
  );
  const matched = services.find(
    (s) =>
      s.address === serial || s.name === serial || `${s.name}._adb-tls-connect._tcp` === serial,
  );
  return matched?.address || null;
}

/**
 * 尝试恢复与某台设备的无线连接。设备已在线时直接返回；否则解析可用地址后
 * 重新 `adb connect`。与 disconnectTransport 一致，「已经断开」走幂等成功路径，
 * 由调用方重新读取当前设备。
 * @param {string} serial
 * @returns {Promise<{ online: boolean, address?: string, reason?: string }>}
 */
export async function reconnectDevice(serial) {
  if (typeof serial !== "string" || !serial) return { online: false, reason: "no-serial" };
  if ((await getDeviceState(serial)) === "device") return { online: true, address: serial };

  // 配对场景 serial 本身就是 host:port；发现场景回落到 mDNS 广播的地址。
  const address = /:\d+$/.test(serial) ? serial : await resolveReconnectAddress(serial);
  if (!address) return { online: false, reason: "no-address" };

  const result = await adbExecSafe({ timeoutMs: ADB_CONNECT_TIMEOUT_MS }, "connect", address);
  if (!/connected to /i.test(result.stdout)) {
    return { online: false, reason: result.stderr || result.stdout || "connect-failed" };
  }
  return { online: true, address };
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

/** @param {unknown} value */
function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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

// ---------------------------------------------------------------------------
// 稳定设备标识（背景见 ./deviceIdentity.js）
//
// 持久化键一律用设备自己的序列号，不用 adb 传输地址：无线每次重连地址就换一个，
// 拿地址当键会让收藏 / 应用缓存变成一次性的（用户看到的「重连后收藏没了」）。
// ---------------------------------------------------------------------------

/**
 * 传输地址 → 稳定标识的别名表，**落盘**：冷启动时设备还没连上，读缓存不能依赖 adb，
 * 只能靠上次连上时记下的对应关系。每台设备一行，读不到就当没有（回退传输地址）。
 */
const ALIAS_FILE = () => path.join(app.getPath("userData"), "device-aliases.json");
/** @type {Map<string, string>} transport → stableId */
const stableAliases = new Map();
/** @type {Map<string, Promise<string>>} 解析中的地址，避免并发重复问设备 */
const resolving = new Map();
let aliasesLoaded = false;

function loadAliases() {
  if (aliasesLoaded) return;
  aliasesLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(ALIAS_FILE(), "utf8"));
    for (const [transport, stable] of Object.entries(parsed ?? {})) {
      if (transport && stable && typeof transport === "string" && typeof stable === "string") {
        stableAliases.set(transport, stable);
      }
    }
  } catch {
    // 首次运行或文件损坏：没有别名表也能正常工作
  }
}

async function persistAliases() {
  const file = ALIAS_FILE();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(Object.fromEntries(stableAliases)), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temp, file);
  } catch (error) {
    console.warn("Failed to write device aliases:", error);
  }
}

function rememberAlias(transport, stable) {
  if (!transport || !stable || stable === transport) return;
  if (stableAliases.get(transport) === stable) return;
  stableAliases.set(transport, stable);
  void persistAliases();
}

/**
 * 同步取已知标识，没记录就回传输地址。**读路径用它**：设备还没连上也要能秒开缓存。
 * @param {string} transport
 */
export function stableIdOf(transport) {
  loadAliases();
  return stableAliases.get(transport) || transport;
}

/** 同一个稳定标识下见过的所有传输地址（清缓存时一起清掉）。 */
function aliasesOfStableId(stable) {
  loadAliases();
  const found = [];
  for (const [transport, value] of stableAliases) {
    if (value === stable) found.push(transport);
  }
  return found;
}

/**
 * 向设备问一次稳定标识：`ro.serialno` → `ro.boot.serialno` → `settings secure android_id`。
 * 问不到（掉线、没这台设备）就回传输地址，并且**不写别名表**，下次连上还会再解析。
 * @param {string} serial
 * @returns {Promise<string>}
 */
export async function resolveDeviceStableId(serial) {
  if (typeof serial !== "string" || !serial) return "";
  loadAliases();
  const known = stableAliases.get(serial);
  if (known) return known;
  const pending = resolving.get(serial);
  if (pending) return pending;
  const task = (async () => {
    const { stdout, stderr } = await adbExecSafe(
      "-s",
      serial,
      "shell",
      "getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id",
    );
    const lines = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim());
    const stable = pickStableId(lines.slice(0, 3), serial);
    rememberAlias(serial, stable);
    return stable;
  })().finally(() => resolving.delete(serial));
  resolving.set(serial, task);
  try {
    return await task;
  } catch {
    return serial;
  }
}

/** 设备列表里顺手预热别名（不阻塞返回）。 */
function warmDeviceStableId(serial) {
  void resolveDeviceStableId(serial).catch(() => {});
}

/**
 * 用稳定标识反查**当前**可用的 adb 传输地址。
 *
 * 桌面快捷方式里存的是稳定标识：无线 adb 每重连一次端口就换一个，存地址的快捷方式
 * 当场作废（点开没反应）—— AndroMeld 的 .adrx 里写的就是 `af3d7abd`，所以它一直能点开。
 * @param {string} stableId
 * @returns {Promise<string | null>}
 */
export async function findTransportByStableId(stableId) {
  if (typeof stableId !== "string" || !stableId) return null;
  loadAliases();
  for (const [transport, value] of stableAliases) {
    if (value !== stableId) continue;
    if ((await getDeviceState(transport)) === "device") return transport;
  }
  // 别名表没命中（比如换过端口还没连上）：问一遍在线设备，谁的稳定标识对得上用谁。
  let devices;
  try {
    devices = parseAdbDevices(await adbExec("devices"));
  } catch {
    return null;
  }
  for (const [serial, state] of devices) {
    if (state !== "device" || serial.startsWith("emulator-")) continue;
    if ((await resolveDeviceStableId(serial)) === stableId) return serial;
  }
  return null;
}

/** 读缓存的候选路径：稳定标识优先，再兜住别名还没建立时的旧地址桶。 */
function cacheCandidates(serial) {
  const known = stableIdOf(serial);
  const list = [cachePath(serial)];
  if (known !== serial) list.unshift(cachePath(known));
  for (const other of aliasesOfStableId(known)) {
    if (other !== serial && other !== known) list.push(cachePath(other));
  }
  return list;
}

async function removeFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Failed to remove app cache:", error);
  }
}

export async function readAppCache(serial) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) return null;
  for (const filePath of cacheCandidates(serial)) {
    const snapshot = await readCacheFile(filePath);
    // undefined = 这个路径不可用（没有 / 坏掉 / 过期），继续试下一个候选
    if (snapshot !== undefined) return snapshot;
  }
  return null;
}

/** @returns {Promise<object | undefined>} */
async function readCacheFile(filePath) {
  try {
    const data = await fs.readFile(filePath);
    if (data.length > MAX_SNAPSHOT_BYTES) {
      await removeFile(filePath);
      return undefined;
    }
    const snapshot = sanitizeSnapshot(JSON.parse(data.toString("utf8")));
    if (!snapshot) await removeFile(filePath);
    return snapshot ?? undefined;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("Failed to read app cache:", error);
      await removeFile(filePath);
    }
    return undefined;
  }
}

/** Delete the cached snapshot of one device. Idempotent. */
async function deleteAppCache(serial) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) return false;
  // 同一台设备可能留下过多个地址桶（每次重连一个），一起清干净
  for (const filePath of cacheCandidates(serial)) await removeFile(filePath);
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
  // 写的时候设备必然是连着的，所以这里可以问出真正的稳定标识当键。
  const filePath = cachePath(await resolveDeviceStableId(serial));
  const data = serializeSnapshot(snapshot);
  if (data == null) {
    await removeFile(filePath);
    return false;
  }

  const root = cacheRoot();
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
  const stdout = await adbExec(
    { timeoutMs: ADB_TRANSFER_TIMEOUT_MS },
    "-s",
    serial,
    "install",
    "-r",
    helperApkPath(),
  );
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
  return await adbExecSafe(
    { timeoutMs: ADB_TRANSFER_TIMEOUT_MS },
    "-s",
    serial,
    "uninstall",
    HELPER_PACKAGE,
  );
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
// 应用操作（强制停止 / 清除数据 / 卸载 / 应用信息 / 导出 APK）
// ---------------------------------------------------------------------------

const PACKAGE_NAME_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const MAX_PACKAGE_LENGTH = 512;

/**
 * 校验并规范化包名。所有应用操作都先经过这里，避免把任意字符串带进
 * 设备 shell 命令。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePackageName(value) {
  if (typeof value !== "string") throw new Error("应用包名无效");
  const pkg = value.trim();
  if (!pkg || pkg.length > MAX_PACKAGE_LENGTH || !PACKAGE_NAME_RE.test(pkg)) {
    throw new Error("应用包名无效");
  }
  return pkg;
}

/** @param {unknown} serial */
function assertSerial(serial) {
  if (typeof serial !== "string" || !serial.trim() || serial.length > 1024) {
    throw new Error("设备序列号无效");
  }
  return serial;
}

/**
 * 读取应用的 APK 路径，split APK 会返回多个。
 * @param {string} serial @param {string} packageName
 * @returns {Promise<string[]>}
 */
async function getAppApkPaths(serial, packageName) {
  const output = await adbExecSafe("-s", serial, "shell", "pm", "path", packageName);
  return output.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length).trim())
    .filter(Boolean);
}

/**
 * 应用主窗口当前挂在哪个 root task / 哪块显示上。
 * 镜像要「无缝接回」得先知道应用在不在别的显示（例如被别的投屏软件搬走了）。
 * 应用没在跑（没有带 taskId 的窗口）时返回 null。
 * @param {string} serial
 * @param {string} packageName
 * @returns {Promise<{ taskId: number, displayId: number } | null>}
 */
export async function getAppTask(serial, packageName) {
  assertSerial(serial);
  const pkg = normalizePackageName(packageName);
  await ensureServer();
  const { stdout } = await adbExecSafe(
    "-s",
    serial,
    "shell",
    // 只 grep 需要的那几行，别把整份 dumpsys（几百 KB）拖回本机。
    `dumpsys window windows | grep -E 'Window #.*${pkg}' -A4 | grep -m1 -oE 'mDisplayId=[0-9]+ taskId=[0-9]+'`,
  );
  const match = /mDisplayId=(\d+) taskId=(\d+)/.exec(stdout);
  if (!match) return null;
  return { displayId: Number(match[1]), taskId: Number(match[2]) };
}

/**
 * 把一个 root task 搬到指定显示上 —— **不重启应用**，进程与页面状态都保留，
 * 只是换了块显示（真机量过：搬回来后 pid 不变，窗口尺寸等于新显示）。
 * @param {string} serial
 * @param {number} taskId
 * @param {number} displayId
 */
export async function moveAppTaskToDisplay(serial, taskId, displayId) {
  assertSerial(serial);
  const task = Number(taskId);
  const display = Number(displayId);
  if (!Number.isInteger(task) || !Number.isInteger(display) || task <= 0 || display < 0) {
    throw new Error("任务或显示编号无效");
  }
  await ensureServer();
  const { code, stderr, stdout } = await adbExecSafe(
    "-s",
    serial,
    "shell",
    `am display move-stack ${task} ${display}`,
  );
  // 命令成功时没有输出；失败通常是 `Exception ... Unknown displayId`，按文本 + 退出码判。
  const output = `${stdout}\n${stderr}`;
  if (code !== 0 || /exception|error|unknown/i.test(output)) {
    throw new Error(output.trim() || "搬移任务到该显示失败");
  }
  return true;
}

/**
 * 设备物理分辨率（`wm size` 的 `Physical size:` 行），用来决定镜像窗口的初始形状。
 * 取不到就返回 null，调用方走兜底比例。
 * @param {string} serial
 * @returns {Promise<{ width: number, height: number } | null>}
 */
export async function getPhysicalScreenSize(serial) {
  assertSerial(serial);
  await ensureServer();
  const { stdout, stderr } = await adbExecSafe("-s", serial, "shell", "wm size");
  const match = /Physical size:\s*(\d+)x(\d+)/.exec(`${stdout}\n${stderr}`);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * 用 launcher intent 把应用拉到前台（不指定 activity，包名通用）。
 * @param {string} serial
 * @param {string} packageName
 */
export async function launchApp(serial, packageName) {
  assertSerial(serial);
  const pkg = normalizePackageName(packageName);
  await ensureServer();
  const { code, stderr } = await adbExecSafe(
    "-s",
    serial,
    "shell",
    `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
  );
  if (code !== 0) throw new Error(stderr || "启动应用失败");
  return true;
}

/** 强制停止应用。 */
export async function forceStopApp(serial, packageName) {
  assertSerial(serial);
  const pkg = normalizePackageName(packageName);
  await ensureServer();
  const { code, stderr } = await adbExecSafe("-s", serial, "shell", "am", "force-stop", pkg);
  if (code !== 0) throw new Error(stderr || "强制停止失败");
  return true;
}

/** 清除应用数据。 */
async function clearAppData(serial, packageName) {
  assertSerial(serial);
  const pkg = normalizePackageName(packageName);
  await ensureServer();
  const { code, stdout, stderr } = await adbExecSafe("-s", serial, "shell", "pm", "clear", pkg);
  if (code !== 0 || !/success/i.test(stdout)) {
    throw new Error(stderr || stdout || "清除应用数据失败");
  }
  return true;
}

/** 卸载应用。部分 ROM 成功也返回非零，输出含 Success 即视为成功。 */
async function uninstallApp(serial, packageName) {
  assertSerial(serial);
  const pkg = normalizePackageName(packageName);
  await ensureServer();
  const { code, stdout, stderr } = await adbExecSafe(
    { timeoutMs: ADB_TRANSFER_TIMEOUT_MS },
    "-s",
    serial,
    "uninstall",
    pkg,
  );
  if (code !== 0 && !/success/i.test(stdout)) {
    throw new Error(stderr || stdout || "卸载失败");
  }
  return true;
}

/**
 * 读取应用信息（版本、SDK、安装/更新时间、安装来源、APK 路径）。
 * @param {string} serial @param {string} packageName
 */
async function getAppInfo(serial, packageName) {
  assertSerial(serial);
  const pkg = normalizePackageName(packageName);
  await ensureServer();
  const [dump, apkPaths] = await Promise.all([
    adbExecSafe("-s", serial, "shell", "dumpsys", "package", pkg),
    getAppApkPaths(serial, pkg),
  ]);
  const text = dump.stdout;
  const pick = (pattern) => {
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
  };
  const versionAndSdk = text.match(/versionCode=(\d+)\s+minSdk=(\d+)\s+targetSdk=(\d+)/);
  return {
    packageName: pkg,
    versionName: pick(/versionName=(\S+)/),
    versionCode: versionAndSdk ? Number(versionAndSdk[1]) : null,
    minSdk: versionAndSdk ? Number(versionAndSdk[2]) : null,
    targetSdk: versionAndSdk ? Number(versionAndSdk[3]) : null,
    firstInstallTime: pick(/firstInstallTime=([^\n]+)/),
    lastUpdateTime: pick(/lastUpdateTime=([^\n]+)/),
    installerPackageName: pick(/installerPackageName=(\S+)/),
    apkPaths,
  };
}

/**
 * 导出应用 APK：弹目录选择框，再用 adb pull 把 base/split APK 拉到该目录。
 * @param {string} serial @param {string} packageName
 * @returns {Promise<{ canceled: boolean, dir?: string, files?: string[] }>}
 */
async function exportApk(serial, packageName) {
  assertSerial(serial);
  const pkg = normalizePackageName(packageName);
  await ensureServer();
  const apkPaths = await getAppApkPaths(serial, pkg);
  if (!apkPaths.length) throw new Error("未找到应用的 APK 文件");

  const choice = await dialog.showOpenDialog({
    title: "选择导出目录",
    buttonLabel: "导出到此处",
    properties: ["openDirectory", "createDirectory"],
  });
  if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true };

  const dir = choice.filePaths[0];
  const files = [];
  for (const remote of apkPaths) {
    const name = path.posix.basename(remote);
    const destination = path.join(dir, name);
    const result = await adbExecSafe(
      { timeoutMs: ADB_TRANSFER_TIMEOUT_MS },
      "-s",
      serial,
      "pull",
      remote,
      destination,
    );
    const pulled = /(\d+) files? pulled/i.exec(result.stdout);
    if (result.code !== 0 || !pulled || Number(pulled[1]) === 0) {
      throw new Error(result.stderr || result.stdout || `导出 ${name} 失败`);
    }
    files.push(name);
  }
  return { canceled: false, dir, files };
}

// ---------------------------------------------------------------------------
// 设备信息（型号 / 系统 / 存储 / 电量 / 网络 / CPU / 内存）
// ---------------------------------------------------------------------------

const STATS_CACHE_TTL_MS = 30 * 1000;
/** serial → { at, data }；刷新时 force 跳过缓存。 */
const deviceStatsCache = new Map();

/** `[key]: [value]` 形式的 getprop 输出解析为 Map。 */
function parseGetprop(output) {
  const props = new Map();
  const re = /\[([^\]]+)\]:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = re.exec(output || ""))) props.set(match[1], match[2]);
  return props;
}

function pickProp(props, ...keys) {
  for (const key of keys) {
    const value = props.get(key);
    if (value) return value;
  }
  return null;
}

/** 从 serial（host:port）提取 IPv4，USB serial 返回 null。 */
function hostFromSerial(serial) {
  if (typeof serial !== "string") return null;
  const host = serial.split(":")[0];
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
}

/** `df -k` 输出解析为字节数；优先 /data，其次最后一行。 */
function parseStorage(output) {
  const lines = (output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((item) => /\s\/data$/.test(item)) || lines[lines.length - 1];
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 5) return null;
  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);
  const availKb = Number(parts[3]);
  if (!Number.isFinite(totalKb) || totalKb <= 0) return null;
  const percent = Number.parseInt(parts[4], 10);
  return {
    totalBytes: totalKb * 1024,
    usedBytes: Number.isFinite(usedKb) ? usedKb * 1024 : null,
    availableBytes: Number.isFinite(availKb) ? availKb * 1024 : null,
    percentUsed: Number.isFinite(percent) ? percent : null,
  };
}

const BATTERY_STATUS = {
  1: "unknown",
  2: "charging",
  3: "discharging",
  4: "notCharging",
  5: "full",
};

/** `dumpsys battery` 输出解析。 */
function parseBattery(output) {
  const text = output || "";
  const pick = (key) => {
    const match = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "mi"));
    return match ? match[1].trim() : null;
  };
  const level = Number.parseInt(pick("level") ?? "", 10);
  const status = Number.parseInt(pick("status") ?? "", 10);
  const temperature = Number.parseInt(pick("temperature") ?? "", 10);
  const powered = ["AC powered", "USB powered", "Wireless powered"].some((key) =>
    /true/i.test(pick(key) || ""),
  );
  return {
    level: Number.isFinite(level) ? level : null,
    status: BATTERY_STATUS[status] || null,
    temperatureC: Number.isFinite(temperature) ? temperature / 10 : null,
    charging: powered || status === 2 || status === 5,
  };
}

/** `/proc/meminfo` 输出解析为字节数。 */
function parseMemory(output) {
  const read = (key) => {
    const match = (output || "").match(new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, "mi"));
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = read("MemTotal");
  const availableBytes = read("MemAvailable");
  if (totalBytes == null) return null;
  return {
    totalBytes,
    availableBytes,
    usedBytes: availableBytes != null ? totalBytes - availableBytes : null,
  };
}

/** `cat /proc/loadavg; echo ---; nproc; echo ###; grep Hardware` 输出解析。 */
function parseCpu(output) {
  const [loadRaw, restRaw] = (output || "").split("---");
  const [coresRaw, hardwareRaw] = (restRaw || "").split("###");
  const loadMatch = (loadRaw || "").trim().match(/^[\d.]+/);
  const load1 = loadMatch ? Number.parseFloat(loadMatch[0]) : null;
  const cores = Number.parseInt((coresRaw || "").trim(), 10);
  const hardware = (hardwareRaw || "").match(/hardware\s*:\s*(.+)/i);
  return {
    load1: Number.isFinite(load1) ? load1 : null,
    cores: Number.isFinite(cores) ? cores : null,
    hardware: hardware ? hardware[1].trim() : null,
  };
}

/** `ip -o -4 addr` 输出解析，优先 wlan 接口，其次 serial 主机。 */
function parseNetwork(output, fallbackIp) {
  const candidates = [];
  for (const line of (output || "").split("\n")) {
    const ip = line.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)\//);
    if (!ip) continue;
    const iface = line.match(/^\s*\d+:\s+([^\s:@]+)/);
    candidates.push({ ip: ip[1], interface: iface ? iface[1] : null });
  }
  const wifi = candidates.find((item) => item.interface && /^wlan/i.test(item.interface));
  const chosen = wifi || candidates.find((item) => item.interface && item.interface !== "lo") || null;
  return {
    ip: chosen?.ip || fallbackIp || null,
    interface: chosen?.interface || null,
  };
}

/**
 * 将原始命令输出解析为结构化设备信息（纯函数，便于测试）。
 * @param {{ props?: string, storage?: string, battery?: string, memory?: string, cpu?: string, network?: string }} raw
 * @param {string} [serial]
 */
export function parseDeviceStats(raw, serial) {
  const props = parseGetprop(raw?.props || "");
  const cpu = parseCpu(raw?.cpu || "");
  const sdk = Number.parseInt(pickProp(props, "ro.build.version.sdk") || "", 10);
  return {
    model: pickProp(props, "ro.product.model", "ro.product.vendor.model"),
    brand: pickProp(props, "ro.product.brand"),
    manufacturer: pickProp(props, "ro.product.manufacturer"),
    androidVersion: pickProp(props, "ro.build.version.release"),
    sdk: Number.isFinite(sdk) ? sdk : null,
    cpu: {
      model: pickProp(props, "ro.soc.model", "ro.soc.manufacturer", "ro.board.platform") || cpu.hardware,
      cores: cpu.cores,
      load1: cpu.load1,
    },
    memory: parseMemory(raw?.memory || ""),
    storage: parseStorage(raw?.storage || ""),
    battery: parseBattery(raw?.battery || ""),
    network: parseNetwork(raw?.network || "", hostFromSerial(serial)),
  };
}

/** 采集原始设备信息并解析；缓存 30s，force 时刷新。 */
async function getDeviceStats(serial, force = false) {
  assertSerial(serial);
  const cached = deviceStatsCache.get(serial);
  if (!force && cached && Date.now() - cached.at < STATS_CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }
  await ensureServer();

  const cpuScript =
    "cat /proc/loadavg; echo ---; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo; echo ###; grep -m1 -i hardware /proc/cpuinfo";
  const [propRes, dfRes, batteryRes, memRes, cpuRes, netRes] = await Promise.all([
    adbExecSafe("-s", serial, "shell", "getprop"),
    adbExecSafe("-s", serial, "shell", "df", "-k", "/data"),
    adbExecSafe("-s", serial, "shell", "dumpsys", "battery"),
    adbExecSafe("-s", serial, "shell", "cat", "/proc/meminfo"),
    adbExecSafe("-s", serial, "shell", cpuScript),
    adbExecSafe("-s", serial, "shell", "ip -o -4 addr 2>/dev/null"),
  ]);

  let storageRaw = dfRes.stdout;
  if (!storageRaw) {
    const rootRes = await adbExecSafe("-s", serial, "shell", "df", "-k", "/");
    storageRaw = rootRes.stdout;
  }
  if (propRes.code !== 0 && !propRes.stdout) {
    throw new Error(propRes.stderr || "读取设备信息失败");
  }

  const data = {
    serial,
    ...parseDeviceStats(
      {
        props: propRes.stdout,
        storage: storageRaw,
        battery: batteryRes.stdout,
        memory: memRes.stdout,
        cpu: cpuRes.stdout,
        network: netRes.stdout,
      },
      serial,
    ),
    updatedAt: Date.now(),
  };
  deviceStatsCache.set(serial, { at: Date.now(), data });
  return { ...data, cached: false };
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// 连接设备
ipcMain.handle(CHANNELS.adbConnect, async (_, address) => {
  const output = await adbExec({ timeoutMs: ADB_CONNECT_TIMEOUT_MS }, "connect", address);
  if (!/connected to /i.test(output)) throw new Error(output || "连接失败");
  return output.trim();
});

// 发现设备
ipcMain.handle(CHANNELS.adbFindDevice, findDevice);

// 通过 mDNS 解析设备当前的连接地址（adb-tls-connect 端口，与配对端口不同）
ipcMain.handle(CHANNELS.adbResolveConnectAddress, (_, serial) => resolveConnectAddress(serial));

// 一次性列出当前可连接的设备（供渲染层轮询展示）
ipcMain.handle(CHANNELS.adbListConnectDevices, listConnectDevices);

// 当前已连接（其他工具建立）的设备，供启动时接管
ipcMain.handle(CHANNELS.adbGetConnectedDevice, getConnectedDevice);

// 连接健康检查：读取单台设备的实时状态（device / offline / unauthorized / absent）
ipcMain.handle(CHANNELS.adbGetDeviceState, (_, serial) => getDeviceState(serial));

// 断线重连：设备在线幂等返回，否则解析 mDNS 地址后重新 adb connect
ipcMain.handle(CHANNELS.adbReconnect, (_, serial) => reconnectDevice(serial));

// 配对设备
ipcMain.handle(CHANNELS.adbPair, async (event, device, password) => {
  return adbExec({ timeoutMs: ADB_CONNECT_TIMEOUT_MS }, "pair", device.address, password);
});

/**
 * 设备级清理钩子：断开连接或退出时执行（自研镜像会话等）。
 * 放在这里是为了让 adb.js 不用反向依赖 mirror 模块。
 * @type {Set<(serial?: string) => unknown>}
 */
const deviceTeardownHooks = new Set();

/**
 * 注册设备清理钩子，返回取消函数。
 * @param {(serial?: string) => unknown} hook
 */
export function onDeviceTeardown(hook) {
  deviceTeardownHooks.add(hook);
  return () => deviceTeardownHooks.delete(hook);
}

/**
 * 执行所有清理钩子；无 serial 表示整体退出。等待异步钩子完成。
 * @param {string} [serial]
 */
export async function runDeviceTeardown(serial) {
  await Promise.all(
    [...deviceTeardownHooks].map(async (hook) => {
      try {
        await hook(serial);
      } catch (error) {
        console.warn("AndDrive: 设备清理钩子失败：", error?.message || error);
      }
    }),
  );
}

// 断开设备：先停掉该设备的镜像会话，再断开无线 ADB 传输
ipcMain.handle(CHANNELS.adbDisconnect, async (_, rawSerial) => {
  const serial = normalizeDisconnectSerial(rawSerial);
  await runDeviceTeardown(serial);
  deviceStatsCache.delete(serial);
  return disconnectTransport(serial);
});

// 安装 Helper
ipcMain.handle(CHANNELS.adbInstallHelper, async (event, serial) => {
  return installHelper(serial);
});

/**
 * Load the installed-app list for one device. The app_process run is
 * one-shot, so this resolves with the complete list.
 * @param {string} address
 */
ipcMain.handle(CHANNELS.adbLoadInstalledApps, async (event, address) => {
  return loadInstalledApps(address);
});

// 批量获取应用图标（渲染层按每组 20 个包名调用）
ipcMain.handle(CHANNELS.adbGetAppIcons, async (event, address, packages) => {
  return getAppIcons(address, packages);
});

// 卸载 Helper（部分 ROM 卸载成功也返回 code 1 + Failure，输出仅记录，不作判断）
ipcMain.handle(CHANNELS.adbUninstallHelper, async (event, address) => {
  return uninstallHelper(address);
});

// 清除该设备的应用列表缓存
ipcMain.handle(CHANNELS.adbDeleteAppCache, async (event, address) => {
  return deleteAppCache(address);
});

// 读取该设备的应用列表缓存，供界面秒开
ipcMain.handle(CHANNELS.adbGetCachedApps, async (event, address) => {
  return getCachedApps(address);
});

// 应用操作：强制停止 / 清除数据 / 卸载 / 应用信息 / 导出 APK
ipcMain.handle(CHANNELS.adbForceStop, (_, serial, pkg) => forceStopApp(serial, pkg));
ipcMain.handle(CHANNELS.mirrorAppTask, (_, serial, pkg) => getAppTask(serial, pkg));
ipcMain.handle(CHANNELS.mirrorMoveTask, (_, serial, taskId, displayId) =>
  moveAppTaskToDisplay(serial, taskId, displayId),
);
ipcMain.handle(CHANNELS.adbClearData, (_, serial, pkg) => clearAppData(serial, pkg));
ipcMain.handle(CHANNELS.adbUninstallApp, (_, serial, pkg) => uninstallApp(serial, pkg));
ipcMain.handle(CHANNELS.adbAppInfo, (_, serial, pkg) => getAppInfo(serial, pkg));
ipcMain.handle(CHANNELS.adbExportApk, (_, serial, pkg) => exportApk(serial, pkg));

// 设备信息：型号 / 系统 / 存储 / 电量 / 网络 / CPU / 内存（force=true 跳过缓存）
ipcMain.handle(CHANNELS.adbGetDeviceStats, (_, serial, force) => getDeviceStats(serial, force === true));
