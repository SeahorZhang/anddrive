import { reactive, watch } from "vue";
import { getScrcpyConfigApi, setScrcpyConfigApi } from "@/api";

/**
 * scrcpy 全局默认参数（模块级单例，设置页与启动对话框共用）。
 *
 * 持久化在主进程（userData/scrcpy-config.json），渲染层经 IPC 读写——桌面快捷
 * 方式在冷启动唤起投屏时主进程要能独立拿到最新参数，所以参数不能只存 localStorage。
 * 字段与主进程 DEFAULT_SCRCPY_CONFIG 对齐。
 */

export const SCRCPY_DEFAULTS = Object.freeze({
  bitRate: "24M",
  maxFps: 60,
  videoCodec: "h265",
  audio: false,
  screenMode: "keepActive",
  alwaysOnTop: false,
  fullscreen: false,
  /** 默认引擎：`native` 自研渲染引擎 · `scrcpy` 原生窗口（兼容回退）。 */
  engine: "native",
});

/** 旧版本把参数存在 localStorage，升级后迁移一次到主进程。 */
const LEGACY_STORAGE_KEY = "anddrive.scrcpyConfig";

function readLegacyConfig() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? { ...SCRCPY_DEFAULTS, ...parsed } : null;
  } catch {
    return null;
  }
}

export const scrcpyConfig = reactive({ ...SCRCPY_DEFAULTS });

watch(
  scrcpyConfig,
  () => {
    setScrcpyConfigApi({ ...scrcpyConfig }).catch(() => {
      // 保存失败不打断界面；下次改动会再次尝试
    });
  },
  { deep: true },
);

void getScrcpyConfigApi()
  .then(({ config, stored }) => {
    if (!stored) {
      const legacy = readLegacyConfig();
      if (legacy) {
        // 赋值触发 watch，由 watch 推送保存到主进程。
        Object.assign(scrcpyConfig, legacy);
      }
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }
    Object.assign(scrcpyConfig, config);
  })
  .catch(() => {
    // 主进程不可达时保持默认值
  });

/** 恢复全部默认参数。 */
export function resetScrcpyConfig() {
  Object.assign(scrcpyConfig, SCRCPY_DEFAULTS);
}

export function useScrcpyPreferences() {
  return { scrcpyConfig, resetScrcpyConfig };
}
