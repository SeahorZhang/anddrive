import { app, BrowserWindow, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { adbPath } from "./paths.js";
import { findDevice, resolveConnectAddress } from "./adb/discoveryService.js";
import { CHANNELS } from "./ipcContract.js";

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
