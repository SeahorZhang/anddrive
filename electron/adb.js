import { ipcMain } from "electron";
import { helperApkPath } from "./paths.js";
import { adbExec, disconnectTransport } from "./adb/adbClient.js";
import { findDevice, resolveConnectAddress } from "./adb/discoveryService.js";
import { normalizeDisconnectSerial } from "./adb/errors.js";
import { CHANNELS } from "./ipcContract.js";
import { loadInstalledApps, getAppIcons, uninstallHelper } from "./helper/helper.js";
import { deleteAppCache } from "./cache/appCache.js";
import { startScrcpy, stopScrcpy } from "./scrcpy/scrcpyService.js";

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
  return adbExec("pair", device.address, password);
});

// 断开设备：先停掉该设备的 scrcpy 镜像，再断开无线 ADB 传输
ipcMain.handle(CHANNELS.adbDisconnect, async (_, rawSerial) => {
  const serial = normalizeDisconnectSerial(rawSerial);
  stopScrcpy(serial);
  return disconnectTransport(serial);
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

// 通过 scrcpy 启动应用镜像窗口（渲染层只传 { serial, packageName, label }，一条命令启动）
ipcMain.handle(CHANNELS.scrcpyStart, (_, options) => {
  return startScrcpy([
    "-s", options.serial,
    "--new-display=1920x1080/320",
    `--start-app=${options.packageName}`,
    "--video-codec=h265",
    "-b", "24M",
    "--window-x=auto",
    "--window-y=auto",
    `--window-title=${options.label}`,
  ]);
});
