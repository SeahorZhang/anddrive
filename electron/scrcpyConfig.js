import { app, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CHANNELS } from "./ipcContract.js";

// ---------------------------------------------------------------------------
// scrcpy 全局默认参数（scrcpyConfig）
//
// 参数的唯一持久化在主进程（userData/scrcpy-config.json）：渲染层读取与修改都
// 走 IPC。放在主进程是因为桌面快捷方式唤起投屏发生在冷启动早期，此时渲染层
// 尚未加载，主进程必须能独立拿到最新参数（否则快捷方式只能用创建时的快照，
// 之后在设置页改过的置顶等参数不会生效）。
// ---------------------------------------------------------------------------

/** 默认投屏参数。渲染层可覆盖，字段经 normalizeScrcpyConfig 校验后才会进入命令行。 */
export const DEFAULT_SCRCPY_CONFIG = Object.freeze({
  /** `--new-display` 值：`<宽>x<高>/<dpi>`；`device` 表示设备原分辨率，`off` 表示不建虚拟显示。 */
  newDisplay: "1920x1080/320",
  bitRate: "24M",
  maxFps: 60,
  videoCodec: "h265",
  audio: false,
  /** 屏幕策略：keepActive 保持亮屏 · turnOff 息屏 · normal 不干预。 */
  screenMode: "keepActive",
  alwaysOnTop: false,
  fullscreen: false,
});

const VIDEO_CODECS = new Set(["h264", "h265", "av1"]);
const SCREEN_MODES = new Set(["keepActive", "turnOff", "normal"]);
const BIT_RATE_RE = /^\d{1,4}[KMG]?$/;
const NEW_DISPLAY_RE = /^\d{3,5}x\d{3,5}(\/\d{2,4})?$/;

/**
 * 归一化投屏参数：非法值静默回落到默认值，避免把任意字符串带进命令行。
 * @param {unknown} input
 * @returns {typeof DEFAULT_SCRCPY_CONFIG}
 */
export function normalizeScrcpyConfig(input) {
  const raw = input && typeof input === "object" ? input : {};
  const newDisplay = (() => {
    if (raw.newDisplay === "device" || raw.newDisplay === "off") return raw.newDisplay;
    if (typeof raw.newDisplay === "string" && NEW_DISPLAY_RE.test(raw.newDisplay.trim())) {
      return raw.newDisplay.trim();
    }
    return DEFAULT_SCRCPY_CONFIG.newDisplay;
  })();
  const maxFps = Number.isInteger(raw.maxFps)
    ? Math.min(240, Math.max(1, raw.maxFps))
    : DEFAULT_SCRCPY_CONFIG.maxFps;
  return {
    newDisplay,
    bitRate:
      typeof raw.bitRate === "string" && BIT_RATE_RE.test(raw.bitRate.trim())
        ? raw.bitRate.trim()
        : DEFAULT_SCRCPY_CONFIG.bitRate,
    maxFps,
    videoCodec: VIDEO_CODECS.has(raw.videoCodec)
      ? raw.videoCodec
      : DEFAULT_SCRCPY_CONFIG.videoCodec,
    audio: raw.audio === true,
    screenMode: SCREEN_MODES.has(raw.screenMode)
      ? raw.screenMode
      : DEFAULT_SCRCPY_CONFIG.screenMode,
    alwaysOnTop: raw.alwaysOnTop === true,
    fullscreen: raw.fullscreen === true,
  };
}

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
