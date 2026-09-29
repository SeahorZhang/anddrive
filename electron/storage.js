import { app, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CHANNELS } from "./ipcContract.js";
import {
  ensureLatestHelper,
  ensureServer,
  onDeviceTeardown,
  runHelperEntry,
} from "./adb.js";
import { parseHelperReport } from "../shared/storageVolumes.js";
import { createDeviceAdapter } from "./devfs.js";
import { createDeviceDavServer } from "./webdav.js";

// ---------------------------------------------------------------------------
// 设备存储：按卷读数 + 挂到本机
//
// 读数只有一条路：helper 的 `StorageMain`（容量口径与手机设置/竞品一致，见 docs/TODO.md F10）。
// 挂载走 macOS 自带的 `mount_webdav` 挂我们自己的 127.0.0.1 WebDAV：不需要管理员、
// 不需要 macFUSE、不需要系统扩展，卷就出现在访达里。挂载点放 `~/Volumes/` ——
// `/Volumes` 建目录要管理员，`mount_webdav` 又允许挂到任意用户目录。
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const MAX_SERIAL_LENGTH = 1024;
const CACHE_TTL_MS = 15_000;
const STORAGE_ENTRY_CLASS = "com.anddrive.helper.StorageMain";
const MOUNT_TIMEOUT_MS = 30_000;
const USER_SYSTEM = 0;

const cache = new Map();
/** volumeId → { token, serial, devicePath, mountPoint } */
const mounts = new Map();
/** token → { serial, root }，WebDAV 服务按它路由 */
const davRoutes = new Map();
let davServer = null;

/** @param {unknown} serial */
function assertSerial(serial) {
  if (typeof serial !== "string" || !serial.trim() || serial.length > MAX_SERIAL_LENGTH) {
    throw new Error("设备序列号无效");
  }
  return serial;
}

/** 采集并按卷解析；缓存 15s，force 时刷新（面板每次打开都强制刷）。 */
export async function getStorageReport(serial, force = false) {
  assertSerial(serial);
  const cached = cache.get(serial);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return attachMountState(cached.data);

  await ensureServer();
  // 随包版本比设备上的新时要先升级：老 helper 里没有 StorageMain。
  await ensureLatestHelper(serial);
  const { stdout, stderr } = await runHelperEntry(serial, STORAGE_ENTRY_CLASS, [String(USER_SYSTEM)]);
  if (!stdout.trim()) {
    const noise = String(stderr || "")
      .split("\n")
      .filter(Boolean)
      .slice(-2)
      .join(" | ");
    throw new Error(noise || "读取设备存储信息失败");
  }

  const data = { serial, ...parseHelperReport(stdout), updatedAt: Date.now() };
  cache.set(serial, { at: Date.now(), data });
  return attachMountState(data);
}

/** 挂载状态不属于设备，不能被 15s 缓存冻住：出报告前现算一遍。 */
function attachMountState(report) {
  return {
    ...report,
    volumes: report.volumes.map((volume) => ({
      ...volume,
      mountPoint: mounts.get(volume.id)?.mountPoint ?? null,
    })),
  };
}

export function clearStorageCache(serial) {
  if (serial) cache.delete(serial);
  else cache.clear();
}

// ---------------------------------------------------------------------------
// 挂载
// ---------------------------------------------------------------------------

/**
 * 只删空目录。**绝不能递归删挂载点**：`umount` 失败（卷正被占用）时目录里那些文件
 * 其实还在设备上，递归删就等于把用户手机里的东西删了。
 */
async function rmdirIfEmpty(dir) {
  await fs.rmdir(dir).catch(() => {});
}

/** 卷名会直接成为访达里的卷标题：去掉路径分隔与控制字符，限制长度。 */
export function mountFolderName(deviceLabel, volumeLabel) {
  const clean = (value) =>
    Array.from(String(value ?? ""))
      // 斜杠换成空格而不是删掉：`a/b` 变成 `a b` 才不会把两个词粘在一起。
      .map((ch) => (ch === "/" ? " " : ch.codePointAt(0) >= 0x20 ? ch : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  return [clean(deviceLabel), clean(volumeLabel)].filter(Boolean).join(" ") || "AndDrive";
}

async function volumesRoot() {
  const dir = path.join(os.homedir(), "Volumes");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 目标目录已存在且非空时往后缀避让，避免挂到别的东西上面。 */
async function reserveMountPoint(name) {
  const base = await volumesRoot();
  for (let index = 0; index < 20; index += 1) {
    const candidate = path.join(base, index === 0 ? name : `${name} ${index + 1}`);
    try {
      const entries = await fs.readdir(candidate);
      if (entries.length === 0) await fs.rmdir(candidate);
      else continue;
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
    }
    await fs.mkdir(candidate, { recursive: true });
    return candidate;
  }
  throw new Error("已有太多同名挂载点");
}

async function ensureDavServer() {
  if (!davServer) {
    davServer = await createDeviceDavServer((token) => davRoutes.get(token) ?? null);
  }
  return davServer;
}

/**
 * 把一个卷挂到本机。`volumeId` 来自最近一次读数，所以路径不需要调用方传 ——
 * 面板上的按钮和设备侧真实路径因此不可能各说各话。
 */
export async function mountVolume({ serial, volumeId, deviceLabel } = {}) {
  assertSerial(serial);
  if (typeof volumeId !== "string" || !volumeId) throw new Error("存储位置无效");
  if (mounts.has(volumeId)) return { mountPoint: mounts.get(volumeId).mountPoint, reused: true };

  const report = await getStorageReport(serial, true);
  const volume = report.volumes.find((item) => item.id === volumeId);
  if (!volume) throw new Error("设备上找不到该存储位置");

  const volumeName = mountFolderName(deviceLabel, volume.label);
  const token = randomBytes(12).toString("hex");
  const server = await ensureDavServer();
  // 卷名要喂两处（都是实测出来的，别再猜）：`-v` 定 volume_name —— 访达的窗口标题与
  // 桌面磁盘图标用它，挂载点撞名带后缀时也能保住干净卷名；PROPFIND 的 displayname 给
  // 非 webdavfs 的客户端。**两者都管不到侧栏「位置」那一行**：那里固定显示 URL 主机名
  // （`127.0.0.1`），要改只能改 /etc/hosts（要管理员）或换 FileProvider 扩展。
  davRoutes.set(
    token,
    createDeviceAdapter({
      serial,
      root: volume.path,
      displayName: volumeName,
      // Android 的 `/` 是只读文件系统（实测 `touch /x` → Read-only file system），挂它只能看
      // 不能写；共享存储与可移动卡是 FUSE 挂载，shell uid 写得动。
      readOnly: volume.kind === "root",
    }),
  );

  const mountPoint = await reserveMountPoint(volumeName);
  try {
    await execFileAsync(
      "/sbin/mount_webdav",
      ["-v", volumeName, `http://127.0.0.1:${server.port}/${token}/`, mountPoint],
      { timeout: MOUNT_TIMEOUT_MS },
    );
  } catch (error) {
    davRoutes.delete(token);
    await rmdirIfEmpty(mountPoint);
    throw new Error(readableMountError(error), { cause: error });
  }

  mounts.set(volumeId, { token, serial, devicePath: volume.path, mountPoint });
  return { mountPoint };
}

function readableMountError(error) {
  const detail = String(error?.stderr || error?.message || "").trim();
  if (/already mounted/i.test(detail)) return "这个位置已经挂载过了";
  return detail ? `挂载失败：${detail.split("\n").pop()}` : "挂载失败";
}

/** 卸载。设备已经掉了也要把本地状态清干净，所以 `umount` 失败不拦清理。 */
export async function unmountVolume(volumeId) {
  const mount = mounts.get(volumeId);
  if (!mount) return false;
  mounts.delete(volumeId);
  davRoutes.delete(mount.token);
  try {
    await execFileAsync("/sbin/umount", [mount.mountPoint], { timeout: MOUNT_TIMEOUT_MS });
  } catch {
    try {
      await execFileAsync("/sbin/umount", ["-f", mount.mountPoint], { timeout: MOUNT_TIMEOUT_MS });
    } catch {
      /* 挂载点已经不在（设备断开后系统自己收了）也算成功 */
    }
  }
  await rmdirIfEmpty(mount.mountPoint);
  return true;
}

export function listMounts() {
  return [...mounts.entries()].map(([volumeId, mount]) => ({ volumeId, ...mount }));
}

async function unmountAllFor(predicate) {
  // 先取一份名单：unmountVolume 会边遍历边删 mounts。
  const targets = []
  for (const [volumeId, mount] of mounts) if (predicate(mount)) targets.push(volumeId)
  for (const volumeId of targets) await unmountVolume(volumeId)
}

// 设备断开 / 退出应用都要先收掉挂载：留着访达上会是一个点开就报错的死卷。
onDeviceTeardown(async (serial) => {
  clearStorageCache(serial);
  await unmountAllFor((mount) => !serial || mount.serial === serial);
});

app.on("before-quit", () => {
  void unmountAllFor(() => true).then(() => davServer?.close());
  davServer = null;
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.adbStorageVolumes, (_event, serial, force) =>
  getStorageReport(serial, force === true),
);
ipcMain.handle(CHANNELS.adbStorageMount, (_event, payload) => mountVolume(payload));
ipcMain.handle(CHANNELS.adbStorageUnmount, (_event, volumeId) => unmountVolume(volumeId));
ipcMain.handle(CHANNELS.adbStorageReveal, async (_event, volumeId) => {
  const mount = mounts.get(volumeId);
  if (!mount) throw new Error("这个存储位置还没挂载");
  const problem = await shell.openPath(mount.mountPoint);
  if (problem) throw new Error(problem);
  return true;
});
