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
});

/** 虚拟显示基准密度：1dp = 1px（实际下发 dpi = 该值 × DISPLAY_PIXEL_SCALE）。 */
export const DISPLAY_BASE_DPI = 160;

/**
 * 虚拟显示的像素倍率：显示像素 = 窗口 CSS × 该值，dpi = `160 × 该值`，于是
 * **1dp = 1 CSS px**（与倍率无关，布局松紧不变）。
 *
 * 这是一个**清晰度 ↔ px 写死控件大小**的对数旋钮，两个诉求物理上顶着：
 * - 倍率 = 2（当前）：1 显示像素 = 1 Retina 背衬像素，画面最锐。
 * - 倍率 = 1：像素减半、dp 不变（布局完全一样），抖音那批**按 px 写死**的控件
 *   （顶部那排 tab 最明显）相对画面大一倍，但整帧被放大 2 倍铺到背衬上 → 用户实测反馈
 *   「不光字不清晰，整个画面都不清晰」，所以退回 2。
 *
 * 已实测排除的「两全」路子：改 dpi 无效（dpi 480 下那排字只有 ~16 物理像素，14sp 本该 42）；
 * `settings put system font_scale 1.3` 也无效（前后两帧一模一样，抖音不吃系统字体缩放）。
 * 还剩一条**未验**：那排字可能是按**物理屏 density**（恒 480）算的而不是真写死 —— 若是，
 * 开会话时临时抬 `wm density` 就能把它撑大同时保住 2 倍像素。这条要手机解锁状态才能测。
 * 注：2 是按 Retina 主屏调的；若以后在非 Retina 外接屏上用，改成 1 更省码流。
 */
export const DISPLAY_PIXEL_SCALE = 2;

/**
 * 由窗口 CSS 尺寸算出虚拟显示的像素尺寸与密度：`窗口 CSS × DISPLAY_PIXEL_SCALE`，
 * dpi = `160 × DISPLAY_PIXEL_SCALE`，于是 1dp = 1 CSS px，画面比例恒等于窗口比例
 * （contain 下不会出现黑边）。
 *
 * 窗口宽大于高时这里给出的是横形尺寸（logical width > height），随附的 scrcpy-server
 * 在建这个虚拟显示时打开了「忽略应用尺寸限制」，所以固定竖屏的 app 也会真的按横屏铺满，
 * 而不是被 size-compat 压成中间一条竖屏带 —— 详见 docs/NATIVE_MIRROR.md。
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @returns {{ width: number, height: number, dpi: number }}
 */
export function computeDisplayMetrics(cssWidth, cssHeight) {
  return {
    width: Math.round(cssWidth * DISPLAY_PIXEL_SCALE),
    height: Math.round(cssHeight * DISPLAY_PIXEL_SCALE),
    dpi: Math.round(DISPLAY_BASE_DPI * DISPLAY_PIXEL_SCALE),
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
  };
}
