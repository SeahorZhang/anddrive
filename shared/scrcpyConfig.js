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
 * - 倍率 = 2（锐度基准）：1 显示像素 = 1 Retina 背衬像素，画面最锐。
 * - 倍率越低：像素越少、dp 不变（布局完全一样），抖音那批**按 px 写死**的控件
 *   （顶部那排 tab 最明显）相对画面越大；但整帧被放大铺到背衬上 → 倍率 1 时用户实测反馈
 *   「不光字不清晰，整个画面都不清晰」。
 * - 倍率越高：那排字相对越小，且超过 2 之后属于过采样（合成时被缩回背衬），码流按平方涨。
 *
 * 已实测排除的「两全」路子：改 dpi 无效（dpi 480 下那排字只有 ~16 物理像素，14sp 本该 42）；
 * `settings put system font_scale 1.3` 也无效（前后两帧一模一样，抖音不吃系统字体缩放）。
 * 还剩一条**未验**：那排字可能是按**物理屏 density**（恒 480）算的而不是真写死 —— 若是，
 * 开会话时临时抬 `wm density` 就能把它撑大同时保住背衬像素。这条要手机解锁状态才能测。
 * 注：2 是按 Retina 主屏调的；若以后在非 Retina 外接屏上用，改成 1 更省码流。
 *
 * 2026-09-20 真横屏落地后用户反馈「抖音上边文字有点大」→ 定到 **2.5**（那排字小约 20%，
 * dp 布局与 1dp=1CSS px 都不受影响）。再想小就往 3（约小 33%）；觉得画面发软就往回 2。
 * 定到 3 之后（2026-09-22）用户又反馈窗口拖大画面会被切/超出 —— 根因不在倍率，见下一段。
 *
 * **窗口很大时会撞到设备编码上限**（真机量的，Redmi 2509FPN0BC / HyperOS、h265：
 * **短边 ≤ 4320、长边 ≤ 8192**；倍率 3 下即窗口某一边超过 ~1440 CSS px 就开始触发）。
 * 上游 scrcpy 的 flex display 约束是**逐维裁剪**，越界时把 5600x5600 裁成 5600x4320、
 * 把 4320x9000 裁成 4320x8192 —— 显示形状和窗口脱钩，应用按错掉的形状重排，
 * 画面就出现「超出窗口 / 显示不完整」（2026-09-22 用户反馈）。
 * 随包的自编 server 已改成**按比例收缩**（`NewDisplayCapture`，见 docs/NATIVE_MIRROR.md），
 * 于是越界时的代价只是「每 CSS px 的像素数变少」（略软），形状与 1dp=1CSS px 都保住。
 */
export const DISPLAY_PIXEL_SCALE = 3;

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
