import { reactive, watch } from "vue";

/**
 * scrcpy 全局默认参数（模块级单例，设置页与启动对话框共用）。
 * 持久化到 localStorage，重启后仍生效；字段与主进程 DEFAULT_SCRCPY_CONFIG 对齐。
 */

export const SCRCPY_DEFAULTS = Object.freeze({
  newDisplay: "1920x1080/320",
  bitRate: "24M",
  maxFps: 60,
  videoCodec: "h265",
  audio: false,
  screenMode: "keepActive",
  alwaysOnTop: false,
  fullscreen: false,
});

const STORAGE_KEY = "anddrive.scrcpyConfig";

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") return { ...SCRCPY_DEFAULTS, ...parsed };
  } catch {
    // 存储损坏时回落默认值
  }
  return { ...SCRCPY_DEFAULTS };
}

export const scrcpyConfig = reactive(readStored());

watch(
  scrcpyConfig,
  (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value }));
    } catch {
      // 忽略写入失败（隐私模式/配额）
    }
  },
  { deep: true },
);

/** 恢复全部默认参数。 */
export function resetScrcpyConfig() {
  Object.assign(scrcpyConfig, SCRCPY_DEFAULTS);
}

export function useScrcpyPreferences() {
  return { scrcpyConfig, resetScrcpyConfig };
}
