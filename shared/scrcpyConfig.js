// scrcpy 参数归一化（主进程与渲染层共用，纯函数不依赖 Electron）。

/** 默认投屏参数。渲染层可覆盖，字段经 normalizeScrcpyConfig 校验后才会进入命令行。 */
export const DEFAULT_SCRCPY_CONFIG = Object.freeze({
  bitRate: "24M",
  maxFps: 60,
  videoCodec: "h265",
  audio: false,
  /** 屏幕策略：keepActive 保持亮屏 · turnOff 息屏 · normal 不干预。 */
  screenMode: "keepActive",
  alwaysOnTop: false,
  fullscreen: false,
  /** 默认引擎：`native` 自研渲染引擎 · `scrcpy` 原生窗口（兼容回退）。 */
  engine: "native",
  /** 画质档位：见 DISPLAY_QUALITY_TIERS。默认 sharp = 与老版本一致（倍率 3）。 */
  quality: "sharp",
});

/** 虚拟显示基准密度：1dp = 1px（实际下发 dpi = 该值 × 档位倍率）。 */
export const DISPLAY_BASE_DPI = 160;

/**
 * 画质档位 = 虚拟显示的像素倍率：显示像素 = 窗口 CSS × 倍率，dpi = `160 × 倍率`，
 * 于是**任何档位都保持 1dp = 1 CSS px**（布局松紧与倍率无关），换档只换两件事：
 * 画面的清晰度，以及编码/传输的负载。
 *
 * 实测（测试机 Redmi 2509FPN0BC / HyperOS、h265、60fps 上限、码率上限 24M；每一档都是
 * 「设备上只有这一个采集会话 + 打开系统设置列表 + 匀速来回滑动」后按秒统计入站包）：
 *
 * | 档位 | 800x1600 CSS 窗口的显示 | 稳态帧率 | 稳态码率 |
 * | --- | --- | --- | --- |
 * | compat 1.5x | 1200x2400（2.9MP） | 60 | ~5Mbps |
 * | native 2x | 1600x3200（5.1MP） | 60 | ~5.2Mbps |
 * | sharp 3x | 2400x4800（11.5MP） | 60 | **~27Mbps，吃满并越过 24M 上限** |
 *
 * 两点值得记住：
 * - **像素多少不影响这台机器的帧率**（1.3MP 与 11.5MP 都稳 60fps）—— 别拿"防掉帧"当降档
 *   的理由。我一度就是这么写的，那组数字出自被并发会话污染的测量，已作废。
 * - 真实差别是**带宽**：3 档比 2 档多花约 4 倍流量，还经常顶穿设定码率。Wi-Fi 环境差时
 *   优先降档；单纯压码率上限会让编码器丢帧。
 *
 * `sharp` 是历史默认（倍率 3），保留它是因为窗口里那排按 px 写死的控件（抖音顶部 tab 最
 * 明显）在高倍率下相对更小 —— 那是观感选择，不是清晰度选择（超过 2x 已是过采样）。
 */
export const DISPLAY_QUALITY_TIERS = Object.freeze({
  compat: 1.5,
  native: 2,
  sharp: 3,
});

/** 老注释与调用点里的「倍率」= 默认档位的倍率。 */
export const DISPLAY_PIXEL_SCALE = DISPLAY_QUALITY_TIERS.sharp;

/**
 * 窗口尺寸 → 虚拟显示的像素尺寸与密度：`窗口 CSS × 档位倍率`，dpi = `160 × 档位倍率`，
 * 于是 1dp = 1 CSS px，画面比例恒等于窗口比例（contain 下不会出现黑边）。
 *
 * 档位在整个会话内保持不变（取自开会话时的 config）：scrcpy 的 `resizeDisplay` **只带
 * 宽高、不带 dpi**，而 dpi 在建显示时定死，中途换档会让 1dp ≠ 1 CSS px。对照 AndroMeld：
 * 它的 resize 命令带三个 int（w/h/dpi），所以没有这个约束 —— 要跟上得扩我们自己的协议。
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {keyof typeof DISPLAY_QUALITY_TIERS} [quality]
 * @returns {{ width: number, height: number, dpi: number, scale: number }}
 */
export function computeDisplayMetrics(cssWidth, cssHeight, quality) {
  const scale = DISPLAY_QUALITY_TIERS[quality] ?? DISPLAY_PIXEL_SCALE;
  const width = Math.max(1, Math.round(cssWidth) || 1);
  const height = Math.max(1, Math.round(cssHeight) || 1);
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
    dpi: Math.round(DISPLAY_BASE_DPI * scale),
    scale,
  };
}

const VIDEO_CODECS = new Set(["h264", "h265", "av1"]);
const ENGINES = new Set(["scrcpy", "native"]);
const SCREEN_MODES = new Set(["keepActive", "turnOff", "normal"]);
const QUALITIES = new Set(Object.keys(DISPLAY_QUALITY_TIERS));
const BIT_RATE_RE = /^\d{1,4}[KMG]?$/;

/**
 * 归一化投屏参数：非法值静默回落到默认值，避免把任意字符串带进命令行。
 * @param {unknown} input
 * @returns {typeof DEFAULT_SCRCPY_CONFIG}
 */
export function normalizeScrcpyConfig(input) {
  const raw = input && typeof input === "object" ? input : {};
  const maxFps = Number.isInteger(raw.maxFps)
    ? Math.min(240, Math.max(1, raw.maxFps))
    : DEFAULT_SCRCPY_CONFIG.maxFps;
  return {
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
    quality: QUALITIES.has(raw.quality) ? raw.quality : DEFAULT_SCRCPY_CONFIG.quality,
    alwaysOnTop: raw.alwaysOnTop === true,
    fullscreen: raw.fullscreen === true,
    engine: ENGINES.has(raw.engine) ? raw.engine : DEFAULT_SCRCPY_CONFIG.engine,
  };
}
