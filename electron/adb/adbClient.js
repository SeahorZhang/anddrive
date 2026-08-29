import { execFile } from "node:child_process";
import { adbPath } from "../paths.js";
import { isAlreadyDisconnectedError } from "./errors.js";
import { parseAdbDevices, parseDeviceInfo } from "./deviceParser.js";

let serverStarted = false;

export async function ensureServer() {
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
export function adbExec(...args) {
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
export function adbExecSafe(...args) {
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
 * @param {string} serial
 * @param {...string} args
 */
export function adbShell(serial, ...args) {
  return adbExec("-s", serial, "shell", ...args);
}

/**
 * @param {string} host
 * @param {string | number} port
 * @param {string} code
 */
export function pair(host, port, code) {
  return ensureServer().then(() => adbExec("pair", `${host}:${port}`, code));
}

/**
 * Connect to a wireless device by address (`ip:port`).
 * adb exits 0 even when the target is unreachable ("cannot connect to ..."),
 * so success is judged from the output text, not the exit code.
 * @param {string} address
 */
export async function connectDevice(address) {
  const output = await adbExec("connect", address);
  if (!/connected to /i.test(output)) throw new Error(output || "连接失败");
  return output.trim();
}

/** @returns {Promise<import('../../shared/types.js').AdbDevice[]>} */
export async function listDevices() {
  await ensureServer();
  return parseAdbDevices(await adbExec("devices"));
}

/**
 * Disconnect a wireless ADB transport. Missing transports are idempotent.
 * @param {string} serial
 */
export async function disconnectTransport(serial) {
  await ensureServer();
  try {
    await adbExec("disconnect", serial);
  } catch (error) {
    if (isAlreadyDisconnectedError(error)) return true;
    throw error;
  }
  return true;
}

/** @param {string} serial */
export async function getDeviceInfo(serial) {
  await ensureServer();

  const [model, brand, marketname] = await Promise.all([
    adbShell(serial, "getprop", "ro.product.model").catch(() => ""),
    adbShell(serial, "getprop", "ro.product.brand").catch(() => ""),
    adbShell(serial, "getprop", "ro.product.marketname").catch(() => ""),
  ]);

  return parseDeviceInfo({ serial, model, brand, marketname });
}
