import adbkit from "@devicefarmer/adbkit";
const { createClient } = adbkit;
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getAdbPath() {
  const platform = process.platform;
  let binName;

  if (platform === "darwin") {
    binName = "mac/adb";
  } else if (platform === "win32") {
    binName = "win/adb.exe";
  } else {
    binName = "linux/adb";
  }

  // In development, resources are in the project root
  // In production, resources are in app resources path
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "adb", binName);
  }
  return path.join(__dirname, "..", "resources", "adb", binName);
}

let client = null;
let serverStarted = false;

async function startAdbServer() {
  if (serverStarted) return;

  const adbPath = getAdbPath();

  return new Promise((resolve, reject) => {
    execFile(adbPath, ["start-server"], (error) => {
      if (error) {
        console.error("Failed to start ADB server:", error);
        reject(error);
      } else {
        serverStarted = true;
        resolve();
      }
    });
  });
}

export async function getAdbClient() {
  if (!client) {
    await startAdbServer();
    client = createClient({ bin: getAdbPath() });
  }
  return client;
}

export async function getDevices() {
  const adb = await getAdbClient();
  return adb.listDevices();
}

export async function shell(serial, command) {
  const adb = await getAdbClient();
  const stream = await adb.getDevice(serial).shell(command);
  const output = await adb.util.readAll(stream);
  return output.toString();
}

export async function install(serial, apkPath) {
  const adb = await getAdbClient();
  return adb.getDevice(serial).install(apkPath);
}

export async function push(serial, localPath, remotePath) {
  const adb = await getAdbClient();
  const transfer = await adb.getDevice(serial).push(localPath, remotePath);
  return new Promise((resolve, reject) => {
    transfer.on("end", resolve);
    transfer.on("error", reject);
  });
}

export async function pull(serial, remotePath, localPath) {
  const adb = await getAdbClient();
  const transfer = await adb.getDevice(serial).pull(remotePath);
  return new Promise((resolve, reject) => {
    transfer.on("end", resolve);
    transfer.on("error", reject);
  });
}

export async function screencap(serial) {
  const adb = await getAdbClient();
  const stream = await adb.getDevice(serial).screencap();
  const buffer = await adb.util.readAll(stream);
  return buffer.toString("base64");
}

export async function getDeviceProps(serial) {
  const adb = await getAdbClient();
  return adb.getDevice(serial).getProperties();
}

export async function forward(serial, local, remote) {
  const adb = await getAdbClient();
  return adb.getDevice(serial).forward(local, remote);
}

export async function getDHCPIpAddress(serial) {
  const adb = await getAdbClient();
  return adb.getDevice(serial).getDHCPIpAddress();
}
