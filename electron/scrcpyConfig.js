import { app, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CHANNELS } from "./ipcContract.js";
import { DEFAULT_SCRCPY_CONFIG, normalizeScrcpyConfig } from "../shared/scrcpyConfig.js";

// ---------------------------------------------------------------------------
// scrcpy 全局默认参数（scrcpyConfig）
//
// 参数的唯一持久化在主进程（userData/scrcpy-config.json）：渲染层读取与修改都
// 走 IPC。放在主进程是因为桌面快捷方式唤起投屏发生在冷启动早期，此时渲染层
// 尚未加载，主进程必须能独立拿到最新参数（否则快捷方式只能用创建时的快照，
// 之后在设置页改过的置顶等参数不会生效）。
// 纯函数部分（normalize/默认值）已抽到 shared/scrcpyConfig.js 供渲染层复用。
// ---------------------------------------------------------------------------

export { DEFAULT_SCRCPY_CONFIG, normalizeScrcpyConfig };


const storePath = () => path.join(app.getPath("userData"), "scrcpy-config.json");

/** 内存缓存；loadScrcpyConfig 之后即与磁盘一致。 */
let cached = null;
/** 磁盘上是否已有持久化文件（渲染层据此决定是否迁移旧 localStorage 数据）。 */
let stored = false;

/** 启动时从磁盘加载参数；文件缺失或损坏时回落默认值。 */
export async function loadScrcpyConfig() {
  try {
    const data = await fs.readFile(storePath(), "utf8");
    cached = normalizeScrcpyConfig(JSON.parse(data));
    stored = true;
  } catch {
    cached = { ...DEFAULT_SCRCPY_CONFIG };
    stored = false;
  }
  return getScrcpyConfigState();
}

/** 当前生效的全局参数（未加载完成前为默认值）。 */
export function currentScrcpyConfig() {
  return cached ?? DEFAULT_SCRCPY_CONFIG;
}

/** @returns {{ config: typeof DEFAULT_SCRCPY_CONFIG, stored: boolean }} */
export function getScrcpyConfigState() {
  return { config: { ...currentScrcpyConfig() }, stored };
}

/** 保存参数：先归一化再原子写入，返回归一化后的结果。 */
export async function saveScrcpyConfig(input) {
  cached = normalizeScrcpyConfig(input);
  stored = true;
  const file = storePath();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(cached), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    console.warn("Failed to write scrcpy config:", error);
  }
  return { ...cached };
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.scrcpyConfigGet, () => getScrcpyConfigState());
ipcMain.handle(CHANNELS.scrcpyConfigSet, (_, config) => saveScrcpyConfig(config));
