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

/** 标准画面比例（宽/高）：横 16:9 · 竖 9:16。 */
const LANDSCAPE_RATIO = 16 / 9;
const PORTRAIT_RATIO = 9 / 16;

/**
 * 把任意盒子吸附到标准画面比例，结果取**内接**的最大标准盒（两根轴都不大于输入）。
 *
 * 为什么要吸附：照抄窗口比例（例如这台 Mac 的 1.54:1）时，只肯按标准比例出画面的
 * app 会在帧内自己补黑；而内接保证 1dp = 1px 不变、内容不被放大，窗口与画面剩下
 * 的比例差由 contain 渲染留成黑边。
 *
 * @param {number} width
 * @param {number} height
 * @returns {{ width: number, height: number }}
 */
export function standardDisplayBox(width, height) {
  const ratio = width >= height ? LANDSCAPE_RATIO : PORTRAIT_RATIO;
  // 编码器按 4:2:0 采样，奇数边长会被服务端裁掉 1px，直接取偶数。
  const even = (value) => Math.round(value / 2) * 2;
  const w = even(Math.min(width, height * ratio));
  return { width: w, height: even(w / ratio) };
}

/**
 * 由窗口 CSS 尺寸算出虚拟显示的实际像素尺寸与密度：
 * 尺寸乘 `devicePixelRatio`（Retina 上 2x 采样更清晰），dpi 同步乘，从而保持
 * 1dp = 1px 的布局观感（dp = 物理 px × 160 / dpi = CSS px）；平板模式再乘 1.5。
 * 最终尺寸吸附到标准画面比例（见 `standardDisplayBox`）。
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {{ tablet?: boolean, pixelRatio?: number }} [options]
 * @returns {{ width: number, height: number, dpi: number }}
 */
export function computeDisplayMetrics(cssWidth, cssHeight, options = {}) {
  const zoom = options.tablet === true ? TABLET_ZOOM : 1;
  const dpr = Number.isFinite(options.pixelRatio) && options.pixelRatio > 0 ? options.pixelRatio : 1;
  const box = standardDisplayBox(cssWidth * dpr * zoom, cssHeight * dpr * zoom);
  return { ...box, dpi: Math.round(DISPLAY_BASE_DPI * dpr) };
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
