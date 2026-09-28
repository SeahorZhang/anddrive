import { reactive, watch } from "vue";
import { getScrcpyConfigApi, setScrcpyConfigApi } from "@/api";
import { DEFAULT_SCRCPY_CONFIG } from "../../shared/scrcpyConfig.js";

/**
 * scrcpy 全局默认参数（模块级单例，设置页与启动对话框共用）。
 *
 * 持久化在主进程（userData/scrcpy-config.json），渲染层经 IPC 读写——桌面快捷
 * 冷启动唤起投屏时主进程要能独立拿到最新参数，所以参数只存主进程。
 */

// 默认值只有 shared/scrcpyConfig.js 一份：以前这里手抄过一遍，加字段就会两边不一致。
export const SCRCPY_DEFAULTS = DEFAULT_SCRCPY_CONFIG;

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
  .then(({ config }) => {
    Object.assign(scrcpyConfig, config);
  })
  .catch(() => {
    // 主进程不可达时保持默认值
  });

/** 恢复全部默认参数。 */
export function resetScrcpyConfig() {
  Object.assign(scrcpyConfig, SCRCPY_DEFAULTS);
}

