import { normalizeScrcpyConfig, resolveVideoCodec } from "../../shared/scrcpyConfig.js";

// ---------------------------------------------------------------------------
// ScrcpyConfig → scrcpy-server 参数（自研客户端）
//
// 纯映射，不依赖 Electron / Tango：这里只产出 scrcpy 的选项对象（形状是 4.1 那份，随包 5.0.1 server 认同一套），
// 直连形态下由 src/mirror/connect.js 包成 `AdbScrcpyOptions4_1` 交给 Tango。
// 字段名对应 @yume-chan/scrcpy 的 ScrcpyOptions4_1.Init。
// ---------------------------------------------------------------------------

/** scrcpy 码率后缀按十进制换算（与官方 client 的 parse_bit_rate 一致）。 */
const BIT_RATE_UNITS = { K: 1_000, M: 1_000_000, G: 1_000_000_000 };
const DEFAULT_BIT_RATE = 8_000_000;

/** 「手机屏幕上打开 + 镜像主屏」的版本上限：Android 13 = API 33。 */
export const MAIN_DISPLAY_MIRROR_MAX_SDK = 33;

/**
 * 这一档设备上点应用不再建虚拟显示，改成「在手机屏幕上打开它 + 镜像主屏」（用户 2026-10-09 定）。
 * 14 起 scrcpy 建虚拟显示才会自动补上 `OWN_FOCUS`（`NewDisplayCapture` 里 `SDK_INT >= API_34`
 * 那一段），13 及以下那块显示拿不到焦点，per-app 镜像的体验不如直接用手机那块屏。
 * **API 级别读不到（null）回 false**：形态不靠猜，读不到就维持原来的虚拟显示那条路。
 * @param {number | null | undefined} sdk
 */
export function mirrorsMainDisplay(sdk) {
  return Number.isInteger(sdk) && sdk > 0 && sdk <= MAIN_DISPLAY_MIRROR_MAX_SDK;
}

/** 「桌面模式」（= 点应用建虚拟屏那套）的最低 API 级别：Android 14 = API 34。 */
export const DESKTOP_MODE_MIN_SDK = 34;

/**
 * 这台设备能不能进「桌面模式」—— 即从**整机镜像**的悬浮栏里把手机主屏上正在用的应用抽到一块
 * 独立虚拟屏上（与首页点应用同一条路，见 `mirror/session.js` 的 `mirror:desktopMode`）。
 *
 * 门槛与 `mirrorsMainDisplay` 同源同界（34 = Android 14），理由也一样：14 起 scrcpy 建虚拟显示
 * 才会自动补 `OWN_FOCUS`，13 及以下那块显示拿不到焦点。区别只在**读不到版本时这里回 false**
 * —— 那里回 false 的语义是「照旧建虚拟显示」（老行为），这里回 false 的语义是「先不给这个入口」：
 * 版本不明时多给一颗按钮，代价可能是让 13 及以下的用户点开一块操作不了的显示。
 * 用户 2026-10-11 的原话是「安卓 14 往上」，所以宁可少给。
 * @param {number | null | undefined} sdk
 */
export function supportsDesktopMode(sdk) {
  return Number.isInteger(sdk) && sdk >= DESKTOP_MODE_MIN_SDK;
}

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
 * （上游 `Options.parseNewDisplay` 认 `""`、`WxH`、`WxH/dpi`、`/dpi` 四种**值**，加上「不发这个键」
 * 一共五种形态，语义见 `buildMirrorOptions`）。
 * **密度由调用方给全**：上游那份 `scaleDpi`（缺密度时按长边等比缩）**只在非 flex 那条路跑**
 * —— `NewDisplayCapture.prepare()` 对 `dpi == 0` 的 flex 直接断言，而 release 包断言是关的，
 * 实测 flex + 只给尺寸会静默退成基准密度 160（长边 dp 数爆掉，应用被当成超大屏）。
 * 我们这两条**给了尺寸**的路都带 `flex_display`（默认 = 物理像素 + `scaleDisplayDpi`，大屏 = CSS × 档位倍率），
 * 所以尺寸与密度必须同源，见 `buildMirrorOptions` 与 `shared/scrcpyConfig.js`。
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
 * @param {{ videoCodec?: string, display?: { width: number, height: number, dpi: number }, deviceMirror?: boolean }} overrides
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
    // ⚠️ **镜像会话永远不带音频**（2026-10-14 第三条）。音频在 Android 上是**设备级**的：
    // 只有一条 `AUDIO_DEVICE_OUT_REMOTE_SUBMIX`，同一台设备上两条会话各自采集会互相破坏 ——
    // 真机受控实验（Mi 10 / 随包 5.0.1，`dumpsys media.audio_policy`）：
    // - 两条采集同时 `Active` 时**拿到的是同一份混音** ⇒ 两个窗口各播一遍 = 用户报的「声音重叠了」；
    // - **释放任意一条**后 AudioPolicy 把 `AUDIO_DEVICE_OUT_REMOTE_SUBMIX` 整条输出拆掉、
    //   应用输出回到 `SPEAKER`，剩下那条采集从此静音 ⇒ 用户报的「关掉一个镜像，声音又从电脑回到了手机」。
    // ⇒ 音频改由**该设备唯一的那条音频会话**负责（`buildAudioOnlyOptions`），它由该设备**最早打开的
    // 镜像窗口**承载、窗口关掉时移交给下一个（`electron/mirror/session.js` 的 `audioHost`）。
    // 设置页那一项（`config.audio`）现在决定的是**要不要起那条音频会话**，见 `resolveRuntimePrefs`。
    audio: false,
    control: true,
    sendStreamMeta: true,
    videoCodec: config.videoCodec,
    videoBitRate: parseBitRate(config.bitRate),
    maxFps: config.maxFps,
  };

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
  // （2026-09-28「不留兜底默认尺寸」那条教训）。
  //
  // **采主屏（`deviceMirror`）走另一条路：连 `new_display` 这个键都不发。**
  // 两种情形到这里合流：整机镜像（包名为空），以及 Android 13 及以下点应用（`mirrorsMainDisplay`）。
  // 上游的分叉点是**这个键在不在**（`Server.java:144-149`：`options.getNewDisplay() != null`
  // → `NewDisplayCapture`，否则 → `ScreenCapture` 采集主屏）。实测随包 5.0.1 官方产物也一致：
  // 不发键 → server stdout `Display: using SurfaceControl API`、没有 `New display: … (id=N)` 那行；
  // 发空串 → 仍新建一块主屏尺寸的虚拟显示（那是「空字符串」这个**值**的语义，不是「没有虚拟显示」）。
  // 于是没有可 resize 的显示（`flex_display` 与「跟随窗口」整块不适用，服务端 `requestResize`
  // 对非 flex 显示直接抛错）、没有「这块显示上的应用」概念（调用方据此跳过接回），
  // 窗口改大小只是本地缩放主屏画面。`vd_system_decorations` 只作用于新建显示，同样不发。
  // 带着包名时 `startApp` 照发：服务端 `getStartAppDisplayId()` 在没有新建显示时用 `display_id`
  // 的缺省值 0，也就是**在手机屏幕上打开这个应用**。
  if (overrides.deviceMirror) {
    if (overrides.display) throw new Error("主屏镜像不建虚拟显示，display 必须为空");
    return options;
  }

  options.newDisplay =
    overrides.display || config.largeScreenDisplay ? formatNewDisplay(overrides.display) : "";
  if (overrides.display) options.flexDisplay = true;

  // 虚拟显示不渲染系统装饰（scrcpy 的 `--no-vd-system-decorations`）：镜像里不要头部那条状态栏，
  // 整块显示都留给应用。代价：那块显示上没有状态栏也没有 launcher 兜底，导航只能靠注入的手势/键值。
  options.vdSystemDecorations = false;

  return options;
}

/**
 * **设备级音频会话**用的 jar 路径。
 *
 * 为什么不与主会话共用 `DefaultServerPath`：scrcpy server **一启动就把自己那份 jar 删掉**
 * （`Server.java` 的 `CleanUp.unlinkSelf()`，所以「推一次两条会话共用」不是优化 —— 第二条
 * 不重推就是 `ClassNotFoundException`，实测 server 直接 `Aborted`）。分成两个路径之后，
 * 两条会话可以**并行**建：实测并行推两份 733KB jar 与推一份同为 ~1.28s，
 * 两条会话 `start()` 合计 ~0.31s，第一条音频包落在 ~1.72s —— 与单条视频会话同时。
 */
export const AUDIO_SERVER_PATH = "/data/local/tmp/scrcpy-server-audio.jar";

/**
 * **设备级音频会话**的 server 选项（用户 2026-10-14 第三条报障的修法）。
 *
 * 为什么不是把音频留在镜像会话里、只是「谁带音频」换个人：`audio_source` 与 `audio` 都是
 * **建会话时定死**的，控制协议里没有任何音频路由消息（随包 5.0.1 `Controller.java` 那串
 * `TYPE_*` 里没有）⇒ 想让某条已经在跑的会话「开始/停止出声」只能整条重来（视频会断、
 * 桌面模式那块虚拟显示与上面的应用还得重建）。所以音频单独一条会话，接管时只动音频。
 *
 * 采集口径与原来一致：`audio_source=output` 走 `AudioDirectCapture`（`REMOTE_SUBMIX` 直采）
 * ⇒ 采到回环就不再渲染到设备，投屏期间手机静音、声音只在电脑上出。故意**不**开 `audioDup`
 * （scrcpy 默认；`audio_dup` 是 `playback` 源那一支的 `ROUTE_FLAG_LOOP_BACK_RENDER`，
 * 对直采源是空操作，用户 2026-09-21 要的正是「投屏时手机不出声」）。
 *
 * ⚠️ `sendDeviceMeta: false` 是**必须**的：上游把 64 字节设备名写在**第一个 socket** 上，
 * 没有视频时那就是音频 socket，客户端会把设备名的头 4 字节当成编码号
 * （真机报 `Unknown audio codec metadata value: 1298735153` = `0x4D692031` = "Mi 1"）。
 * @returns {Record<string, unknown>}
 */
export function buildAudioOnlyOptions() {
  return {
    video: false,
    audio: true,
    control: false,
    sendDeviceMeta: false,
    sendStreamMeta: true,
    // scrcpy 4.0 起音频仅支持 Opus（`ScrcpyAudioCodec.Opus`），WebCodecs 可解。
    audioCodec: "opus",
    audioSource: "output",
  };
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
    // 设置页那一项「声音输出」（默认开）。2026-10-14 起它的语义变成**要不要起那条设备级音频会话**
    // —— 镜像会话本身恒 `audio: false`（见 `buildMirrorOptions`），音频由该设备最早的窗口承载
    // （`electron/mirror/session.js` 的 `audioHost`，渲染层读这里这一位）。
    audio: config.audio === true,
  };
}

/** 读不到设备画面比例时的窗口形状（既有默认值，不随设备变）。 */
const MIRROR_WINDOW_FALLBACK_SIZE = { width: 850, height: 600 };
/** 窗口照设备比例开时，四周留给系统的余量（菜单栏、Dock、吸附手势）。 */
const MIRROR_WINDOW_MARGIN = 80;

/**
 * 贴在屏幕外沿那圈**黑色边框**的厚度（CSS px，逻辑像素）。
 * 它**常驻**、不随鼠标显隐（用户 2026-10-10：「黑色那一圈边框要永远显示」=「就是个手机样子」），
 * 但占布局 ⇒ 算进窗口尺寸。
 *
 * 2026-10-10 用户把外面那圈**浅色窗口底**（`top 44 / side 16 / bottom 16` + hover 才扩）整块删了，
 * 换成手机右边外面浮着的一条控制长条（`MIRROR_RAIL`，它占窗口宽度，见 `mirrorScreenInsets()`）。
 *
 * **这份数主进程与渲染层共用**：画面那块矩形 = 窗口减掉黑框，而画面矩形是虚拟显示尺寸与触控映射的
 * 输入，两边各写一套数就会在圆角里露出 letterbox 黑条。
 */
export const MIRROR_FRAME = {
  bezel: 4,
};

/**
 * 画面那块矩形（`.mirror-screen`）的圆角半径 —— `App.vue` 的 `--radius`，**这里是唯一出处**
 * （渲染层从 `windowStyle` 取，不再在 CSS 里写死）。
 *
 * ⚠️ **它不只是样式**：圆角切掉的那块是个四分之一圆，圆心在 `(bezel + radius, bezel + radius)`，
 * 点 `(x, y)` 落进被切掉的那块 ⇔ `(x − cx)² + (y − cy)² > radius²`。浮动态下三颗彩虹键是
 * "放进投屏里"的，落点必须在这个圆**内**侧 —— 所以改这个数就得回头验 `floatLightX/Y` 还在圆内
 * （`tests/electron/mirrorOptions.test.js` 有一条钉着这条几何）。
 */
export const MIRROR_SCREEN_RADIUS = 40;

/**
 * 窗口**顶部**那一条：专门放系统那三颗彩虹键 + app 名称（用户 2026-10-12：「试试 a 的变体，
 * 上边加一条专门放三个按钮和 app 名称」）。
 *
 * 它**占布局** ⇒ 进 `mirrorScreenInsets()` 的上边：画面那块矩形 = 窗口 − 这一条 − 四边黑框 − 右边长条，
 * 两边（主进程算的 `initialCss` 与渲染层的 DOM）必须同源，否则画面里会露出一条 letterbox。
 * `height` 与三颗的关系：三颗约 14 高，垂直居中 ⇒ `lightTop = (height − 14) / 2`。
 *
 * ⚠️ **长条浮在画面里那一档（`mirrorRailFloats`）这整条不存在**（用户 2026-10-14 第二条：
 * 「上边头部就去掉，mac 的 3 个按键放进投屏中，标题去掉」）：窗口没有标题栏 ⇒
 * `mirrorScreenInsets(true).top` 只剩黑框，三颗改落在**画面**左上角（落点见 `floatLightX/Y`），名称整块不画。
 * 代价是**没有标题栏那条拖窗区**了 —— 补一条看不见的顶边条接（`floatDragHeight`，见下面那个字段）。
 */
export const MIRROR_TITLEBAR = {
  // 用户 10-12：「上边高度窄一点」⇒ 从照抄竞品的 41 收到 28（macOS 隐藏式标题栏的常见高度，
  // 三颗约 14 高，上下各留 7 正好垂直居中）。
  height: 28,
  /**
   * 顶部这一条里**最上面那 12px 不当地窗拖区，专门留给 hover 触发**（用户 10-12「鼠标移动到
   * 右侧和上边都要展示边框」，10-12 实测才定位到根因）：整条 `-webkit-app-region: drag` 时
   * Chromium **不把指针事件送进 DOM**（探针：从画面中间一步一步移到 y=14，一路只有 y≥30 的事件，
   * 进到 drag 区那一步连 `pointermove` 都没有）⇒ "贴上边"这条臂永远收不到信号，chrome 不出来。
   * 所以真正算触发区的只有这 `revealHeight` 那一截（`no-drag`，见 `App.vue` 的 `.mirror-titlebar__reveal`），
   * 剩下 16px 照样能拖着窗口走。
   */
  revealHeight: 12,
  /** 最左那颗的 x（从窗口内容区左沿量，AppKit 那个坐标系的惯例）。 */
  lightX: 12,
  /** 三颗**整组**的实测宽（Electron 44 / macOS 27：约 58，间距与大小都动不了，只能整组平移）。 */
  lightGroupWidth: 58,
  /** 名称与三颗之间留这一点。 */
  nameGap: 10,
  /**
   * **浮动态**顶边那条**看不见的拖窗区**：整窗宽 × 这么高（CSS px）。
   *
   * 为什么要有它：浮动态整条标题栏都不存在（见上面那段），拖窗区跟着一起没了 —— 窗口拖不动。
   * 用户 2026-10-14 第四条定的形状是**顶边整条**（「像标题栏一样抓顶边就能拖」），
   * 代价 = 画面顶部这 18px 收不到触控（通知栏那条还有下面一截可拉）。
   *
   * ⚠️ **第一版是左上角 80×28 的小方块**（宽 = `mirrorTitlebarNameLeft()`），被用户当场打回
   * （「app 投屏后不能拖拽了」）：那块地方**本来就盖着三颗彩虹键**，而三颗是 AppKit 画在网页内容
   * **之上**的 ⇒ 方块中间那一大块根本抓不到，剩下的只是几条缝。现在改成整条之后三颗也不再压它
   * （落点下移到 `floatLightY`）。
   *
   * ⚠️ 高度**跟着三颗的纵坐标走**（用户 10-14 第五、六条把三颗一路上移）：三颗一上移，这条的下沿
   * 也跟着收，等式 `floatLightY === floatDragHeight` 继续成立 —— 否则三颗会重新压进拖窗区，
   * 而 AppKit 按钮吃事件 ⇒ 三颗那一列又拖不动了。
   */
  floatDragHeight: 12,
  /**
   * **浮动态**下三颗的落点（窗口内容区左上角，单位 CSS px）。
   *
   * 浮动态窗口顶就是画面顶（`mirrorScreenInsets(true).top` 只剩 4px 黑框）⇒ 三颗是"放进投屏里"的，
   * 必须落在**画面那块圆角矩形**内。画面在 `(bezel, bezel)`、圆角半径 40（`App.vue` 的 `--radius`），
   * 那个四分之一圆的圆心在 `(44, 44)`：点 `(x, y)` 落进被圆角切掉的那块 ⇔ `(x−44)² + (y−44)² > 40²`。
   *
   * 原值 `(12, 7)`（= 窗口态那套）距圆心 48.9 > 40 ⇒ **红灯一半压在黑色圆角外面**（用户 2026-10-14
   * 第四条报障「超出屏幕了」）。第四条先挪到 `(24, 24)`（红灯圆心距圆心 18.4，圆最外沿 25.4 < 40
   * ⇒ 余量 ~14.6px）；**第五条往右、往上各挪 6px 成 `(30, 18)`**（用户：「mac 彩虹按钮往右移点，
   * 往上移点」，余量 ~12.7px）；**第六条再往右上各挪 6px 成 `(36, 12)`**（用户：「三个按键离设备画面
   * 太近，往右上调整一点」）—— 红灯圆心 `(43, 19)` 距圆心 25.0、圆最外沿 32.0 < 40 ⇒ 余量 ~8px，
   * 仍安全，但**再往右上挪就会撞那条 ≥5px 余量的判据**（`mirrorOptions.test.js` 里钉着）。
   *
   * 纵坐标同时是**顶边那条拖窗区的下沿**（`floatDragHeight`）—— 三颗正好让开它，整条都能拖。
   */
  floatLightX: 36,
  floatLightY: 12,
};

/** app 名称的左起位置：让开三颗（名称是我们画的，落点自己算）。 */
export function mirrorTitlebarNameLeft() {
  return MIRROR_TITLEBAR.lightX + MIRROR_TITLEBAR.lightGroupWidth + MIRROR_TITLEBAR.nameGap;
}

/**
 * 三颗彩虹键的落点（`BrowserWindow` 的 `trafficLightPosition`）。
 *
 * ⚠️ **两档形态两个落点**（用户 2026-10-14 第四条）：
 * - **窗口态**：钉在顶部标题栏里、垂直居中（`(12, 7)`）。
 * - **浮动态**：标题栏整条不存在、窗口顶就是画面顶 ⇒ 落点得让开画面的圆角（`floatLightX/Y`）。
 *
 * ⚠️ **两档都与窗口宽无关**（这是当初选顶部条、不选右侧长条的第二个理由）：10-10 那套把它们贴进
 * 右侧长条，落点是 `窗口宽 − 长条宽 + 内缩` ⇒ 每次 resize 都得重算一次，漏一次就留在旧位置。
 * 现在两个落点都是常量，`resize` 什么都不用做；**翻转形态时要重设一次**（见
 * `session.js` 的 `mirror:windowButtons` 与建窗那处）。
 *
 * @param {boolean} [railFloating] 长条是不是浮在画面里（见 `mirrorRailFloats`）
 * @returns {{ x: number, y: number }}
 */
export function mirrorTrafficLightPosition(railFloating = false) {
  if (railFloating === true) {
    return { x: MIRROR_TITLEBAR.floatLightX, y: MIRROR_TITLEBAR.floatLightY };
  }
  return { x: MIRROR_TITLEBAR.lightX, y: Math.round((MIRROR_TITLEBAR.height - 14) / 2) };
}

/**
 * 手机**右边**那条悬浮控制长条（返回/Home/多任务 + 那几颗开关，用户 2026-10-10 定）。
 * 它**占窗口宽度**（用户 10-10 第二次定稿：「任何 UI 都不要在手机里出现，都移到外边」⇒ 只能挤到画面外），
 * 所以它进 `mirrorScreenInsets()` 的右边：窗口 = 画面 + 黑框 + 这条。
 * 唯一进主进程的另一件事是红绿灯的落点 —— 那三颗是系统画的，CSS 盖不住。
 */
export const MIRROR_RAIL = {
  /**
   * 长条格子宽（占布局那一格，面板在它里面左右各留 6px）。
   * ⚠️ 红绿灯**不再进这套算术**（用户 2026-10-11：「3 个彩虹按键恢复默认，不要有任何修改」）：
   * 之前 86 的下限是「三颗约 58 宽 + 居中留白」，现在三颗归 AppKit 放左上角，这个数只剩面板自己的手感值。
   */
  width: 86,
  /**
   * 淡入 / 淡出各多久（CSS 与「红绿灯延后藏起来」共用这两个数）。
   * 出去比进来慢一档：出现要跟手，消失要收得干净（用户 10-10「消失的时候感觉不太协调」）。
   */
  fadeInMs: 180,
  fadeOutMs: 260,
};

/**
 * 长条**浮在画面里**的阈值（用户 2026-10-14：「如果手机投屏宽度足够宽，那就把手机投屏右侧的操作栏
 * 更改为全屏时在投屏里浮动的样子」）。
 *
 * 单位是**画面宽**（CSS px）。窄画面（普通竖屏手机窗口，画面约 360–420 宽）浮起来要盖掉画面五分之一
 * 以上，仍旧摆在窗口右边那一格；宽到 640 才换成满屏那套「白胶囊浮在画面右上」。
 */
export const MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH = 640;

/**
 * 窗口边 → 画面边的总内缩：四边是那圈常驻黑框，**右边再多一条长条宽**、**上边再多一条标题栏**。
 * 右边不对称是故意的：长条在手机右边外面，画面矩形才等于设备比例那块。
 *
 * @param {boolean} [railFloating] 长条是不是浮在画面里（见 `mirrorRailFloats`）。这一档**两截一起让掉**
 *   （用户 2026-10-14 第二条：长条浮起来时「上边头部去掉、mac 三颗放进投屏、标题去掉」）：
 *   右边那 86px 归画面（窗口因此窄 86px，宽不够时是画面吃掉它，见 `mirrorWindowBounds`），
 *   上边那 28px 的标题栏整条不存在 ⇒ 只剩黑框。两者是同一件事的两面：**没有 chrome 占位的窗口**。
 */
export function mirrorScreenInsets(railFloating = false) {
  const { bezel } = MIRROR_FRAME;
  const floating = railFloating === true;
  return {
    // 上边多一条标题栏（三颗彩虹键 + app 名的地盘，见 `MIRROR_TITLEBAR`）；浮动态那条整块没有。
    top: bezel + (floating ? 0 : MIRROR_TITLEBAR.height),
    bottom: bezel,
    left: bezel,
    right: bezel + (floating ? 0 : MIRROR_RAIL.width),
  };
}

/**
 * 「长条该不该浮在画面里」—— **全项目唯一一处判据**：主进程建窗口时算一次，渲染层实时跟着窗口大小算
 * （`mirror:railFloat` 再把结论报回来重设比例锁）。
 *
 * 入参是**画面区那一格的宽**（= 窗口内容宽 − dev 边栏）：窗口态就是「画面 + 右边那条长条」合起来能用
 * 的宽。渲染层量的是 `.mirror-main` 的 `clientWidth` —— ⚠️ **别拿画面本身的宽来判**：长条一浮起来
 * 画面自己就宽 86px，判据会被自己的结果推着走。
 *
 * ⚠️ **两个形态各有一条线（迟滞）**，不是一条：`previous` = 上一次的结论，它决定按哪套内缩把「长条
 * 占的那一截」扣掉 —— 在外面扣 94（黑框 8 + 长条 86），浮着时只扣 8（这条判据只看**左右**两截，
 * 上边那一截虽然也随形态变，但不进这里）。若一律按同一个口径判，跨过临界点
 * 会来回跳：比例锁的余量也跟着形态差一条长条宽，拖上下边时窗口宽是由高推出来的，正好是那条会自己跳
 * 的路径。分两条线之后两个方向各有一个不动点，且**浮着的时候画面一定 ≥ 阈值**（用户 2026-10-14 选的那条）。
 *
 * @param {number} screenAreaWidth 画面区那一格的宽（CSS px）
 * @param {boolean} [previous] 上一次的结论；窗口刚开出来时传 false = 「长条在外面」那套几何
 * @returns {boolean}
 */
export function mirrorRailFloats(screenAreaWidth, previous = false) {
  const width = Number(screenAreaWidth);
  // 量不到宽（还没排版 / 非法值）时维持"在外面"：窄的那一档是安全侧，浮起来是盖住画面的那个动作。
  if (!(width > 0)) return false;
  const { left, right } = mirrorScreenInsets(previous === true);
  return width - left - right >= MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH;
}

/**
 * 拖拽锁比例时**不参与比例**的那一圈固定余量（`BrowserWindow.setAspectRatio` 的第二个参数）。
 *
 * 锁的是**画面那块矩形**（= 内容区减掉 `mirrorScreenInsets()`），因为手机比例说的是画面，不是窗口：
 * 窗口比画面多出四边的黑框与右边那条长条，这些宽度是写死的、不随窗口缩放。
 * dev 调试边栏撑宽的也是窗口而不是画面，所以调用方把那一截作为 `extraWidth` 加进来。
 *
 * @param {number} [extraWidth] 画面之外额外占窗口宽的截（dev 边栏），0 = 没有
 * @param {boolean} [railFloating] 长条浮在画面里时**右边与上边那两截都不算余量**（那 86px 与 28px
 *   已经归画面了）—— 漏改这一项，「画面 = 设备比例」这条等式当场破掉（画面比设备比例宽一条长条、
 *   高一截标题栏，圆角里露出 letterbox 黑条）。
 */
export function mirrorContentExtraSize(extraWidth = 0, railFloating = false) {
  const { left, right, top, bottom } = mirrorScreenInsets(railFloating);
  const extra = Number(extraWidth) || 0;
  return { width: left + right + Math.max(0, extra), height: top + bottom };
}

/**
 * 设备画面比例（`wm size` 的 Physical）。读不到就返回 0 = **不锁比例**
 * （`setAspectRatio(0)` 是上游给的「取消比例」那档），不自己编一个比例。
 * @param {{ width?: number, height?: number } | null} screenSize
 * @returns {number}
 */
export function mirrorAspectRatio(screenSize) {
  const width = Number(screenSize?.width);
  const height = Number(screenSize?.height);
  if (!(width > 0) || !(height > 0)) return 0;
  const ratio = width / height;
  return Number.isFinite(ratio) ? ratio : 0;
}

/**
 * 镜像窗口的初始尺寸：把**画面**照设备画面比例等比 fit 进「可用区减系统余量减那圈常驻黑框」，
 * 再把黑框加回窗口上（2026-10-07 定比例、2026-10-10 删掉外扩那一圈后只剩黑框）。
 *
 * 为什么窗口要先照比例开好，而不是先开一块再等第一帧收一次：默认模式的虚拟显示尺寸取自
 * **窗口画面区的物理像素**，窗口是横的就开出一块横显示 —— 竖屏 app 立刻换版式，等第一帧再收
 * 回来等于让人看一次错误形状（那一版当天就被替掉了）。
 * 为什么黑框要参与计算：窗口 = 画面 + 黑框，画面才正好是设备比例；反过来（窗口照比例开、
 * 里面再留一圈）画面会比设备比例更窄，圆角里就多出黑条。
 *
 * 读不到设备比例就退回 `850x600`（这一档是**窗口**尺寸），并且渲染层拿不到比例时**不给显示尺寸**
 * （`new_display` 退空串 = 上游默认的主屏尺寸与密度），两边都不自己编数字。
 * @param {{ width: number, height: number } | null} screenSize 设备物理分辨率（`wm size` 的 Physical）
 * @param {{ width: number, height: number } | null} workArea 该屏幕可用区
 * @param {boolean} [railFloating] 长条浮在画面里（见 `mirrorRailFloats`）：右边不留那一格、上边不留标题栏，
 *   空出来的 86px 归画面、28px 归画面高 —— 宽不够（横形显示/宽窗口）时画面自己吃掉，宽够（竖形显示）时
 *   窗口跟着窄 86px。⚠️ 调用方要拿**同一个** `railFloating` 去算 `initialCss` 与比例锁，否则三者各按一套几何算。
 * @returns {{ width: number, height: number }}
 */
export function mirrorWindowBounds(screenSize, workArea, railFloating = false) {
  const width = Number(screenSize?.width);
  const height = Number(screenSize?.height);
  const insets = mirrorScreenInsets(railFloating);
  const available = {
    width: Number(workArea?.width) - MIRROR_WINDOW_MARGIN - insets.left - insets.right,
    height: Number(workArea?.height) - MIRROR_WINDOW_MARGIN - insets.top - insets.bottom,
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
    width: Math.max(1, Math.round(fittedHeight * ratio)) + insets.left + insets.right,
    height: Math.max(1, Math.round(fittedHeight)) + insets.top + insets.bottom,
  };
}
