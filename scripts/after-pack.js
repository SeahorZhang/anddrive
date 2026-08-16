import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";

function requireFile(filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
    throw new Error(`Required packaged resource is missing: ${filePath}`);
  }
}

export default async function afterPack(context) {
  const resources = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  requireFile(path.join(resources, "helper-app.apk"));

  if (context.electronPlatformName === "darwin") {
    const adbPath = path.join(resources, "adb", "mac", "adb");
    requireFile(adbPath);
    const architecture = { 1: "x86_64", 3: "arm64" }[context.arch];
    if (!architecture) throw new Error(`Unsupported macOS architecture: ${context.arch}`);
    execFileSync("lipo", [adbPath, "-thin", architecture, "-output", `${adbPath}.thin`]);
    execFileSync("mv", [`${adbPath}.thin`, adbPath]);
    chmodSync(adbPath, 0o755);
    const info = execFileSync("lipo", ["-info", adbPath], { encoding: "utf8" });
    if (!info.includes(`architecture: ${architecture}`) || info.includes("Architectures in the fat file")) {
      throw new Error(`Packaged ADB has the wrong architecture: ${info.trim()}`);
    }
  } else if (context.electronPlatformName === "win32") {
    for (const name of ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"]) {
      requireFile(path.join(resources, "adb", "win", name));
    }
  } else if (context.electronPlatformName === "linux") {
    const adbPath = path.join(resources, "adb", "linux", "adb");
    requireFile(adbPath);
    chmodSync(adbPath, 0o755);
  }
}
