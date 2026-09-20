import { normalizeScrcpyConfig } from "../../shared/scrcpyConfig.js";

// ---------------------------------------------------------------------------
// ScrcpyConfig → scrcpy-server 参数（自研客户端）
//
// 纯映射，不依赖 Electron / Tango：这里只产出 scrcpy 4.0 的选项对象，
// 直连形态下由 src/mirror/connect.js 包成 `AdbScrcpyOptions4_0` 交给 Tango。
// 字段名对应 @yume-chan/scrcpy 的 ScrcpyOptions4_0.Init。
// ---------------------------------------------------------------------------

/** scrcpy 码率后缀按十进制换算（与官方 client 的 parse_bit_rate 一致）。 */
const BIT_RATE_UNITS = { K: 1_000, M: 1_000_000, G: 1_000_000_000 };
const DEFAULT_BIT_RATE = 8_000_000;

/**
 * `24M` / `800K` / `1G` → 比特每秒。非法值回落到官方默认 8Mbps。
 * @param {unknown} value
 * @returns {number}
 */
export function parseBitRate(value) {
  const match = /^(\d{1,4})([KMG]?)$/.exec(String(value ?? "").trim());
  if (!match) return DEFAULT_BIT_RATE;
  return Number(match[1]) * (BIT_RATE_UNITS[match[2]] ?? 1);
}

/**
 * 未提供窗口尺寸时的虚拟显示兜底（`<宽>x<高>/<dpi>`）。正常路径下
 * `src/mirror/connect.js` 会按窗口尺寸 × devicePixelRatio 计算并覆盖它。
 */
const DEFAULT_NEW_DISPLAY = "1280x960/160";

/**
 * 把归一化后的投屏参数映射为 scrcpy 4.0 server 选项对象。
 * 只覆盖作用于「服务端」的字段；置顶 / 全屏等窗口行为由 Electron 窗口负责，
 * 息屏等运行时控制后续通过控制消息下发。
 * @param {unknown} input
 * @param {{ videoCodec?: string, newDisplay?: string }} [overrides]
 * @returns {Record<string, unknown>}
 */
export function buildMirrorOptions(input, overrides = {}) {
  const config = { ...normalizeScrcpyConfig(input) };
  if (overrides.videoCodec) config.videoCodec = overrides.videoCodec;
  /** @type {Record<string, unknown>} */
  const options = {
    video: true,
    // 音频转发跟着设置走，不写死：抓系统音频（REMOTE_SUBMIX playback capture）会抢
    // 设备侧的音频焦点，正在播的 app 会因此暂停，会话结束时焦点回来又自动续播 ——
    // 用户实机反馈就是「关掉投屏，手机立刻响起声音」。关掉音频就没有这次焦点抢占。
    audio: config.audio === true,
    control: true,
    sendStreamMeta: true,
    videoCodec: config.videoCodec,
    videoBitRate: parseBitRate(config.bitRate),
    maxFps: config.maxFps,
  };
  if (options.audio) {
    // scrcpy 4.0 的音频仅支持 Opus（`ScrcpyAudioCodec.Opus`），WebCodecs 可解。
    options.audioCodec = 'opus';
    // 故意**不**开 audioDup（scrcpy 默认）：服务端给 AudioMix 设的是 ROUTE_FLAG_LOOP_BACK
    // —— 只回环、不在本机渲染，所以投屏期间手机静音、声音只在电脑上出。
    // 代价要知道：会话结束时 AudioPolicy 撤销，手机恢复渲染，正在播的内容会当场出声。
    // 想要两边同时有声才需要 audioDup: true（ROUTE_FLAG_LOOP_BACK_RENDER）。
  }

  // 恒定创建虚拟显示并开启 flex display（scrcpy `--flex-display` / -x）：虚拟
  // 显示初始按窗口尺寸创建，之后窗口变化由客户端用官方 `resizeDisplay` 控制消息
  // 驱动重排。服务端 `requestResize` 对非 flex 显示直接抛错，所以必须打开它。
  options.newDisplay = overrides.newDisplay || DEFAULT_NEW_DISPLAY;
  options.flexDisplay = true;

  if (config.screenMode === "keepActive") options.keepActive = true;
  else if (config.screenMode === "turnOff") options.stayAwake = true;

  return options;
}

/**
 * 自研引擎当前启用的编码。AV1 尚未验证，先回落。
 * H.265 依赖平台 WebCodecs HEVC 解码能力，不支持时解码会报错。
 */
export const NATIVE_SUPPORTED_CODECS = Object.freeze(["h264", "h265"]);

/**
 * 选出自研引擎实际使用的编码：不支持的编码回落到 H.264。
 * @param {unknown} input
 * @returns {{ codec: string, downgraded: boolean }}
 */
export function resolveNativeCodec(input) {
  const requested = normalizeScrcpyConfig(input).videoCodec;
  if (NATIVE_SUPPORTED_CODECS.includes(requested)) return { codec: requested, downgraded: false };
  return { codec: NATIVE_SUPPORTED_CODECS[0], downgraded: true };
}

/**
 * 归一化后与窗口/运行时相关的偏好（不进 scrcpy 命令行，由 Electron 与会话处理）。
 * @param {unknown} input
 * @returns {{ alwaysOnTop: boolean, fullscreen: boolean, turnScreenOff: boolean }}
 */
export function resolveRuntimePrefs(input) {
  const config = normalizeScrcpyConfig(input);
  return {
    alwaysOnTop: config.alwaysOnTop,
    fullscreen: config.fullscreen,
    turnScreenOff: config.screenMode === "turnOff",
  };
}

/** 镜像窗口长边上限：再大就超出笔电可用高度，且 1dp = 1 CSS px 下字会跟着变大。 */
const MIRROR_WINDOW_MAX_EDGE = 1000;
/** 从桌面可用区域里留出的边距（菜单栏、Dock、以及还能拖动的手感）。 */
const MIRROR_WINDOW_MARGIN = 80;
/** 查不到设备分辨率时的兜底比例（常见直板机 9:19.5）。 */
const MIRROR_WINDOW_FALLBACK_RATIO = 9 / 19.5;

/**
 * 镜像窗口的初始尺寸 = **设备屏幕的宽高比**（用户 2026-09-19 要求「和手机一样的宽高」）。
 *
 * 形状可以随便选：随包 server 建的虚拟显示带「忽略应用尺寸限制」，app 会按显示的逻辑尺寸铺满
 * （`mBounds == mMaxBounds`，真机量过 `2462x1924/256` 横形与 `1200x2608/160` 竖形），
 * 所以窗口形状和设备一致也不会出现黑边。
 * @param {{ width: number, height: number } | null | undefined} screenSize 设备物理分辨率
 * @param {{ width: number, height: number }} workArea 桌面可用区域（CSS px）
 * @returns {{ width: number, height: number }}
 */
export function mirrorWindowBounds(screenSize, workArea) {
  const valid =
    screenSize && Number.isFinite(screenSize.width) && Number.isFinite(screenSize.height)
      ? screenSize.width > 0 && screenSize.height > 0
      : false;
  const ratio = valid ? screenSize.width / screenSize.height : MIRROR_WINDOW_FALLBACK_RATIO;
  const portrait = ratio <= 1;
  const longEdge = Math.max(
    320,
    Math.min(
      (portrait ? workArea.height : workArea.width) - MIRROR_WINDOW_MARGIN,
      MIRROR_WINDOW_MAX_EDGE,
    ),
  );
  const shortEdge = Math.max(280, Math.round(longEdge * (portrait ? ratio : 1 / ratio)));
  return portrait
    ? { width: shortEdge, height: Math.round(longEdge) }
    : { width: Math.round(longEdge), height: shortEdge };
}
