import { app } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { onceAsync, pathExists, pruneStaleEntries } from "./fsUtil.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// macOS：给 scrcpy 套一层 .app bundle
//
// 裸可执行文件在 scrcpy 建窗之前就已经作为普通 App 出现在 Dock 里（SDL 初始化
// 视频子系统时），而窗口图标要等连接设备、screen_init 之后才设置。于是 Dock 会
// 先显示通用可执行文件图标，再变成应用图标。放进带 CFBundleIconFile 的 .app 后，
// 系统从进程出现起就用应用图标，不再有这段跳变。
//
// bundle 按图标内容寻址并缓存；scrcpy 二进制用硬链接放进 bundle，避免重复复制。
// ---------------------------------------------------------------------------

const BUNDLES_ROOT = "scrcpy-app-bundles";
const ICONS_ROOT = "scrcpy-app-icons";
const BUNDLE_NAME = "Scrcpy.app";
const SIPS = "/usr/bin/sips";
const PRUNE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function rootDir(name) {
  return path.join(app.getPath("userData"), name);
}

/** Info.plist 里的文本需要转义；应用名只保留可安全放入 XML 的可见字符。 */
function xmlEscape(value) {
  return String(value).replace(
    /[<>&"']/g,
    (char) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char],
  );
}

function bundleDisplayName(label) {
  if (typeof label !== "string") return "scrcpy";
  // 去掉控制字符（XML 不允许），再截断。
  let cleaned = "";
  for (const char of label) {
    if ((char.codePointAt(0) ?? 0) >= 0x20) cleaned += char;
  }
  return cleaned.trim().slice(0, 64) || "scrcpy";
}

function infoPlist(bundleId, bundleName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>scrcpy</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleIdentifier</key>
	<string>${xmlEscape(bundleId)}</string>
	<key>CFBundleName</key>
	<string>${xmlEscape(bundleName)}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleVersion</key>
	<string>1.0</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;
}

/** 优先硬链接（同卷零成本），跨卷时回落复制并补上可执行位。 */
async function linkOrCopy(source, target, { executable = false } = {}) {
  try {
    await fs.link(source, target);
    return;
  } catch {
    await fs.copyFile(source, target);
    if (executable) await fs.chmod(target, 0o755);
  }
}

/** 把 PNG 转成 bundle 需要的 ICNS，按内容哈希缓存。 */
async function ensureIcns(iconPng, hash) {
  const icnsPath = path.join(rootDir(ICONS_ROOT), `${hash}.icns`);
  if (await pathExists(icnsPath)) return icnsPath;

  const pngPath = `${icnsPath}.${randomBytes(4).toString("hex")}.png`;
  await fs.mkdir(path.dirname(icnsPath), { recursive: true });
  await fs.writeFile(pngPath, iconPng);
  try {
    await execFileAsync(SIPS, ["-s", "format", "icns", pngPath, "--out", icnsPath]);
  } finally {
    await fs.rm(pngPath, { force: true }).catch(() => {});
  }
  return icnsPath;
}

/**
 * 构建（或复用）带应用图标的 scrcpy .app，返回 bundle 内的可执行文件路径。
 * 非 macOS 或没有图标时返回 null，调用方回落到原始二进制。
 * @param {{ binaryPath: string, serverPath: string, iconPng: Buffer | null, label?: string }} params
 * @returns {Promise<string | null>}
 */
export async function resolveScrcpyExecutable({ binaryPath, serverPath, iconPng, label }) {
  if (process.platform !== "darwin" || !iconPng) return null;

  try {
    const hash = createHash("sha256")
      .update(iconPng)
      .update("\0")
      .update(bundleDisplayName(label))
      .digest("hex")
      .slice(0, 16);
    const bundleDir = path.join(rootDir(BUNDLES_ROOT), hash, BUNDLE_NAME);
    const executable = path.join(bundleDir, "Contents", "MacOS", "scrcpy");
    if (await pathExists(executable)) return executable;

    // 先构建到临时目录再改名，避免并发启动看到半成品。
    const staging = `${bundleDir}.${randomBytes(4).toString("hex")}.tmp`;
    const macosDir = path.join(staging, "Contents", "MacOS");
    const resourcesDir = path.join(staging, "Contents", "Resources");
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(macosDir, { recursive: true });
    await fs.mkdir(resourcesDir, { recursive: true });
    await linkOrCopy(binaryPath, path.join(macosDir, "scrcpy"), { executable: true });
    await linkOrCopy(serverPath, path.join(macosDir, "scrcpy-server"));
    await linkOrCopy(await ensureIcns(iconPng, hash), path.join(resourcesDir, "AppIcon.icns"));
    await fs.writeFile(
      path.join(staging, "Contents", "Info.plist"),
      infoPlist(`com.anddrive.scrcpy.${hash}`, bundleDisplayName(label)),
      "utf8",
    );

    await fs.rm(bundleDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(bundleDir), { recursive: true });
    await fs.rename(staging, bundleDir);
    return executable;
  } catch (error) {
    console.warn("AndDrive: 构建 scrcpy app bundle 失败：", error?.message || error);
    return null;
  }
}

/** 清理长期未用到的缓存 bundle / icns；进程内只跑一次。 */
export const pruneScrcpyAppBundles = onceAsync(async () => {
  if (process.platform !== "darwin") return;
  await Promise.all([
    pruneStaleEntries(rootDir(BUNDLES_ROOT), PRUNE_AGE_MS),
    pruneStaleEntries(rootDir(ICONS_ROOT), PRUNE_AGE_MS),
  ]);
});
