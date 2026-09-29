// scrcpy 参数归一化（主进程与渲染层共用，纯函数不依赖 Electron）。

/** 默认投屏参数。渲染层可覆盖，字段经 normalizeScrcpyConfig 校验后才会进入命令行。 */
export const DEFAULT_SCRCPY_CONFIG = Object.freeze({
  /** 码率跟着画质档位走（设置页里两者是同一个下拉），默认清晰档 = 32M。 */
  bitRate: "32M",
  maxFps: 60,
  /** 视频编码：auto = 按「设备能编 + 本机 WebCodecs 能解」自动挑（见 pickAutoCodec）。 */
  videoCodec: "auto",
  audio: false,
  alwaysOnTop: false,
  fullscreen: false,
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

/**
 * 画质档位 → 该档的码率上限。设置页把这两项并成**一个下拉**：上表实测每档的稳态码率
 * 差着 5 倍（~5 / ~5.2 / ~27Mbps），两者本来就一一对应，拆成两个选择器只会让人配错
 * （3 档配 8M 会糊，1.5 档配 32M 白占带宽）。
 *
 * sharp 给 32M 而非 24M：实测 ~27Mbps 已越过 24M 上限，24M 装不下这一档（默认值随之为 32M）。
 *
 * **存盘仍是 `quality` + `bitRate` 两个字段**（结构零迁移）：老配置里两者对不上这张表时，
 * 设置页补一项标灰的「自定义」照实显示，不静默改用户的值 —— 同 `planCodecList` 对
 * 越界编码的处理。唯一例外是改版前的出厂组合 `sharp + 24M`，由 `normalizeScrcpyConfig`
 * 升级到 `sharp + 32M`（否则老用户打开设置页全看到「自定义」）。
 */
export const DISPLAY_QUALITY_BIT_RATES = Object.freeze({
  compat: "8M",
  native: "16M",
  sharp: "32M",
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

/**
 * 已知视频编码目录 —— 手机 `media_codecs.xml` 可能报出来的那些，全写在这里。
 * `protocol: true` = 随包 server 的 `VideoCodec` 枚举里有这一项（有 4 字节 id，客户端认得出来）。
 * 换设备不用动这张表：设备有什么靠探测，这张表只回答「有这个东西的话，我们带不带得动」。
 */
export const VIDEO_CODEC_CATALOG = Object.freeze([
  { mime: "video/avc", name: "h264", label: "H.264", protocol: true },
  { mime: "video/hevc", name: "h265", label: "H.265", protocol: true },
  { mime: "video/av01", name: "av1", label: "AV1", protocol: true },
  { mime: "video/x-vnd.on2.vp8", name: "vp8", label: "VP8", protocol: true },
  { mime: "video/x-vnd.on2.vp9", name: "vp9", label: "VP9", protocol: true },
  // 设备上真实存在，但投屏协议里没有对应位置（要支持得改 server 枚举 + 自己写解封装 + Mac 侧得有解码器）。
  { mime: "video/3gpp", name: "h263", label: "H.263", protocol: false },
  { mime: "video/mp4v-es", name: "mp4v", label: "MPEG-4", protocol: false },
  { mime: "video/apv", name: "apv", label: "APV", protocol: false },
  { mime: "video/dolby-vision", name: "dovi", label: "Dolby Vision", protocol: false },
  { mime: "video/x-mvhevc", name: "mvhevc", label: "MV-HEVC", protocol: false },
]);

const BY_MIME = new Map(VIDEO_CODEC_CATALOG.map((entry) => [entry.mime, entry]));
const BY_NAME = new Map(VIDEO_CODEC_CATALOG.map((entry) => [entry.name, entry]));

/** 协议认得的那些才可能进命令行与下拉；`auto` 排最前。 */
export const VIDEO_CODEC_CHOICES = Object.freeze([
  "auto",
  ...VIDEO_CODEC_CATALOG.filter((entry) => entry.protocol).map((entry) => entry.name),
]);

/** 展示名。目录外的 mime（新 ROM 冒出来的）退化成它自己的后缀，至少能读。 */
export function codecLabel(nameOrMime) {
  const raw = String(nameOrMime ?? "");
  return BY_NAME.get(raw)?.label ?? BY_MIME.get(raw)?.label ?? raw.replace(/^video\//, "");
}

/**
 * 设备上「有哪些视频编码器」的探测命令（adb shell 里跑）。
 * 字符类必须含 `.` 与 `-`：VP8/VP9 的 mime 是 `video/x-vnd.on2.vp8` 这种厂商命名，
 * 只写 `[a-z0-9]` 会在点号处截断成 `video/x`，那两种编码就永远探不到（踩过）。
 */
export const VIDEO_ENCODER_PROBE_CMD =
  "grep -rhiE 'encoder' /vendor/etc/media_codecs*.xml /apex/com.android.media.swcodec/etc/media_codecs.xml 2>/dev/null | grep -oE 'video/[a-z0-9._-]+' | sort -u";

/**
 * 从 `media_codecs*.xml` 的 encoder 行里解析设备能编哪些视频。
 * 启发式：只认「这一行是 encoder 且声明了该 mime」，多 SKU 配置取并集 ——
 * 可能把没用上的那个 SKU 的编码器也算进来（宁可多报，别漏报）。
 * @param {string} text
 * @returns {{usable: Record<string, boolean>, mimes: Array<{mime: string, name: string | null, label: string, protocol: boolean}>}}
 */
export function parseEncoderMimes(text) {
  const list = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("video/"));
  const usable = {};
  for (const entry of VIDEO_CODEC_CATALOG) {
    if (entry.protocol) usable[entry.name] = false;
  }
  const mimes = [];
  for (const mime of new Set(list)) {
    const entry = BY_MIME.get(mime);
    if (entry) {
      if (entry.protocol) usable[entry.name] = true;
      mimes.push({ mime, name: entry.name, label: entry.label, protocol: entry.protocol });
    } else {
      mimes.push({ mime, name: null, label: mime.replace(/^video\//, ""), protocol: false });
    }
  }
  return { usable, mimes };
}

/** 自动挑选的优先序。AV1 不参与自动：本机解码还没验证过。 */
const AUTO_ORDER = Object.freeze(["h265", "h264"]);
const VIDEO_CODECS = new Set(VIDEO_CODEC_CHOICES);


/**
 * 「这一编码两头都行吗」。`caps.device` / `caps.local` 为 null = 还不知道，
 * 未知就当通过（宁可让设备端去拒，也不要在没探测到的时候拦掉用户）。
 * @param {string} codec @param {{device?: Record<string, boolean> | null, local?: Record<string, boolean> | null}} caps
 */
export function isCodecUsable(codec, caps = {}) {
  const { device = null, local = null } = caps ?? {};
  return (device == null || device[codec] === true) && (local == null || local[codec] === true);
}

/** 自动挑选：H.265 优先，退到 H.264。 */
export function pickAutoCodec(caps = {}) {
  return AUTO_ORDER.find((codec) => isCodecUsable(codec, caps)) ?? "h264";
}

/**
 * 把设置里的编码（可能是 `auto`）解析成实际下发给 scrcpy 的那一个。
 * @param {unknown} requested @param {{device?: Record<string, boolean> | null, local?: Record<string, boolean> | null}} caps
 * @returns {{ codec: string, downgraded: boolean }}
 */
export function resolveVideoCodec(requested, caps = {}) {
  const codec = String(requested ?? "auto");
  if (codec === "auto") return { codec: pickAutoCodec(caps), downgraded: false };
  if (isCodecUsable(codec, caps)) return { codec, downgraded: false };
  return { codec: pickAutoCodec(caps), downgraded: true };
}
const QUALITIES = new Set(Object.keys(DISPLAY_QUALITY_TIERS));
const BIT_RATE_RE = /^\d{1,4}[KMG]?$/;
/** 改版前（画质档位还没带码率时）的出厂码率，见 `normalizeScrcpyConfig` 的升级说明。 */
const LEGACY_DEFAULT_BIT_RATE = "24M";

/**
 * 编码下拉该列什么、设备多出来的那些为什么进不来。纯函数，UI 只负责渲染。
 *
 * - `options` = `auto` + 「协议认得 ∩ 设备能编 ∩ 本机能解」；`current` 落在能力之外时补一项并标灰，
 *   否则下拉会对着空选项，看不出自己以前选过什么。
 * - `blocked` = 设备报了、但进不了下拉的那些，带原因。某一头整表没探到（null）时不下判断 ——
 *   探测失败不该被说成「不支持」。
 * @param {{mimes?: Array<{name: string | null, label: string, protocol: boolean}>, device?: Record<string, boolean> | null, local?: Record<string, boolean> | null, current?: string | null}} input
 * @returns {{options: Array<{value: string, label: string, disabled: boolean}>, blocked: Array<{label: string, reason: string}>, auto: string}}
 */
export function planCodecList({ mimes = [], device = null, local = null, current = null } = {}) {
  const caps = { device, local };
  const usable = VIDEO_CODEC_CATALOG.filter((entry) => entry.protocol && isCodecUsable(entry.name, caps));
  const options = [{ value: "auto", label: `自动（当前选 ${codecLabel(pickAutoCodec(caps))}）`, disabled: false }];
  for (const entry of usable) options.push({ value: entry.name, label: entry.label, disabled: false });

  if (current && current !== "auto" && !usable.some((entry) => entry.name === current)) {
    const entry = VIDEO_CODEC_CATALOG.find((item) => item.name === current);
    const marks = [];
    if (!entry?.protocol) marks.push("服务端不支持");
    if (device && device[current] === false) marks.push("设备不支持");
    if (local && local[current] === false) marks.push("本机不能解");
    options.push({
      value: current,
      label: `${codecLabel(current)}${marks.length ? `（${marks.join("、")}）` : ""}`,
      disabled: true,
    });
  }

  const blocked = mimes
    .filter((entry) => !usable.some((item) => item.name === entry.name))
    .map((entry) => ({
      label: entry.label,
      reason: !entry.protocol
        ? "投屏协议带不动"
        : local && local[entry.name] === false
          ? "本机不能解"
          : "",
    }));

  return { options, blocked, auto: pickAutoCodec(caps) };
}

/**
 * 归一化投屏参数：非法值静默回落到默认值，避免把任意字符串带进命令行。
 * 已废弃的字段（`engine`、`tablet` 那类历史存盘键）在这里被**静默丢弃** ——
 * 老用户的配置文件因此无需迁移，下次保存就干净了。
 *
 * 唯一一处**主动改值**：改版前的出厂组合 `sharp + 24M` 升级成新的出厂组合
 * `sharp + 32M`（见 `DISPLAY_QUALITY_BIT_RATES`）。存盘里分不清「出厂值」和
 * 「用户选的 24M」—— 而 24M 本来就是下拉里的默认项，按出厂值处理；否则每个老用户
 * 打开新设置页看到的都会是标灰的「自定义」。其他不匹配预设的组合一律原样保留。
 * @param {unknown} input
 * @returns {typeof DEFAULT_SCRCPY_CONFIG}
 */
export function normalizeScrcpyConfig(input) {
  const raw = input && typeof input === "object" ? input : {};
  const maxFps = Number.isInteger(raw.maxFps)
    ? Math.min(240, Math.max(1, raw.maxFps))
    : DEFAULT_SCRCPY_CONFIG.maxFps;
  const quality = QUALITIES.has(raw.quality) ? raw.quality : DEFAULT_SCRCPY_CONFIG.quality;
  const storedBitRate =
    typeof raw.bitRate === "string" && BIT_RATE_RE.test(raw.bitRate.trim())
      ? raw.bitRate.trim()
      : DEFAULT_SCRCPY_CONFIG.bitRate;
  return {
    bitRate:
      quality === DEFAULT_SCRCPY_CONFIG.quality && storedBitRate === LEGACY_DEFAULT_BIT_RATE
        ? DEFAULT_SCRCPY_CONFIG.bitRate
        : storedBitRate,
    maxFps,
    videoCodec: VIDEO_CODECS.has(raw.videoCodec)
      ? raw.videoCodec
      : DEFAULT_SCRCPY_CONFIG.videoCodec,
    audio: raw.audio === true,
    quality,
    alwaysOnTop: raw.alwaysOnTop === true,
    fullscreen: raw.fullscreen === true,
  };
}
