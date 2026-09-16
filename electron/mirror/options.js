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
 * 「虚拟显示器」映射：`off` 不建虚拟显示，`device` 用设备原分辨率（空值），
 * 其余形如 `1920x1080/320` 直接透传。
 * @param {string} newDisplay
 * @returns {string | undefined}
 */
export function mapNewDisplay(newDisplay) {
  if (newDisplay === "off") return undefined;
  if (newDisplay === "device") return "";
  return newDisplay;
}

/**
 * 把归一化后的投屏参数映射为 scrcpy 4.0 server 选项对象。
 * 只覆盖作用于「服务端」的字段；置顶 / 全屏等窗口行为由 Electron 窗口负责，
 * 息屏等运行时控制后续通过控制消息下发。
 * @param {unknown} input
 * @param {{ videoCodec?: string }} [overrides]
 * @returns {Record<string, unknown>}
 */
export function buildMirrorOptions(input, overrides = {}) {
  const config = { ...normalizeScrcpyConfig(input) };
  if (overrides.videoCodec) config.videoCodec = overrides.videoCodec;
  /** @type {Record<string, unknown>} */
  const options = {
    video: true,
    // scrcpy 4.0 的音频仅支持 Opus（`ScrcpyAudioCodec.Opus`），WebCodecs 可解。
    audio: true,
    audioCodec: 'opus',
    control: true,
    sendStreamMeta: true,
    videoCodec: config.videoCodec,
    videoBitRate: parseBitRate(config.bitRate),
    maxFps: config.maxFps,
  };

  const newDisplay = mapNewDisplay(config.newDisplay);
  if (newDisplay !== undefined) options.newDisplay = newDisplay;

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
