import { ipcMain } from "electron";
import { execFile } from "node:child_process";
import { adbPath, helperApkPath } from "./paths.js";
import { findDevice, resolveConnectAddress } from "./adb/discoveryService.js";
import { CHANNELS } from "./ipcContract.js";
import { loadInstalledApps, getAppIcons, uninstallHelper } from "./helper/helper.js";
import { deleteAppCache } from "./cache/appCache.js";

export const HELPER_PACKAGE = "com.anddrive.helper";

/** @param {...string} args */
export function adbExec(...args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath(), args, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

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

// 配对设备
ipcMain.handle(CHANNELS.adbPair, async (event, device, password) => {
  // await ensureServer();
  return adbExec("pair", device.address, password);
});

// 安装app
ipcMain.handle("adb:installHelper", async (event, address) => {
  const apkPath = helperApkPath();
  const stdout = await adbExec("-s", address, "install", "-r", apkPath);
  if (!/Success/i.test(stdout)) throw new Error(stdout || "安装失败");
  else return "安装成功";
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


