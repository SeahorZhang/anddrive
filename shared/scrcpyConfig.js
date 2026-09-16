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
  /** 平板模式：窗口跟随下以 1.5x 上报虚拟显示，app 收到更大的 dp 宽度（更快触发平板双栏布局）。 */
  tablet: false,
});

/** 虚拟显示基准密度：1dp = 1px（实际下发 dpi = 该值 × devicePixelRatio）。 */
export const DISPLAY_BASE_DPI = 160;
/** 平板模式：虚拟显示尺寸按窗口的 1.5x 上报，让 app 得到更大的 dp 宽度。 */
export const TABLET_ZOOM = 1.5;

/**
 * 由窗口 CSS 尺寸算出虚拟显示的实际像素尺寸与密度：
 * 尺寸乘 `devicePixelRatio`（Retina 上 2x 采样更清晰），dpi 同步乘，从而保持
 * 1dp = 1px 的布局观感（dp = 物理 px × 160 / dpi = CSS px）；平板模式再乘 1.5。
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {{ tablet?: boolean, pixelRatio?: number }} [options]
 * @returns {{ width: number, height: number, dpi: number }}
 */
export function computeDisplayMetrics(cssWidth, cssHeight, options = {}) {
  const zoom = options.tablet === true ? TABLET_ZOOM : 1;
  const dpr = Number.isFinite(options.pixelRatio) && options.pixelRatio > 0 ? options.pixelRatio : 1;
  return {
    width: Math.round(cssWidth * dpr * zoom),
    height: Math.round(cssHeight * dpr * zoom),
    dpi: Math.round(DISPLAY_BASE_DPI * dpr),
  };
}

const VIDEO_CODECS = new Set(["h264", "h265", "av1"]);
const ENGINES = new Set(["scrcpy", "native"]);
const SCREEN_MODES = new Set(["keepActive", "turnOff", "normal"]);
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
    alwaysOnTop: raw.alwaysOnTop === true,
    fullscreen: raw.fullscreen === true,
    engine: ENGINES.has(raw.engine) ? raw.engine : DEFAULT_SCRCPY_CONFIG.engine,
    tablet: raw.tablet === true,
  };
}
