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
 * **独立虚拟屏**（点应用 / 桌面模式）那档窗口的**固定尺寸**（用户 2026-10-16：「宽度调成920px。
 * 高度按 mac 屏幕比例调整」→ 随即「高度调整到660」）。宽高都点名，所以这一档的窗口形状是**常量**。
 *
 * 为什么这一档的窗口形状不跟设备屏走：它建的是一块**我们自己的** flex 显示（`new_display` + `flexDisplay`），
 * 窗口形状就是那块显示的形状 —— 跟手机那块屏没有对应关系。「窗口必须与手机那块屏一一对应」是**采主屏**
 * 那档的事（整机镜像 / 13 及以下点应用，见 `mirrorAspectRatio` 那条锁）。
 *
 * 历史（别照着旧记录找）：这一档先后试过「照设备屏比例缩到 0.75」（`MIRROR_VIRTUAL_WINDOW_SCALE`）、
 * 「设备屏比例转置」（`mirrorLandscapeSize`）、「宽 920 + 高按 Mac 屏比例」（`getPrimaryDisplay().size`），
 * 都被用户换掉了 —— 现在就是这两个常量，**不读设备分辨率也不读 Mac 分辨率**来定窗口形状。
 */
export const MIRROR_VIRTUAL_WINDOW_WIDTH = 920;
/** 见上面那段：高度也是点名值（`MIRROR_VIRTUAL_WINDOW_WIDTH` 的兄弟，一起改才有意义）。 */
export const MIRROR_VIRTUAL_WINDOW_HEIGHT = 660;

/**
 * 贴在屏幕外沿那圈**黑色边框**的厚度（CSS px，逻辑像素）—— **2026-10-16 起为 0**。
 *
 * 用户这一轮点单：「镜像投屏的时候将黑色手机边框去掉」⇒ 画面直接铺满窗口，窗口里只剩投屏本身。
 * 之前它是 4（用户 2026-10-10：「黑色那一圈边框要永远显示」=「就是个手机样子」），
 * 那套「手机样子」随这一轮一起退场了。
 *
 * ⚠️ 这个数**主进程与渲染层共用**（渲染层从 `windowStyle` 取 `--bezel`，画在 `.mirror-frame` 的
 * `border` 上）：它是「画面那块矩形 = 窗口减掉什么」的输入，而画面矩形又是虚拟显示尺寸与触控映射的
 * 输入，两边各写一套数就会在圆角里露出 letterbox 黑条。现在两边都是 0 ⇒ 画面 = 窗口。
 * 常量留着（而不是删掉）是因为调用链还引用它（`mirrorScreenInsets` / `windowStyle` / 满屏那档的
 * `box-shadow`），将来若要恢复内缩，改这一个数即可。
 */
export const MIRROR_FRAME = {
  bezel: 0,
};

/**
 * 画面那块矩形（`.mirror-screen`）的圆角半径 —— `App.vue` 的 `--radius`，**这里是唯一出处**
 * （渲染层从 `windowStyle` 取，不再在 CSS 里写死）。
 *
 * 2026-10-16 一天里动过两次：40 → 12（用户当场在「保留 40 / 改成 12 小圆角 / 直角」里点了小圆角，
 * 黑框去掉之后画面就是窗口的全部，40 那圈显得像一张卡片）→ **20**（同日用户看过后又点
 * 「圆角稍微大点」，12 太小、像刀切的直角）。**2026-10-17 又点「投屏圆角再圆一点」⇒ 20 → 28**
 * （20 看了一天觉得还是偏方；28 仍远小于被否掉的 40）。
 *
 * ⚠️ **它不只是样式**：圆角切掉的那块是个四分之一圆，圆心在 `(bezel + radius, bezel + radius)`，
 * 点落进被切掉的那块 ⇔ 落在圆心那个方角里、且 `(x − cx)² + (y − cy)² > radius²`。三颗彩虹键是
 * "放进投屏里"的（`floatLightX/Y`），落点必须避开这块 —— 半径越大、方角越大，判据越紧
 * （`tests/electron/mirrorOptions.test.js` 有一条钉着这条几何，见 `mirrorTrafficLightPosition` 那组）。
 * ⚠️ 半径 20 那会儿有一条**充分不必要**的捷径判据：「x 或 y 有一个 ≥ 半径 ⇒ 必在区外」。
 * 2026-10-17 半径到 28、同时三颗又往左挪到 `x = 20 < 28` ⇒ **那条捷径不再成立**，别再拿它当判据 ——
 * 现在按**定义**算：取整组离弧心最近的那个角（左上角 `(floatLightX, floatLightY)`，因为该角到弧心的
 * 距离在整块矩形里最大），只要它到 `(r, r)` 的距离 ≤ r，整组就都在弧内侧（= 没被啃掉）。
 * 现值 `(20, 16)` 到 `(28, 28)` 的距离 ≈ 14.4 < 28 ✓（离弧还有 ~13.6px 余量）。
 */
export const MIRROR_SCREEN_RADIUS = 28;

/**
 * 三颗彩虹键的直径（CSS px）—— **系统（AppKit）画的**，我们只能整组平移，尺寸与间距都动不了。
 *
 * 2026-10-16 从散在各处的字面量抽出来（以前窗口态写 `(height − 14) / 2`、测试里写 `lightRadius = 7`）：
 * 现在有两处要它 —— 窗口态靠它算垂直居中，顶部那条胶囊靠它算「与三颗中线对齐」的落点
 * （见 `mirrorRailTop`）。
 */
export const MIRROR_TRAFFIC_LIGHT_SIZE = 14;

/**
 * 窗口**顶部**那一条：专门放系统那三颗彩虹键 + app 名称（用户 2026-10-12：「试试 a 的变体，
 * 上边加一条专门放三个按钮和 app 名称」）。
 *
 * 它**占布局** ⇒ 进 `mirrorScreenInsets()` 的上边：画面那块矩形 = 窗口 − 这一条 − 四边黑框 − 右边长条，
 * 两边（主进程算的 `initialCss` 与渲染层的 DOM）必须同源，否则画面里会露出一条 letterbox。
 * `height` 与三颗的关系：三颗约 14 高（`MIRROR_TRAFFIC_LIGHT_SIZE`），垂直居中 ⇒
 * `lightTop = (height − 尺寸) / 2`。
 *
 * ⚠️ **2026-10-16 起这一条在实际窗口里不再出现**（`mirrorRailFloats` 恒真 ⇒ 永远走"浮动态"那套：
 * 标题栏整条不画、三颗落进画面左上角）。它现在只剩两个用途：① 窗口态那套落点 `(12, 7)` 的算式；
 * ② `mirrorTrafficLightPosition` 的 `false` 分支。保留是因为 `mirror:windowButtons` 的载荷仍带
 * `railFloating`，删掉这半套要一起动 IPC 链路 —— 这一轮只改外观，没动它。
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
   * **浮动态**顶边那条：整窗宽 × 这么高（CSS px）—— 它同时是**拖窗区**与**chrome 的显形触发区**。
   *
   * 为什么要有它：浮动态整条标题栏都不存在（见上面那段），拖窗区跟着一起没了 —— 窗口拖不动。
   * 用户 2026-10-14 第四条定的形状是**顶边整条**（「像标题栏一样抓顶边就能拖」），
   * 代价 = 画面顶部这一条收不到触控（通知栏那条还有下面一截可拉）。
   *
   * ⚠️ **第一版是左上角 80×28 的小方块**（宽 = `mirrorTitlebarNameLeft()`），被用户当场打回
   * （「app 投屏后不能拖拽了」）：那块地方**本来就盖着三颗彩虹键**，而三颗是 AppKit 画在网页内容
   * **之上**的 ⇒ 方块中间那一大块根本抓不到，剩下的只是几条缝。改成整条之后三颗收进画面左上角
   * （`floatLightX/Y`）—— 但**不是"让开"**：第十一条起它们压在这条里（见下面那段）。
   *
   * ⚠️ **2026-10-17 第十一条起，三颗压进这条里面**（用户「3个彩虹按钮和悬浮操作栏往上移一点，
   * 拖拽高度再加5px」）：两个要求方向相反 —— 三颗上移是把顶边往上抬、加高是把下沿往下推
   * ⇒ 上一轮那条 `floatLightY === floatDragHeight` 的硬等式**就此作废**，重叠量 = 高度 − 三颗顶边。
   *
   * 压进去的代价（**探针台实测，2026-10-17**，建窗参数照抄 `createMirrorWindow`）：三颗是 AppKit
   * 画在网页**之上**的，但它**只吃掉"按下"**（NSButton 处理 mouseDown），**移动事件照常进 DOM** ——
   * 指针从这条滑到三颗上时 `pointermove` 照发、`pointerleave` **不触发**（探针日志：只有
   * `pointermove @(27,23)`，无 leave；停在灯上 1.5s 也一条都不发）。⇒ ① hover 显形**不会闪断**；
   * ② 三颗盖住的那一小块（宽 `lightGroupWidth`、高 = 重叠量）**按下拖不动窗口**（点上去就是点灯）
   * —— 那是灯本身的地盘，且灯一直可见，可接受。
   * ⚠️ 早前那条"AppKit 按钮吃事件 ⇒ 三颗那一列收不到指针"的说法**只对了一半**（吃的是按下）；
   * 前两次"三颗跟着带子一起挪"是照那条推的，这一轮改成"压进去"。
   *
   * 历史：**12 → 16**（2026-10-17 用户「可拖拽高度再加4px」）→ **16 → 21**
   * （同日用户「可拖拽区域再加高5px」）→ **21 → 26**（同日用户「拖拽高度再加5px」）。
   * 前两次是"整条全宽"的加高、三颗跟着让位（等式成立）；这一次三颗同时要上移 ⇒ 压进去。
   * 连带：胶囊跟三颗中线对齐（`mirrorRailTop`）⇒ 一起上移。
   *
   * ⚠️ **2026-10-17 起这条不再是 `-webkit-app-region: drag`**：那一整片是 Chromium 的**事件黑洞**
   * （指针进去一个事件都不发），而用户这一轮要「**鼠标移动到头部可拖拽的地方**就展示出来」——
   * 同一条带既要收 hover 又要能拖，只能二选一。现在改成渲染层自己拖窗（`App.vue` 的
   * `onFloatDragDown` 那一组，`window.moveTo` 实测生效），这一条因此**收得到指针事件**。
   * 取舍与实测见 `docs/NATIVE_MIRROR.md` 第八轮。
   */
  floatDragHeight: 26,
  /**
   * **浮动态**下三颗的落点（窗口内容区左上角，单位 CSS px）。
   *
   * 落点的硬约束是**避开画面左上角那圈圆角切掉的那块**（`MIRROR_SCREEN_RADIUS`，现 28）：
   * 那块是 `[0,r]×[0,r]` 方角里、以 `(r,r)` 为圆心半径 `r` 的弧**外侧**。判据按定义算（见
   * `MIRROR_SCREEN_RADIUS` 那段）：整组离弧心最近的角 = 左上角 `(floatLightX, floatLightY)`，
   * 它到 `(r, r)` 的距离 ≤ r 就没被啃掉（`mirrorOptions.test.js` 里钉着这条）。
   * ⚠️ 别再退回「x 或 y ≥ r」那条捷径 —— 半径 28 之后 `floatLightX = 20 < 28`，捷径已经不成立。
   *
   * 历史（一路是"往右上挪"与"半径变大"在互相挤）：
   * - 原值 `(12, 7)`（= 窗口态那套）：半径 40 时红灯一半压在圆角外 ⇒ 用户 2026-10-14 第四条报
   *   「超出屏幕了」；
   * - 第四条 `(24, 24)` → 第五条 `(30, 18)`（「往右移点，往上移点」）→ 第六条 `(36, 12)`
   *   （「三个按键离设备画面太近，往右上调整一点」）；
   * - **2026-10-16 第七条：`36 → 26`**（用户「彩虹见靠左一点」）。半径同一轮从 12 调到 20；
   * - **2026-10-17 第八条：`26 → 20`**（用户「左上角 mac 3 个彩虹按钮再往左移一点」）。半径同一轮
   *   从 20 调到 28 ⇒ 这次是**半径变大 + 落点左移同时发生**，两条都在挤这个方角；
   * - **2026-10-17 第九条：纵坐标 `12 → 16`**（用户「可拖拽高度再加4px」）。这一条**不是**在挪三颗，
   *   而是拖窗区抬高 4px 之后三颗必须跟着让开它（见 `floatDragHeight` 那段）—— 当时等式是硬的；
   * - **2026-10-17 第十条：纵坐标 `16 → 21`**（用户「可拖拽区域再加高5px」）。同上，还是让开顶边那条；
   * - **2026-10-17 第十一条：纵坐标 `21 → 16`**（用户「3个彩虹按钮和悬浮操作栏往上移一点」）。
   *   这一条**是**在挪三颗（往上），同时那条又加高 5px ⇒ 三颗压进它里面 10px（等式作废，
   *   理由与实测见 `floatDragHeight` 那段）。往上挪对圆角判据是**变安全**的方向。
   *
   * 现值 `(20, 16)` 到弧心 `(28, 28)` ≈ 14.4 < 28 ✓ 仍在弧内侧（离弧还有 ~13.6px 余量）。
   * 判据那条例外测试要求余量 > 5px，别把落点再往左下推。
   *
   * ⚠️ 它**不再**是顶边那条拖窗区的下沿了（`floatDragHeight` 现在 26 > 16）：三颗的上半截压在那条里，
   * 那一小块按下会被 AppKit 吃掉（点上去是点灯）—— 取舍见 `floatDragHeight` 那段。
   * ⚠️ 它是**系统的落点**，横向与我们那条胶囊无关：胶囊只跟 `floatLightY` 对齐中线
   * （`mirrorRailTop`），改 `floatLightX` 不会让胶囊跟着跑。
   */
  floatLightX: 20,
  floatLightY: 16,
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
  return {
    x: MIRROR_TITLEBAR.lightX,
    y: Math.round((MIRROR_TITLEBAR.height - MIRROR_TRAFFIC_LIGHT_SIZE) / 2),
  };
}

/**
 * 画面**顶部右侧**那条悬浮控制胶囊（返回/Home/多任务 + 那几颗开关）。
 *
 * 2026-10-16 从「手机**右边**外面那条占窗口宽度的长条」改成现在这样（用户：「右侧悬浮更改为上方很小的
 * 悬浮，有一种透明玻璃质感」+「浮动到画面顶部右边，跟 mac 3 个彩虹按键对齐」）：
 * - **不占布局**：窗口里只剩画面，胶囊浮在画面之上（`mirrorScreenInsets()` 因此恒为 0）。
 *   玻璃质感也要求它浮在画面上 —— `backdrop-filter` 只有背后有东西可模糊时才成立，
 *   摆在画面外（窗口透明处）就只能退化成半透明白底。
 * - **纵向与三颗彩虹键中线对齐**（`mirrorRailTop`）：视觉上它与那三颗在同一行，不是各占一条。
 * - 尺寸从"内容撑开"来（`height` 是唯一钉死的几何）：按钮数随条件渲染（桌面模式那颗只在采主屏那档出），
 *   所以宽度不写死。
 */
export const MIRROR_RAIL = {
  /** 胶囊高（CSS px）：按钮 22 + 上下各 3 的 padding。 */
  height: 28,
  /** 胶囊右缘距窗口右缘。右边没有圆角让位的问题，12 就够（不再与三颗的 `floatLightY` 同数：
   *  那一位 2026-10-17 跟着顶边那条挪过三次（12 → 16 → 21 → 16），而右边沿与它无关，没理由跟着动）。 */
  right: 12,
  /**
   * 命中区外扩（CSS px）：胶囊很小，鼠标要"移入按钮区域"才淡入（用户这一轮点的显隐方式），
   * 不外扩一圈就很难命中，所以命中区 = 胶囊 + 这一圈。
   */
  hitPad: 8,
  /**
   * **满屏那一档**长条占的那一格宽（渲染层的 `--rail-w`）。
   *
   * ⚠️ 窗口态**不再用它**（胶囊浮在画面上、不占布局，宽度由内容撑开）。它活下来只因为真全屏那屏
   * 是「画面一格 + 长条一格」的两格排法（用户 2026-10-11：「不要覆盖掉右侧操作按钮」⇒ 长条自己
   * 占一格，画面永远不进那一截），那一格得有个宽度。满屏那两档这一轮没动。
   */
  fullscreenWidth: 86,
  /**
   * 淡入 / 淡出各多久（CSS 与「红绿灯延后藏起来」共用这两个数）。
   * 出去比进来慢一档：出现要跟手，消失要收得干净（用户 10-10「消失的时候感觉不太协调」）。
   */
  fadeInMs: 180,
  fadeOutMs: 260,
};

/**
 * 胶囊**顶边**距窗口顶的距离 —— 由「与三颗彩虹键中线对齐」反推（用户 2026-10-16：
 * 「浮动到画面顶部右边，跟 mac 3 个彩虹按键对齐」）。
 *
 * 三颗的中线 = `floatLightY + 灯径/2`；胶囊中线 = `top + height/2`。两者相等 ⇒
 * `top = floatLightY + 灯径/2 − height/2`。本机现值 = `16 + 7 − 14 = 9`
 * （三颗 2026-10-17 跟着顶边那条挪过三次 12 → 16 → 21，第十一条又自己上移回 16 ⇒ 胶囊一路跟着走，
 * 这一条是自动的）。
 *
 * ⚠️ 它**不占布局**（胶囊是浮在画面上的），所以不进 `mirrorScreenInsets()` —— 画面该多高还是多高，
 * 代价只是画面顶部右侧那一小块被盖住（那正是"悬浮"的含义）。
 * @returns {number} 胶囊顶边（CSS px，整数）
 */
export function mirrorRailTop() {
  const center = MIRROR_TITLEBAR.floatLightY + MIRROR_TRAFFIC_LIGHT_SIZE / 2;
  return Math.round(center - MIRROR_RAIL.height / 2);
}

/**
 * 窗口边 → 画面边的总内缩。
 *
 * ⚠️ **2026-10-16 起恒为 0（画面 = 窗口）**：黑框去掉（`MIRROR_FRAME.bezel = 0`）、长条改成浮在画面上的
 * 胶囊（不占位）、标题栏随"两档形态"退场（`mirrorRailFloats` 恒真 ⇒ 永远走那条把两条 chrome 都让掉的
 * 分支）。函数保留而不是删掉，是因为调用点很多（`initialCss` / 比例锁 / `mirrorWindowBounds` /
 * 渲染层的布局），删它要一起动那条链；将来若要恢复内缩，改这里一处即可。
 *
 * @returns {{ top: number, bottom: number, left: number, right: number }}
 */
export function mirrorScreenInsets() {
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

/**
 * 「长条该不该浮在画面里」—— **2026-10-16 起恒为 `true`**。
 *
 * 这个判据本来是「画面宽 ≥ 640 就把右侧长条改成浮在画面里」（用户 2026-10-14）。这一轮用户把长条整个
 * 换成「浮在画面顶部右侧的小胶囊」⇒ 它**永远不占布局**，两档形态的分化随之退场，判据失去分辨力。
 *
 * ⚠️ 函数与调用链**保留**（主进程建窗那一拍、渲染层实时判、`mirror:railFloat` 报回、比例锁余量）：
 * 那几处仍需一个布尔来选内缩与三颗落点，而现在两者恒为同一套值。删它要一起动 IPC 链路，
 * 这一轮只改外观，没动。
 * @returns {boolean} 恒 `true`
 */
export function mirrorRailFloats() {
  return true;
}

/**
 * 拖拽锁比例时**不参与比例**的那一圈固定余量（`BrowserWindow.setAspectRatio` 的第二个参数）。
 *
 * 锁的是**画面那块矩形**（= 内容区减掉 `mirrorScreenInsets()`），因为比例说的是画面，不是窗口。
 *
 * ⚠️ 2026-10-16 起内缩恒为 0（画面 = 窗口）⇒ 返回值恒 `{ 0, 0 }`；原来还有一个 `extraWidth`
 * 参数专门把「dev 调试边栏占的那一截」加进来，**那一项随 `tools` 按钮一起删了（2026-10-17）**。
 * 函数与调用链（`createMirrorWindow` / `relockAspect` / `resize` 三处）保留：它仍是"画面之外
 * 还要占多少窗口"的唯一出处，将来要恢复内缩/边栏只改这一个函数。
 *
 * @returns {{ width: number, height: number }} 恒 `{ 0, 0 }`
 */
export function mirrorContentExtraSize() {
  const { left, right, top, bottom } = mirrorScreenInsets();
  return { width: left + right, height: top + bottom };
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
 * **独立虚拟屏**那档的开窗尺寸：就是 `MIRROR_VIRTUAL_WINDOW_WIDTH` × `MIRROR_VIRTUAL_WINDOW_HEIGHT`
 * 两个点名值（用户 2026-10-16：「宽度调成920px」→「高度调整到660」）。**不读任何屏幕分辨率**来定形状。
 *
 * ⚠️ 唯一的动态部分：**与设备信息同生共死**（`deviceScreenSize` 读不到 ⇒ 退回 850x600）。读不到
 * 分辨率/密度时渲染层压根不给虚拟显示尺寸（`new_display` 退空串、不开 flex），那块显示是**主屏尺寸的
 * 竖屏**，这时候开一个 920x660 的横窗只会把竖屏画面框得更死。
 *
 * 为什么必须在**建窗口**这一步就把形状定死：默认模式的虚拟显示尺寸取自**窗口画面区的物理像素**
 * （`src/mirror/direct-session.js` 的 `displayFor`）⇒ 窗口是什么形状，那块 flex 显示就是什么形状，
 * 里面的 app 从第一帧起就按那个形状排版；等第一帧再改等于让人先看一次错的。
 * @param {{ width?: number, height?: number } | null} deviceScreenSize 设备物理分辨率（只当「设备信息读到了吗」的闸）
 * @returns {{ width: number, height: number }}
 */
export function mirrorVirtualWindowSize(deviceScreenSize) {
  if (!(Number(deviceScreenSize?.width) > 0) || !(Number(deviceScreenSize?.height) > 0)) {
    return { ...MIRROR_WINDOW_FALLBACK_SIZE };
  }
  return { width: MIRROR_VIRTUAL_WINDOW_WIDTH, height: MIRROR_VIRTUAL_WINDOW_HEIGHT };
}

/**
 * 镜像窗口的初始尺寸：把**画面**照设备画面比例等比 fit 进「可用区减系统余量减内缩」。
 *
 * ⚠️ 2026-10-16 起内缩恒为 0（黑框去掉、长条改成浮在画面上的胶囊、标题栏退场）⇒
 * **窗口 = 画面**，这个函数实际就是"照设备比例 fit 可用区"。
 *
 * 为什么窗口要先照比例开好，而不是先开一块再等第一帧收一次：默认模式的虚拟显示尺寸取自
 * **窗口画面区的物理像素**，窗口是横的就开出一块横显示 —— 竖屏 app 立刻换版式，等第一帧再收
 * 回来等于让人看一次错误形状（那一版当天就被替掉了）。
 *
 * 读不到设备比例就退回 `850x600`（这一档是**窗口**尺寸），并且渲染层拿不到比例时**不给显示尺寸**
 * （`new_display` 退空串 = 上游默认的主屏尺寸与密度），两边都不自己编数字。
 * @param {{ width: number, height: number } | null} screenSize 设备物理分辨率（`wm size` 的 Physical）
 * @param {{ width: number, height: number } | null} workArea 该屏幕可用区
 * @returns {{ width: number, height: number }}
 */
export function mirrorWindowBounds(screenSize, workArea) {
  const width = Number(screenSize?.width);
  const height = Number(screenSize?.height);
  const insets = mirrorScreenInsets();
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
