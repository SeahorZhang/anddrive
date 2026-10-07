import { normalizeScrcpyConfig, resolveVideoCodec } from "../../shared/scrcpyConfig.js";

// ---------------------------------------------------------------------------
// ScrcpyConfig → scrcpy-server 参数（自研客户端）
//
// 纯映射，不依赖 Electron / Tango：这里只产出 scrcpy 的选项对象（形状是 4.1 那份，随包 5.0 server 认同一套），
// 直连形态下由 src/mirror/connect.js 包成 `AdbScrcpyOptions4_1` 交给 Tango。
// 字段名对应 @yume-chan/scrcpy 的 ScrcpyOptions4_1.Init。
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
 * 虚拟显示尺寸的 scrcpy 命令行写法：`<宽>x<高>`，给了密度才拼成 `<宽>x<高>/<dpi>`
 * （上游 `Options.parseNewDisplay` 三种形状都认：空串、带尺寸、只带 `/dpi`）。
 * **不给 dpi 是有意为之**：默认模式让 server 自己按长边等比缩密度
 * （`NewDisplayCapture.scaleDpi`：`initialDpi * 新长边 / 主屏长边`），于是长边 dp 数与主屏一致，
 * 版式仍由设备决定，我们不用去读设备的 density 值。
 * 数值由调用方给：曾经有个 `1280x960/160` 的兜底常量，生产唯一调用方总会覆盖它，等于死码，
 * 2026-09-28 删除。
 * @param {{ width: number, height: number, dpi?: number }} display
 */
export function formatNewDisplay(display) {
  const { width, height, dpi } = display ?? {};
  if (!(width > 0) || !(height > 0)) throw new Error("虚拟显示尺寸无效");
  const size = `${Math.round(width)}x${Math.round(height)}`;
  if (dpi === undefined || dpi === null) return size;
  if (!(dpi > 0)) throw new Error("虚拟显示尺寸无效");
  return `${size}/${Math.round(dpi)}`;
}

/**
 * 把归一化后的投屏参数映射为 scrcpy server 选项对象。
 * 只覆盖作用于「服务端」的字段；置顶 / 全屏等窗口行为由 Electron 窗口负责，
 * 息屏等运行时控制后续通过控制消息下发。
 * @param {unknown} input
 * @param {{ videoCodec?: string, display?: { width: number, height: number, dpi: number } }} overrides
 * @returns {Record<string, unknown>}
 */
export function buildMirrorOptions(input, overrides = {}) {
  const config = { ...normalizeScrcpyConfig(input) };
  if (overrides.videoCodec) config.videoCodec = overrides.videoCodec;
  // `auto` 只存在于设置里；进命令行的必须是按能力表解析过的那一个（`resolveNativeCodec`）。
  // 这里不留兜底值：静默挑一个编码 = 出问题时看不出来（同 newDisplay 那条教训）。
  if (config.videoCodec === "auto") {
    throw new Error("缺少 videoCodec：`auto` 必须由调用方按设备/本机能力解析后传入");
  }
  /** @type {Record<string, unknown>} */
  const options = {
    video: true,
    // 音频转发跟着设置走，不写死：抓系统音频（REMOTE_SUBMIX playback capture）会抢
    // 设备侧的音频焦点，正在播的 app 会因此暂停，会话结束时焦点回来又自动续播 ——
    // 用户实机反馈就是「关掉投屏，手机立刻响起声音」。关掉音频就没有这次焦点抢占。
    // 开的时候命令行里**看不到 `audio=`** 是对的：Tango 会丢掉与默认值相同的键，
    // 而上游 server 的默认就是 `audio = true`（`Options.java:28`），省略即开。
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

  // 建显示：**给得出尺寸就同时开 flex**（scrcpy `--flex-display` / -x），显示跟着窗口重排。
  // 这两件事在上游是绑死的：`NewDisplayCapture.prepare()` 里 `if (dpi == 0) { assert !flexDisplay }`
  // —— flex 显示不许缺密度（缺省时的 `scaleDpi` 只在不 flex 那条路跑），所以两种模式都要把
  // 尺寸与密度算全：
  // - 默认（上游原生产物）：尺寸 = 窗口画面区的**物理像素**（CSS × DPR），密度 = `scaleDisplayDpi`
  //   照主屏长边等比换算 → 1 显示像素 = 1 屏幕物理像素（按 px 写死的控件不被整帧压小），
  //   同时长边 dp 数与主屏一致（版式不随窗口漂移）。
  // - 大屏模式（补丁产物）：尺寸 = 窗口 CSS × 画质档位倍率，密度同倍，1dp = 1 CSS px。
  // 拿不到设备信息时 `display` 为空：默认模式给空串 = 上游默认（主屏尺寸与密度）且**不开 flex**
  // （flex 缺尺寸就撞上上面那条断言）；大屏模式没有尺寸就没有密度口径，宁可抛
  // （2026-09-28「不留兜底默认尺寸」那条教训）。`new_display` 这个键本身必须带 —— 不带 key 时
  // server 不新建显示、改去镜像主屏。
  options.newDisplay =
    overrides.display || config.largeScreenDisplay ? formatNewDisplay(overrides.display) : "";
  if (overrides.display) options.flexDisplay = true;

  // 虚拟显示不渲染系统装饰（scrcpy 的 `--no-vd-system-decorations`）：镜像里不要头部那条状态栏，
  // 整块显示都留给应用。代价：那块显示上没有状态栏也没有 launcher 兜底，导航只能靠注入的手势/键值。
  options.vdSystemDecorations = false;

  return options;
}

/**
 * 选出自研引擎实际下发的编码（`auto` 在这里落地）。能力表由调用方给：
 * `device` = 设备端有没有那个编码器，`local` = 本机 WebCodecs 能不能解。
 * @param {unknown} input @param {{device?: Record<string, boolean> | null, local?: Record<string, boolean> | null}} [caps]
 * @returns {{ codec: string, downgraded: boolean }}
 */
export function resolveNativeCodec(input, caps) {
  return resolveVideoCodec(normalizeScrcpyConfig(input).videoCodec, caps);
}

/**
 * 归一化后与窗口/运行时相关的偏好（不进 scrcpy 命令行，由 Electron 与会话处理）。
 * @param {unknown} input
 * @returns {{ alwaysOnTop: boolean, fullscreen: boolean }}
 */
export function resolveRuntimePrefs(input) {
  const config = normalizeScrcpyConfig(input);
  return {
    alwaysOnTop: config.alwaysOnTop,
    fullscreen: config.fullscreen,
  };
}

/** 读不到设备画面比例时的窗口形状（既有默认值，不随设备变）。 */
const MIRROR_WINDOW_FALLBACK_SIZE = { width: 850, height: 600 };
/** 窗口照设备比例开时，四周留给系统的余量（菜单栏、Dock、吸附手势）。 */
const MIRROR_WINDOW_MARGIN = 80;

/**
 * 镜像窗口的初始尺寸：照**设备画面比例**等比 fit 进「这块屏的可用区减边距」（2026-10-07 定）。
 *
 * 为什么窗口要先照比例开好，而不是先开一块再等第一帧收一次：默认模式的虚拟显示尺寸取自
 * **窗口画面区的物理像素**，窗口是横的就开出一块横显示 —— 竖屏 app 立刻换版式，等第一帧再收
 * 回来等于让人看一次错误形状（那一版当天就被替掉了）。
 *
 * 读不到设备比例就退回 `850x600`，并且渲染层拿不到比例时**不给显示尺寸**（`new_display` 退空串
 * = 上游默认的主屏尺寸与密度），两边都不自己编数字。
 * @param {{ width: number, height: number } | null} screenSize 设备物理分辨率（`wm size` 的 Physical）
 * @param {{ width: number, height: number } | null} workArea 该屏幕可用区
 * @returns {{ width: number, height: number }}
 */
export function mirrorWindowBounds(screenSize, workArea) {
  const width = Number(screenSize?.width);
  const height = Number(screenSize?.height);
  const available = {
    width: Number(workArea?.width) - MIRROR_WINDOW_MARGIN,
    height: Number(workArea?.height) - MIRROR_WINDOW_MARGIN,
  };
  const ratio = width / height;
  if (!(width > 0) || !(height > 0) || !Number.isFinite(ratio)) {
    return { ...MIRROR_WINDOW_FALLBACK_SIZE };
  }
  if (!(available.width > 0) || !(available.height > 0)) {
    return { ...MIRROR_WINDOW_FALLBACK_SIZE };
  }
  // 谁先到边界谁定：先按高铺满，等比出来的宽超出可用宽就改用宽为准。
  const fittedHeight = Math.min(available.height, available.width / ratio);
  // 极端比例（带鱼屏那类）等比后会算出 0：窗口不能 0 边，留 1px 让 BrowserWindow 的 min 去收。
  return {
    width: Math.max(1, Math.round(fittedHeight * ratio)),
    height: Math.max(1, Math.round(fittedHeight)),
  };
}
