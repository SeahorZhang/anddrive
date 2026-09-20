// 桌面投屏快捷方式（shortcut）
//
// 为某个应用在桌面生成一个 `.adr` 快捷方式文件（内容见 ./shortcutCore.js），
// 双击后由系统按文件关联交给 AndDrive，主进程读取文件、连接设备并投屏；
// 镜像会话仍由 AndDrive 统一管理，投屏参数取当前全局默认（见 ./scrcpyConfig.js）。
//
// 文件关联：
// - 打包版：electron-builder.json 的 `mac.extendInfo` 里声明了正式 UTI 与
//   `LSHandlerRank: Owner`，装好后系统就把 `.adr` 认作 AndDrive 的类型。
// - 开发版：dev 跑的是 node_modules 里的 Electron.app，没有声明该类型、也无法
//   直接加载本项目。因此在这里手工搭一个极简的 `.app` bundle（shell 脚本作为
//   可执行文件）声明 `.adr` 类型，被唤起时执行 `Electron <项目> <文件>`，复用
//   同一套投屏逻辑。正式启动后顺带移除这个 dev bundle，避免抢占正式版关联。

import { app, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CHANNELS } from "./ipcContract.js";
import { normalizePackageName, resolveDeviceStableId } from "./adb.js";
import { composeMacosIconPng, iconPngBuffer, sanitizeIcon } from "./iconImage.js";
import { pathExists } from "./fsUtil.js";
import {
  MIRROR_FILE_EXTENSION,
  MIRROR_FILE_UTI,
  buildShortcutContent,
  parseShortcutContent,
  sanitizeSerial,
  sanitizeLabel,
  sanitizeShortcutName,
} from "./shortcutCore.js";

const execFileAsync = promisify(execFile);
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
/** dev launcher 的所在目录名（位于各 dev userData 下）。 */
const DEV_LAUNCHER_DIRNAME = "shortcut-launcher";
const DEV_LAUNCHER_BUNDLE = "AndDrive Shortcut.app";
/**
 * dev 用过的 userData 目录名，新到旧。正式版启动时逐个清干净：早期版本没改过
 * userData，launcher 落在包名 `anddrive_next` 下，那份注册会一直抢 `.adr`。
 */
const DEV_USER_DATA_DIRNAMES = ["anddrive-dev", "anddrive_next"];
const DEV_LAUNCHER_BUNDLE_ID = "com.anddrive.next.shortcut.dev";

// ---------------------------------------------------------------------------
// 快捷方式文件
// ---------------------------------------------------------------------------

/** 读取快捷方式文件并解析出投屏请求；文件不存在或内容非法时返回 null。 */
export async function readShortcutFile(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    return parseShortcutContent(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 在桌面创建 / 覆盖一个 `.adr` 投屏快捷方式。
 * @param {{ address?: unknown, packageName?: unknown, label?: unknown, iconUrl?: unknown }} payload
 * @returns {Promise<{ path: string, name: string }>}
 */
export async function createAppShortcut(payload) {
  const packageName = normalizePackageName(payload?.packageName);
  // 存**稳定设备标识**而不是 adb 传输地址：无线重连一次地址就换一个，存地址的快捷方式
  // 当场作废（点开没反应）。打开时再由主进程按标识反查当前地址。
  let stableId = "";
  try {
    stableId = await resolveDeviceStableId(sanitizeSerial(payload?.address));
  } catch {
    // 问不到就用传进来的地址，至少不比旧行为差
  }
  const serial = sanitizeSerial(stableId || payload?.address);
  const label = sanitizeLabel(payload?.label) || packageName;
  const request = { serial, packageName, label, iconUrl: sanitizeIcon(payload?.iconUrl) };

  const name = sanitizeShortcutName(label, packageName);
  const filePath = path.join(app.getPath("desktop"), `${name}.${MIRROR_FILE_EXTENSION}`);
  await fs.writeFile(filePath, buildShortcutContent(request), "utf8");

  // 触碰时间戳，让 Finder 立即刷新新文件。
  const now = new Date();
  await fs.utimes(filePath, now, now);

  await setShortcutFileIcon(filePath, request.iconUrl);
  return { path: filePath, name };
}

// ---------------------------------------------------------------------------
// Finder 文件图标
//
// macOS 没有设置自定义文件图标的内置命令，借 osascript 调用 AppKit 的
// NSWorkspace.setIcon 写入图标资源；失败只记日志，不影响快捷方式本身的创建。
// ---------------------------------------------------------------------------

const SET_FILE_ICON_SCRIPT = `use framework "AppKit"
on run argv
	set img to current application's NSImage's alloc()'s initWithContentsOfFile:(item 1 of argv)
	if img is missing value then error "cannot load icon"
	current application's NSWorkspace's sharedWorkspace()'s setIcon:img forFile:(item 2 of argv) options:0
end run`;

const OSASCRIPT = "/usr/bin/osascript";

async function setShortcutFileIcon(filePath, iconUrl) {
  if (process.platform !== "darwin") return;

  const rawPng = iconPngBuffer(iconUrl);
  if (!rawPng) return;
  const png = (await composeMacosIconPng(rawPng)) || rawPng;
  const pngPath = path.join(
    app.getPath("userData"),
    "shortcut-icons",
    `${randomBytes(8).toString("hex")}.png`,
  );
  try {
    await fs.mkdir(path.dirname(pngPath), { recursive: true });
    await fs.writeFile(pngPath, png);
    await execFileAsync(OSASCRIPT, ["-e", SET_FILE_ICON_SCRIPT, pngPath, filePath]);
  } catch (error) {
    console.warn("AndDrive: 设置快捷方式图标失败：", error?.message || error);
  } finally {
    await fs.rm(pngPath, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 文件关联（macOS 开发模式）
// ---------------------------------------------------------------------------

/** dev launcher 的可执行脚本：把 `.adr` 文件转交给 Electron dev 实例。 */
function launcherScript(exePath, projectPath, devServerUrl) {
  const env = devServerUrl ? `VITE_DEV_SERVER_URL=${shellQuote(devServerUrl)} ` : "";
  return `#!/bin/bash
exec env ${env}${shellQuote(exePath)} ${shellQuote(projectPath)} "$@" > /dev/null 2>&1
`;
}

/** POSIX shell 单引号转义。 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** dev launcher 的 Info.plist：声明 `.adr` 类型，后台运行（LSUIElement）。 */
function launcherPlist(bundleId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
	<key>CFBundleName</key>
	<string>AndDrive Shortcut</string>
	<key>CFBundleExecutable</key>
	<string>launcher</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>LSUIElement</key>
	<true/>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>AndDriveMirror</string>
			<key>CFBundleTypeExtensions</key>
			<array>
				<string>${MIRROR_FILE_EXTENSION}</string>
			</array>
			<key>CFBundleTypeRole</key>
			<string>Viewer</string>
			<key>LSHandlerRank</key>
			<string>Owner</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>${MIRROR_FILE_UTI}</string>
			</array>
		</dict>
	</array>
	<key>UTExportedTypeDeclarations</key>
	<array>
		<dict>
			<key>UTTypeIdentifier</key>
			<string>${MIRROR_FILE_UTI}</string>
			<key>UTTypeDescription</key>
			<string>AndDrive 投屏快捷方式</string>
			<key>UTTypeConformsTo</key>
			<array>
				<string>public.data</string>
			</array>
			<key>UTTypeTagSpecification</key>
			<dict>
				<key>public.filename-extension</key>
				<array>
					<string>${MIRROR_FILE_EXTENSION}</string>
				</array>
			</dict>
		</dict>
	</array>
</dict>
</plist>
`;
}

/** 传给 launcher 的参数指纹：任一项变化都重建 bundle。 */
function devLauncherMarker(exePath, projectPath, devServerUrl) {
  return JSON.stringify({
    exePath,
    projectPath,
    devServerUrl,
    extension: MIRROR_FILE_EXTENSION,
    uti: MIRROR_FILE_UTI,
  });
}

async function installDevLauncher() {
  const exePath = process.execPath;
  const projectPath = app.getAppPath();
  // 透传 dev server 地址，launcher 唤起的实例才会复用 dev 的 userData 并连上热更新。
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || "";
  const baseDir = path.join(app.getPath("userData"), DEV_LAUNCHER_DIRNAME);
  const bundlePath = path.join(baseDir, DEV_LAUNCHER_BUNDLE);
  const markerPath = path.join(baseDir, "launcher.json");
  const marker = devLauncherMarker(exePath, projectPath, devServerUrl);

  const currentMarker = await fs.readFile(markerPath, "utf8").catch(() => null);
  if (currentMarker === marker && (await pathExists(bundlePath))) return;

  await fs.rm(bundlePath, { recursive: true, force: true });
  const macosDir = path.join(bundlePath, "Contents", "MacOS");
  await fs.mkdir(macosDir, { recursive: true });
  await fs.writeFile(
    path.join(bundlePath, "Contents", "Info.plist"),
    launcherPlist(DEV_LAUNCHER_BUNDLE_ID),
    "utf8",
  );
  const launcherPath = path.join(macosDir, "launcher");
  await fs.writeFile(launcherPath, launcherScript(exePath, projectPath, devServerUrl), {
    encoding: "utf8",
    mode: 0o755,
  });

  await execFileAsync(LSREGISTER, ["-f", bundlePath]);
  await fs.writeFile(markerPath, marker, "utf8");
}

async function removeDevLauncher() {
  const appData = app.getPath("appData");
  for (const dirName of DEV_USER_DATA_DIRNAMES) {
    const baseDir = path.join(appData, dirName, DEV_LAUNCHER_DIRNAME);
    const bundlePath = path.join(baseDir, DEV_LAUNCHER_BUNDLE);
    if (!(await pathExists(bundlePath))) continue;
    await execFileAsync(LSREGISTER, ["-u", bundlePath]).catch(() => {});
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

/**
 * 确保系统能把 `.adr` 交给 AndDrive 打开。开发模式安装 dev launcher，正式版
 * 依赖打包配置并清理 dev launcher。失败只记录日志，不影响主流程。
 */
export async function ensureFileAssociation() {
  if (process.platform !== "darwin") return;
  try {
    if (app.isPackaged) await removeDevLauncher();
    else await installDevLauncher();
  } catch (error) {
    console.warn("AndDrive: 注册投屏快捷方式文件关联失败：", error?.message || error);
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.shortcutCreate, (_, payload) => createAppShortcut(payload));
ipcMain.handle(CHANNELS.shortcutReveal, (_, filePath) => {
  if (typeof filePath === "string" && filePath) shell.showItemInFolder(filePath);
  return true;
});
