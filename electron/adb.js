import { app, dialog, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "./ipcContract.js";
import { browse } from "./mdns.js";
import { pickStableId } from "./deviceIdentity.js";
import { parseEncoderMimes, VIDEO_ENCODER_PROBE_CMD } from "../shared/scrcpyConfig.js";
import { iconPngBuffer, MAX_ICON_BYTES, PNG_DATA_URL_PREFIX } from "./iconImage.js";
import helperVersion from "../resources/helper-app.version.json" with { type: "json" };

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
/** 在途的 `start-server`；并发调用共用它，避免同时 fork 多个 adb 抢 5037。 */
let pendingServerStart = null;

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

/**
 * 起 adb 守护进程。**并发调用必须共用同一次启动**：标记要等 `start-server` 返回才置位，
 * 这段时间里每个调用者都会各自 fork 一个 adb，第二个会死在
 * `could not install *smartsocket* listener: Address already in use` → `ADB server didn't ACK`
 * → 上层报「发现设备失败」（真机踩过）。失败时清空在途 promise，让后续调用能重试。
 */
export function ensureServer() {
  if (serverStarted) return Promise.resolve();
  pendingServerStart ??= new Promise((resolve, reject) => {
    execFile(adbPath(), ["start-server"], { timeout: ADB_TIMEOUT_MS }, (err) => {
      pendingServerStart = null;
      if (err) {
        reject(err);
        return;
      }
      serverStarted = true;
      resolve();
    });
  });
  return pendingServerStart;
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
export function adbExecSafe(...args) {
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
 * serial 是否是 USB（有线）传输：不是 `host:port`、不是无线调试的 mDNS 实例名、
 * 不是模拟器。USB serial 天然稳定（不像无线地址每次重连就换）。
 * @param {unknown} serial
 * @returns {boolean}
 */
export function isUsbSerial(serial) {
  if (typeof serial !== "string" || !serial.trim()) return false;
  if (serial.includes(":") || serial.includes("._adb-tls-connect._tcp")) return false;
  if (serial.startsWith("emulator-")) return false;
  return true;
}

/** 传输类型：USB 有线，其余（无线调试 / 老式 tcpip）按无线处理。 */
export function deviceTransport(serial) {
  return isUsbSerial(serial) ? "usb" : "wifi";
}

/**
 * Disconnect an ADB transport. Missing transports are idempotent.
 * USB 没有 tcp transport：`adb disconnect <serial>` 会把 USB 传输直接摘掉，
 * 而且 adb 不会自己恢复（要 kill-server 或重插才行），所以有线设备只做幂等成功，
 * 真正的「停用」由调用方的设备级清理（镜像、缓存）完成。
 * @param {string} serial
 */
async function disconnectTransport(serial) {
  if (isUsbSerial(serial)) return true;
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

const ADB_DEVICE_LINE_RE = /^(\S+)\s+(device|offline|unauthorized|authorizing|connecting)\b/;

/**
 * 解析 `adb devices` 输出，返回 serial → 状态。
 * 无线调试自动连接后 serial 形如 `adb-XXXX._adb-tls-connect._tcp`，
 * 手动 connect 后形如 `192.168.1.5:37000`，USB 有线则是设备自己的序列号
 * （形如 `fb637d72` / `R58M1234567`，不含冒号）。
 * `authorizing` / `connecting` 是 USB 插入到可用之间的过渡态，也要认出来，
 * 否则等待授权的手机在界面上完全不出现。
 * @param {string} output
 * @returns {Map<string, string>}
 */
export function parseAdbDevices(output) {
  const devices = new Map();
  for (const line of String(output ?? "").split("\n")) {
    const match = line.trim().match(ADB_DEVICE_LINE_RE);
    if (match) devices.set(match[1], match[2]);
  }
  return devices;
}

// 递增令牌用于取消上一次仍在轮询的发现，语义与旧浏览器 stop 后 promise 悬挂一致。
let discoveryToken = 0;

/**
 * 轮询 `adb mdns services`，直到出现指定类型的服务。
 * @param {string} serviceType 如 `_adb-tls-pairing._tcp`
 * @param {{ token?: string, host?: string }} [hint] 目标设备线索（见 matchServiceScore）
 * @returns {Promise<{ name: string, type: string, address: string }>}
 */
async function waitForMdnsService(serviceType, hint) {
  const token = ++discoveryToken;
  await ensureServer();
  while (token === discoveryToken) {
    const output = await adbExec("mdns", "services");
    if (token !== discoveryToken) break;
    const service = pickMdnsService(parseMdnsServices(output), serviceType, hint);
    if (service) return service;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return new Promise(() => null);
}

/**
 * mDNS 服务实例名里的设备标识段：`adb-af3d7abd` / `adb-af3d7abd-Zvci5V` → `af3d7abd`。
 * 尾串是每次开无线调试现编的随机值，不能参与比较。
 * @param {unknown} name
 */
export function serviceDeviceToken(name) {
  const value = String(name ?? "").split("._adb-")[0].trim();
  if (!value.startsWith("adb-")) return "";
  const parts = value.slice(4).split("-");
  return parts[0] === "" ? "" : parts[0].toLowerCase();
}

/**
 * 多台设备同时广播时，「第一个匹配的服务」可能属于另一台（旧 D7）。
 * 这里用两个独立信号打分：
 * - **设备标识段相同** —— 最硬，同一台机器配对端口与连接端口共用它。
 * - **主机 IP 相同** —— 同机的 pairing/connect 通常只是端口不同；跨设备只有整个
 *   局域网共用一个 IP 时才会误伤，那种情况下本来也分不出主次。
 * 两条线索都缺时退回「第一个」（与旧行为一致）：宁可不做，也不要让配对卡死。
 * @param {{ name?: string, address?: string }} service
 * @param {{ token?: string, host?: string }} hint
 */
export function matchServiceScore(service, hint) {
  if (hint.token && serviceDeviceToken(service.name) === hint.token) return 3;
  if (hint.host && String(service.address).split(":")[0] === hint.host) return 2;
  return 0;
}

/**
 * 从已解析的服务里挑目标设备的那一条。纯函数，便于单测（旧行为 = 无 hint 时取第一个）。
 * @param {{ name: string, type: string, address: string }[]} services
 * @param {string} serviceType
 * @param {{ token?: string, host?: string }} [hint]
 */
export function pickMdnsService(services, serviceType, hint) {
  const matching = services.filter((s) => s.type === serviceType);
  if (!hint?.token && !hint?.host) return matching[0];
  return [...matching].sort(
    (a, b) => matchServiceScore(b, hint) - matchServiceScore(a, hint),
  )[0];
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
 * @param {{ name?: unknown, address?: unknown }} [pairingService] 刚才配对那台的服务，
 *   用来在多台同时广播时锁定同一台（不可信输入，内部再校验）
 * @returns {Promise<{name: string, address: string}>}
 */
async function resolveConnectAddress(pairingService) {
  return waitForMdnsService("_adb-tls-connect._tcp", connectHintFromPairing(pairingService));
}

/** 从配对服务条目提出「这就是那台设备」的两条线索。 */
function connectHintFromPairing(pairingService) {
  const name =
    typeof pairingService?.name === "string" && pairingService.name.length <= 256
      ? pairingService.name
      : "";
  const address =
    typeof pairingService?.address === "string" && pairingService.address.length <= 256
      ? pairingService.address
      : "";
  return {
    token: serviceDeviceToken(name),
    host: address ? address.split(":")[0].trim() : "",
  };
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
 * `transport` 区分有线 / 无线：USB 直插的设备没有 mDNS 条目，展示与断开逻辑都按它分支。
 * 未授权（unauthorized）也返回，`connected: false` 供界面提示「在手机上点允许」。
 * @returns {Promise<{ name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: "usb" | "wifi" }[]>}
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
    ([serial]) => !serial.startsWith("emulator-"),
  );

  return Promise.all(
    entries.map(async ([serial, state]) => {
      const svc = bySerial.get(serial);
      if (state === "device") warmDeviceStableId(serial);
      // 没授权的设备 shell 读什么都失败，直接不读，别让标签和名字一起卡住。
      const label =
        state === "device"
          ? (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null
          : null;
      return {
        name: svc?.name || serial,
        // USB 直插没有 mDNS 服务条目，不硬塞一个无线服务类型骗界面。
        type: svc?.type || "",
        address: serial,
        displayAddress: svc?.address || serial,
        label,
        connected: state === "device",
        state,
        transport: deviceTransport(serial),
      };
    }),
  );
}

/**
 * 返回当前 adb 已连接（状态 device）的设备，供启动时接管其他工具
 * （Android Studio / 终端 adb 等）已建立的连接。优先无线设备，
 * address 用 adb 的 serial，可直接用于后续 `adb -s`。
 * @returns {Promise<{ name: string, address: string, displayAddress: string, label: string | null, transport: "usb" | "wifi" } | null>}
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
  return { name, address, displayAddress, label, transport: deviceTransport(address) };
}

// ---------------------------------------------------------------------------
// 连接健康检查与重连
// ---------------------------------------------------------------------------

/**
 * 读取某台设备在 `adb devices` 中的实时状态，用于连接健康检查：
 * - `device`：在线可用
 * - `offline`：仍登记在 adb 中但无法通信（设备休眠 / 网络抖动）
 * - `unauthorized` / `authorizing`：未授权或正在等手机上点「允许」（USB 插入常见）
 * - `connecting`：transport 正在建立
 * - `absent`：transport 已断开，设备从列表消失（USB 场景 = 数据线被拔）
 * @param {string} serial
 * @returns {Promise<"device" | "offline" | "unauthorized" | "authorizing" | "connecting" | "absent">}
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
 * 尝试恢复与某台设备的连接。设备已在线时直接返回；无线设备解析可用地址后
 * 重新 `adb connect`。与 disconnectTransport 一致，「已经断开」走幂等成功路径，
 * 由调用方重新读取当前设备。
 *
 * USB 没有地址可 connect：不在列表里就是被拔了（等重新插入），还在列表里但
 * offline / 未授权则踢一次 host 侧连接，让 adb 重新枚举它。
 * @param {string} serial
 * @returns {Promise<{ online: boolean, address?: string, reason?: string }>}
 */
export async function reconnectDevice(serial) {
  if (typeof serial !== "string" || !serial) return { online: false, reason: "no-serial" };
  const state = await getDeviceState(serial);
  if (state === "device") return { online: true, address: serial };

  if (isUsbSerial(serial)) {
    if (state === "absent") return { online: false, reason: "usb-absent" };
    await adbExecSafe("-s", serial, "reconnect");
    const again = await getDeviceState(serial);
    return again === "device"
      ? { online: true, address: serial }
      : { online: false, reason: again || state };
  }

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
  // 图标不进快照：它在 icons-v1/ 里单独成文件，「有没有 / 什么时候拿的」由文件 mtime 说。
  // 快照里出现的任何 iconUrl 一律挡成 null（O6 之后没人再写它）。
  return { packageName: entry.packageName, label, iconUrl: null, iconUpdatedAt: null };
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
  // 图标拆到文件后快照只剩标签，正常情况下远够不到上限；这条判断是兜底，
  // 以前的「超限就把图标全清空」分支已经没有意义（里面根本不再有图标）。
  const data = JSON.stringify(sanitized);
  return Buffer.byteLength(data) <= MAX_SNAPSHOT_BYTES ? data : null;
}

const cacheRoot = () => path.join(app.getPath("userData"), "app-cache", "apps-v1");
const cacheKey = (serial) => createHash("sha256").update(serial).digest("hex");
const cachePath = (serial) => path.join(cacheRoot(), `${cacheKey(serial)}.json`);

// ---------------------------------------------------------------------------
// 图标落盘（O6）：图标 PNG 单独成文件，缓存 JSON 只存元数据。
//
// 原先图标以 base64 内联在快照里，后果是：一台 300 应用设备的缓存 JSON 能涨到几十 MB，
// 而**每一个图标批次都要「读整份 → 改 → 序列化整份 → 重写整份」**（D4 的丢写正是这么来的，
// 每批还要为改 20 条而 parse 一次 3000 条）。拆成文件后：一批只写自己那几个 png。
//
// 不用 `file://` 直接给 <img> 用：dev 页面是 http://localhost，Electron 默认
// webSecurity 会拦 http 页里的 file 资源，等于开发环境图标全瞎。所以读侧在主进程
// 拼回 data URL —— 冷启动一次 IPC 的体积和以前相当，但不再有整份 JSON 的读写放大。
// ---------------------------------------------------------------------------

const ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 同时打开的图标文件数：一台 3000 应用全量补齐时不要把 FD 一口气吃光。 */
const ICON_READ_CONCURRENCY = 32;
/** 每个设备目录一小时内最多清一次，别让 150 个图标批次各自扫全目录。 */
const ICON_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** @type {Map<string, number>} dir → 上次 prune 的时间 */
const iconPrunedAt = new Map();

const iconRoot = () => path.join(app.getPath("userData"), "app-cache", "icons-v1");
const iconDir = (stable) => path.join(iconRoot(), cacheKey(stable));
const iconFileFrom = (dir, packageName) => path.join(dir, `${cacheKey(packageName)}.png`);

/**
 * 图标目录的两个候选：稳定标识，以及别名还没建立时写入用的传输地址（同一台机器在
 * 建立别名前后会各留一份，所以两边都要认）。**不再**扫该设备历史上所有传输地址的桶 ——
 * 那是 stable-id 键之前留下的旧数据，已按「不兼容老用户」删除。
 */
function iconDirs(serial) {
  const stable = stableIdOf(serial);
  const dirs = [iconDir(stable)];
  const byAddress = iconDir(serial);
  if (!dirs.includes(byAddress)) dirs.push(byAddress);
  return dirs;
}

/** 写入一批图标，返回成功落盘的包名；单张失败只丢那张，不影响整批。 */
export async function writeIconFiles(stable, entries) {
  const dir = iconDir(stable);
  const written = [];
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    console.warn("Failed to create icon cache dir:", error);
    return written;
  }
  await Promise.all(
    entries.map(async ({ packageName, dataUrl }) => {
      const png = iconPngBuffer(dataUrl);
      if (!png || !packageName || packageName.length > 512) return;
      const filePath = iconFileFrom(dir, packageName);
      const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await fs.writeFile(tempPath, png, { mode: 0o600 });
        await fs.rename(tempPath, filePath);
        written.push(packageName);
      } catch (error) {
        console.warn("Failed to write icon:", error);
        await removeFile(tempPath);
      }
    }),
  );
  if (Date.now() - (iconPrunedAt.get(dir) ?? 0) > ICON_PRUNE_INTERVAL_MS) {
    iconPrunedAt.set(dir, Date.now());
    await pruneIconFiles(dir);
  }
  return written;
}

/**
 * 列出目录里已有的图标：`文件名 → mtime`。
 * 一次 readdir 加一批 stat，取代「每个应用一次 open」—— 整表补齐时这是 3000 次 vs 1 次的差别。
 */
async function listIconFiles(dir) {
  const index = new Map();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return index; // 还没建过图标目录
  }
  const pngs = entries.filter((e) => e.isFile() && e.name.endsWith(".png"));
  await Promise.all(
    pngs.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      try {
        const stats = await fs.stat(filePath);
        index.set(entry.name, { filePath, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        // 刚被 prune 掉，忽略
      }
    }),
  );
  return index;
}

/**
 * 读本地图标（**不问设备**）。返回 `{ 包名: { dataUrl, updatedAt } }`；过期的不给
 * （交给正常刷新流程）。mtime 就是「什么时候拿的」—— 快照里不再存图标时间。
 */
export async function readIconFiles(serial, packages) {
  const list = Array.isArray(packages) ? packages : [];
  /** @type {Map<string, string>} 文件名 → 包名（磁盘上只有哈希，回给调用方要还原） */
  const wanted = new Map();
  for (const packageName of list) {
    if (typeof packageName === "string" && packageName && packageName.length <= 512) {
      wanted.set(`${cacheKey(packageName)}.png`, packageName);
    }
  }
  if (wanted.size === 0) return {};

  // 同名文件在多个候选目录里时，先出现的目录赢（iconDirs 已按稳定标识排在前）。
  const found = new Map();
  for (const dir of iconDirs(serial)) {
    const index = await listIconFiles(dir);
    for (const [name, hit] of index) {
      if (wanted.has(name) && !found.has(name)) found.set(name, hit);
    }
  }

  const now = Date.now();
  const fresh = [...found].filter(([, hit]) => {
    return now - hit.mtimeMs <= ICON_TTL_MS && hit.size <= MAX_ICON_BYTES;
  });

  const out = {};
  for (let i = 0; i < fresh.length; i += ICON_READ_CONCURRENCY) {
    const chunk = fresh.slice(i, i + ICON_READ_CONCURRENCY);
    const buffers = await Promise.all(
      chunk.map(([, hit]) => fs.readFile(hit.filePath).catch(() => null)),
    );
    chunk.forEach(([name, hit], offset) => {
      const png = buffers[offset];
      if (!png) return;
      out[wanted.get(name)] = {
        dataUrl: `${PNG_DATA_URL_PREFIX}${png.toString("base64")}`,
        updatedAt: hit.mtimeMs,
      };
    });
  }
  return out;
}

/** 图标目录只留最近用过、且没过期太久的，避免卸载掉的应用把目录堆成垃圾场。 */
async function pruneIconFiles(dir) {
  const index = await listIconFiles(dir);
  if (index.size === 0) return;
  const now = Date.now();
  const keep = [];
  for (const [name, hit] of index) {
    if (now - hit.mtimeMs > ICON_TTL_MS * 4) await removeFile(hit.filePath);
    else keep.push({ name, mtimeMs: hit.mtimeMs });
  }
  keep.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of keep.slice(MAX_APPS)) await removeFile(path.join(dir, entry.name));
}

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

/** 读缓存的候选路径：稳定标识优先，其次别名还没建立时写过的那份传输地址文件。 */
function cacheCandidates(serial) {
  const known = stableIdOf(serial);
  const list = [cachePath(serial)];
  if (known !== serial) list.unshift(cachePath(known));
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
export async function deleteAppCache(serial) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) return false;
  // 必须和写路径共用同一把锁：否则一次正在收尾的写入（tmp 已写、待 rename）会在删除
  // 之后落地，用户点了「清除缓存」列表却原地复活。锁键与 mutateAppCache 一致。
  return withCacheLock(cachePath(stableIdOf(serial)), async () => {
    for (const filePath of cacheCandidates(serial)) await removeFile(filePath);
    // 图标住在单独目录里，不一起删的话「清除缓存」会立刻把旧图标原样端回来。
    for (const dir of iconDirs(serial)) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") console.warn("Failed to remove icon dir:", error);
      }
    }
    iconPrunedAt.delete(iconDir(stableIdOf(serial)));
    return true;
  });
}

/** Cached app list for one device, or [] when absent. 图标从本地文件补齐（不问设备）。 */
export async function getCachedApps(serial) {
  const apps = (await readAppCache(serial))?.apps || [];
  const local = await readIconFiles(
    serial,
    apps.map((app) => app.packageName),
  );
  return apps.map((app) => ({
    ...app,
    iconUrl: local[app.packageName]?.dataUrl ?? null,
    iconUpdatedAt: local[app.packageName]?.updatedAt ?? null,
  }));
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
        // writeSnapshotTo that is about to rename it into place.
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
 * 落一份快照：tmp + rename，成功后顺手清理过期缓存。
 * 唯一的写路径调用方是 `mutateAppCache`（图标已拆到文件，快照只在列表权威刷新时重写）。
 */
async function writeSnapshotTo(filePath, snapshot) {
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

/**
 * 一台设备缓存文件的读-改-写串行队列。
 *
 * 图标是分批发来的（渲染层同时跑 3 个 worker），每一批都是「读整份快照 → 并进
 * 内存 → 写回整份」。不串行时后完成的那批拿的是自己那次读到的旧快照，会把先完成
 * 那批的图标整块盖掉（旧 D4）。
 *
 * 键用 `stableIdOf`（只查已落盘的别名表，**绝不在这里 spawn adb**）：既让同一台设备的
 * 两个传输地址共用一把锁，又不会把测试变成「插着真机才会红」。代价是别名表还没建立时
 * （冷启动第一次刷列表，之前没人解析过）两个地址会分到两把锁 —— 实际链路里连接、心跳、
 * 快捷方式解析都会先填好别名，剩下的窗口极短。
 * @type {Map<string, Promise<unknown>>}
 */
const cacheChains = new Map();

function withCacheLock(filePath, task) {
  const key = filePath;
  const previous = cacheChains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  cacheChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run.finally(() => {
    if (cacheChains.get(key) === run) cacheChains.delete(key);
  });
}

/**
 * 对一台设备的应用缓存做一次原子的读-改-写。
 * @param {string} serial
 * @param {(snapshot: import('../shared/types.js').AppCacheSnapshot | null) => Promise<import('../shared/types.js').AppCacheSnapshotInput> | import('../shared/types.js').AppCacheSnapshotInput} mutate
 *   拿到当前快照（可能没有），返回要写回的整份快照。慢的部分（跑 helper）**必须放在外面**，
 *   否则一把锁会按批数串行化整条设备链路。
 */
export async function mutateAppCache(serial, mutate) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) {
    throw new Error("设备序列号无效");
  }
  const stable = stableIdOf(serial);
  const filePath = cachePath(stable);
  return withCacheLock(filePath, async () => {
    const current = await readAppCache(serial);
    const next = await mutate(current);
    await writeSnapshotTo(filePath, next);
    return next;
  });
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
export async function ensureLatestHelper(serial) {
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
export function runHelperEntry(serial, entryClass, extraArgs = []) {
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
          entryClass,
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

/** ListMain 的一次性执行入口，应用列表与图标都走它。 */
function runHelperList(serial, extraArgs = []) {
  return runHelperEntry(serial, HELPER_ENTRY_CLASS, extraArgs);
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
    system: app?.system === true,
  }));
}

/** @param {{ packageName: string, label?: string, iconUrl?: string | null }} app */
function normalizeApp(app) {
  return {
    packageName: app.packageName,
    label: app.label || app.packageName,
    iconUrl: app.iconUrl || null,
    system: app.system === true,
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
  const now = Date.now();

  // 快照只记「这台设备装了哪些应用、标签是什么」（秒开列表用），**不记图标**：
  // 图标在 icons-v1/ 里单独成文件，年龄以 mtime 说。放在同一把锁里写，是因为这份整表
  // 快照可能正和冷启动的图标迁移抢同一个文件。
  await mutateAppCache(serial, () => snapshot(now, apps));

  // 本地已有图标的直接随列表一起回去，让首页在图标批次跑起来之前就是满的（不问设备）。
  const local = await readIconFiles(
    serial,
    apps.map((app) => app.packageName),
  );
  return apps.map((app) => ({
    ...app,
    iconUrl: local[app.packageName]?.dataUrl ?? null,
    iconUpdatedAt: local[app.packageName]?.updatedAt ?? null,
  }));
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
  const fetched = normalizeListOutput(stdout).filter((app) => app.iconUrl);

  // 一批只写自己那几个 png 文件：不读快照、不改快照，所以并发批次之间没有任何
  // 共享状态要抢 —— 这正是旧 D4（整份 JSON 互相盖掉）消失的原因。
  const stable = await resolveDeviceStableId(serial);
  await writeIconFiles(
    stable,
    fetched.map((app) => ({ packageName: app.packageName, dataUrl: app.iconUrl })),
  );

  // 返回的 `iconUpdatedAt` 用文件 mtime，跟 readIconFiles 同一把尺子；
  // 没落盘成功的（超限/写失败）不带时间，渲染层按「缺图标」下轮重试。
  const stored = await readIconFiles(
    serial,
    fetched.map((app) => app.packageName),
  );
  return fetched
    .filter((app) => stored[app.packageName])
    .map((app) => ({ ...app, iconUpdatedAt: stored[app.packageName].updatedAt }));
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

/** 是不是 MIUI/HyperOS（`ro.miui.ui.version.name` 有值）。 */
export async function isMiuiDevice(serial) {
  assertSerial(serial);
  await ensureServer();
  const { code, stdout } = await adbExecSafe("-s", serial, "shell", "getprop", "ro.miui.ui.version.name");
  return code === 0 && stdout.trim() !== "";
}

/**
 * 写一个 Settings.Secure 键。adb shell 自带 WRITE_SECURE_SETTINGS，非 root 也能写；
 * 失败不抛（调用方只把它当作一次尽力而为的设备侧设置）。
 * @param {string} serial @param {string} key @param {string | number} value
 */
export async function setSecureSetting(serial, key, value) {
  assertSerial(serial);
  await ensureServer();
  return adbExecSafe("-s", serial, "shell", "settings", "put", "secure", key, String(value));
}

const videoCodecCapsCache = new Map();

/**
 * 设备侧能编码哪些视频（设置页用它列出选项，会话建立用它落地 `auto`）。
 * **读不到就返回 null（= 未知），绝不返回「全 false」** —— 后者会被读成「这台设备一个编码器都没有」，
 * 于是所有编码都判不可用、自动档掉到字面保底 H.264（这个坑踩过一次，AV1 就是这么被回落的）。
 * @param {string} serial
 * @returns {Promise<{usable: Record<string, boolean>, mimes: Array<{mime: string, name: string | null, label: string, protocol: boolean}>} | null>}
 */
export async function getDeviceVideoCodecs(serial) {
  assertSerial(serial);
  const cached = videoCodecCapsCache.get(serial);
  if (cached) return cached;
  await ensureServer();
  const { stdout } = await adbExecSafe("-s", serial, "shell", VIDEO_ENCODER_PROBE_CMD);
  const caps = parseEncoderMimes(stdout);
  if (caps.mimes.length === 0) {
    console.warn("AndDrive: 没读到设备编码器清单（media_codecs 路径因 ROM 而异），编码列表按「未知」处理");
    return null;
  }
  videoCodecCapsCache.set(serial, caps);
  return caps;
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
 * @param {{ props?: string, battery?: string, memory?: string, cpu?: string, network?: string }} raw
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
  const [propRes, batteryRes, memRes, cpuRes, netRes] = await Promise.all([
    adbExecSafe("-s", serial, "shell", "getprop"),
    adbExecSafe("-s", serial, "shell", "dumpsys", "battery"),
    adbExecSafe("-s", serial, "shell", "cat", "/proc/meminfo"),
    adbExecSafe("-s", serial, "shell", cpuScript),
    adbExecSafe("-s", serial, "shell", "ip -o -4 addr 2>/dev/null"),
  ]);

  if (propRes.code !== 0 && !propRes.stdout) {
    throw new Error(propRes.stderr || "读取设备信息失败");
  }

  const data = {
    serial,
    ...parseDeviceStats(
      {
        props: propRes.stdout,
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

// 连接设备：无线走 `adb connect <host:port>`；USB serial 没有 tcp 端点，
// 前提是它已经被 adb 枚举到，这里只做确认并给出可读的失败原因。
ipcMain.handle(CHANNELS.adbConnect, async (_, address) => {
  if (isUsbSerial(address)) {
    const state = await getDeviceState(address);
    if (state === "device") return address;
    throw new Error(
      state === "absent"
        ? "USB 设备未连接，请插好数据线后重试"
        : "USB 设备未授权，请在手机上允许 USB 调试后重试",
    );
  }
  const output = await adbExec({ timeoutMs: ADB_CONNECT_TIMEOUT_MS }, "connect", address);
  if (!/connected to /i.test(output)) throw new Error(output || "连接失败");
  return output.trim();
});

// 发现设备
ipcMain.handle(CHANNELS.adbFindDevice, findDevice);

// 通过 mDNS 解析设备当前的连接地址（adb-tls-connect 端口，与配对端口不同）。
// 传的是刚才那个配对服务条目（{name, address}），不是 serial —— 多台同时广播时靠它锁定同一台。
ipcMain.handle(CHANNELS.adbResolveConnectAddress, (_, pairingService) =>
  resolveConnectAddress(pairingService),
);

// 一次性列出当前可连接的设备（供渲染层轮询展示）
ipcMain.handle(CHANNELS.adbListConnectDevices, listConnectDevices);

// 当前已连接（其他工具建立）的设备，供启动时接管
ipcMain.handle(CHANNELS.adbGetConnectedDevice, getConnectedDevice);

// 连接健康检查：读取单台设备的实时状态（device / offline / unauthorized / absent）
ipcMain.handle(CHANNELS.adbGetDeviceState, (_, serial) => getDeviceState(serial));

// 断线重连：设备在线幂等返回，否则解析 mDNS 地址后重新 adb connect
ipcMain.handle(CHANNELS.adbReconnect, (_, serial) => reconnectDevice(serial));

// 配对设备
ipcMain.handle(CHANNELS.adbPair, async (_, device, password) => {
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

/**
 * 释放一台设备在本机占用的资源：镜像会话、存储挂载、adb sync 连接池与内存缓存。
 * 断开与切换设备共用它 —— 区别只在之后要不要动 transport。
 * @param {string} serial
 */
async function releaseDeviceResources(serial) {
  await runDeviceTeardown(serial);
  deviceStatsCache.delete(serial);
  videoCodecCapsCache.delete(serial);
}

// 断开设备：先释放该设备的资源，再断开 ADB 传输（USB 只停用、不摘传输，
// 详见 disconnectTransport）
ipcMain.handle(CHANNELS.adbDisconnect, async (_, rawSerial) => {
  const serial = normalizeDisconnectSerial(rawSerial);
  await releaseDeviceResources(serial);
  return disconnectTransport(serial);
});

// 切换设备：只释放上一台的资源，transport 留在 adb 里，
// 这样随时能从设备列表切回去，无线那台也不用重新 connect。
ipcMain.handle(CHANNELS.adbReleaseDevice, async (_, rawSerial) => {
  const serial = normalizeDisconnectSerial(rawSerial);
  await releaseDeviceResources(serial);
  return true;
});

// 安装 Helper
ipcMain.handle(CHANNELS.adbInstallHelper, async (_, serial) => {
  return installHelper(serial);
});

/**
 * Load the installed-app list for one device. The app_process run is
 * one-shot, so this resolves with the complete list.
 * @param {string} address
 */
ipcMain.handle(CHANNELS.adbLoadInstalledApps, async (_, address) => {
  return loadInstalledApps(address);
});

// 批量获取应用图标（渲染层按每组 20 个包名调用）
ipcMain.handle(CHANNELS.adbGetAppIcons, async (_, address, packages) => {
  return getAppIcons(address, packages);
});

// 卸载 Helper（部分 ROM 卸载成功也返回 code 1 + Failure，输出仅记录，不作判断）
ipcMain.handle(CHANNELS.adbUninstallHelper, async (_, address) => {
  return uninstallHelper(address);
});

// 清除该设备的应用列表缓存
ipcMain.handle(CHANNELS.adbDeleteAppCache, async (_, address) => {
  return deleteAppCache(address);
});

// 读取该设备的应用列表缓存，供界面秒开
ipcMain.handle(CHANNELS.adbGetCachedApps, async (_, address) => {
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
ipcMain.handle(CHANNELS.adbVideoCodecs, (_, serial) => getDeviceVideoCodecs(serial));
