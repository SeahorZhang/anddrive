import { execFile } from "node:child_process";
import { adbPath } from "../paths.js";
import { isAlreadyDisconnectedError } from "./errors.js";

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
