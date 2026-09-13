import { ipcMain, shell, systemPreferences } from "electron";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "./ipcContract.js";

// ---------------------------------------------------------------------------
// macOS 系统权限
//
// 三种权限的处理方式不同：
// - 本地网络：无公开查询 API，但 Bonjour 被拒时返回 kDNSServiceErr_PolicyDenied。
// - 辅助功能：Electron 提供 systemPreferences.isTrustedAccessibilityClient。
// - 完全磁盘访问：无公开 API，只能通过 TCC.db 是否可读来判断，且必须手动授权。
// ---------------------------------------------------------------------------

const isMac = process.platform === "darwin";

/** 系统设置的隐私面板深链，key 为权限 id。 */
const SETTINGS_PANES = {
  localNetwork: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  fullDiskAccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};

export const PERMISSION_IDS = Object.keys(SETTINGS_PANES);

/**
 * 完全磁盘访问没有查询接口：TCC 数据库只有在获得该权限后才可读。macOS 15 起系统库
 * 位于 `/Library`，旧版本或按用户隔离时位于用户目录，两处都尝试。
 */
const TCC_DB_PATHS = [
  "/Library/Application Support/com.apple.TCC/TCC.db",
  path.join(os.homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db"),
];

/** @returns {Promise<boolean>} */
export async function hasFullDiskAccess() {
  if (!isMac) return false;
  for (const tccDb of TCC_DB_PATHS) {
    let handle;
    try {
      handle = await fs.open(tccDb, "r");
      return true;
    } catch {
      // 换下一个路径。
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return false;
}

/** @returns {boolean} */
export function hasAccessibilityAccess() {
  if (!isMac) return false;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

/** Bonjour 在本地网络权限被拒时返回的错误码（Apple TN3179）。 */
const POLICY_DENIED_CODE = "-65570";
/** 仅用于探测权限的 Bonjour 浏览目标；用元查询避免依赖具体服务是否存在。 */
const LOCAL_NETWORK_PROBE_SERVICE = "_services._dns-sd._udp";

/**
 * @typedef {'granted' | 'denied' | 'unknown'} PermissionStatus
 */

/**
 * 本地网络没有通用的状态查询 API，但 Bonjour 在权限被拒时会以
 * `kDNSServiceErr_PolicyDenied (-65570)` 失败（Apple TN3179）。这里调用系统的
 * `dns-sd` 发起一次 Bonjour 浏览：若收到该错误则判定为 denied；浏览正常启动且
 * 未报错则判定为 granted。首次探测会顺带触发系统的“本地网络”授权弹窗。
 * @returns {Promise<PermissionStatus>}
 */
export function probeLocalNetworkAccess() {
  if (!isMac) return Promise.resolve("unknown");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("/usr/bin/dns-sd", ["-B", LOCAL_NETWORK_PROBE_SERVICE], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve("unknown");
      return;
    }

    let output = "";
    let settled = false;
    let timer;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(status);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      // 异步回调打印 "Error code -65570"，同步失败打印
      // "DNSServiceBrowse ... failed -65570"。
      if (output.includes(POLICY_DENIED_CODE) || /policy\s*denied/i.test(output)) {
        finish("denied");
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", () => finish("unknown"));
    child.once("close", (code) => finish(code === 0 ? "granted" : "unknown"));
    // 权限正常时浏览不会报错，等待一小段时间确认没有 PolicyDenied 即视为已授权。
    timer = setTimeout(() => finish("granted"), 2000);
  });
}

/**
 * @returns {Promise<Record<string, PermissionStatus>>}
 */
export async function getPermissionStatus() {
  if (!isMac) {
    return { localNetwork: "unknown", accessibility: "unknown", fullDiskAccess: "unknown" };
  }
  return {
    localNetwork: await probeLocalNetworkAccess(),
    accessibility: hasAccessibilityAccess() ? "granted" : "denied",
    fullDiskAccess: (await hasFullDiskAccess()) ? "granted" : "denied",
  };
}

/**
 * 触发系统授权流程，返回该权限触发后的状态。
 * @param {string} id
 * @returns {Promise<PermissionStatus>}
 */
export async function requestPermission(id) {
  if (!isMac) throw new Error("系统权限仅支持 macOS");
  if (id === "localNetwork") {
    return await probeLocalNetworkAccess();
  }
  if (id === "accessibility") {
    systemPreferences.isTrustedAccessibilityClient(true);
    return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
  }
  if (id === "fullDiskAccess") {
    return (await hasFullDiskAccess()) ? "granted" : "denied";
  }
  throw new Error(`未知系统权限：${id}`);
}

/**
 * 打开系统设置中对应的隐私面板。
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function openPermissionSettings(id) {
  const pane = SETTINGS_PANES[id];
  if (!pane) throw new Error(`未知系统权限：${id}`);
  await shell.openExternal(pane);
  return true;
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.permissionsStatus, () => getPermissionStatus());
ipcMain.handle(CHANNELS.permissionsRequest, (_, id) => requestPermission(id));
ipcMain.handle(CHANNELS.permissionsOpenSettings, (_, id) => openPermissionSettings(id));
