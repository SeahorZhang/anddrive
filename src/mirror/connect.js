// ---------------------------------------------------------------------------
// 渲染层直连（nodeIntegration）：adb 与 scrcpy 会话建立完全用 Tango 官方库
// （@yume-chan/adb-server-node-tcp + @yume-chan/adb-scrcpy），只是把代码
// 跑在渲染层。视频/音频/控制流不跨进程。
//
// 关键约束：所有 @yume-chan 原生包必须通过 preload 注入的 window.require
// 获取（唯一的模块副本），Vite bundle 内静态 import 会造成两份模块实例，
// stream 内部的 PushReadableStream/MaybeConsumable 等类标识不一致时会挂死。
// ---------------------------------------------------------------------------

/** window.require（preload 注入，解析到项目 node_modules）。 */
function req(name) {
  const mod = window.require?.(name);
  if (!mod) throw new Error(`无法加载 ${name}（缺少 node 集成）`);
  return mod?.default ?? mod;
}

/** Tango 官方 adb server 客户端（与主进程一致）。 */
let serverClient = null;
export function getServerClient() {
  const { AdbServerNodeJsClient } = req("@yume-chan/adb-server-node-tcp");
  serverClient ??= new AdbServerNodeJsClient();
  return serverClient;
}

export async function acquireDeviceAdb(serverClient, serial) {
  if (typeof serial !== "string" || !serial.trim()) throw new Error("设备序列号无效");
  return serverClient.createAdb({ serial: serial.trim() });
}

/** node:crypto → 8 位十六进制 scid（最高位须为 0，官方客户端同款实现）。 */
export function createScid() {
  const { randomBytes } = req("node:crypto");
  return (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, "0");
}

/**
 * 推送并启动 scrcpy（官方 AdbScrcpyClient / AdbScrcpyOptions4_0 直用）。
 * 返回启动时**实际用于创建虚拟显示**的尺寸：调用方据此初始化「跟随窗口」的
 * 请求合并器，避免启动阶段再下发一条完全相同的 resizeDisplay。
 * @param {{ adb: unknown, serverPath: string, config: unknown }} params
 * @returns {Promise<{ client: unknown, display: { width: number, height: number, dpi: number } }>}
 */
export async function startScrcpy({ adb, serverPath, config }) {
  const { AdbScrcpyClient, AdbScrcpyOptions4_0 } = req("@yume-chan/adb-scrcpy");
  const { DefaultServerPath } = req("@yume-chan/scrcpy");
  const { ReadableStream } = req("@yume-chan/stream-extra");
  const { createReadStream } = req("node:fs");
  const { buildMirrorOptions, resolveNativeCodec } = await import(
    "../../electron/mirror/options.js"
  );
  const { computeDisplayMetrics } = await import("../../shared/scrcpyConfig.js");

  const { codec, downgraded } = resolveNativeCodec(config);
  if (downgraded) {
    console.warn(`[mirror] 自研引擎暂不支持所选编码，改用 ${codec}`);
  }
  // 初始虚拟显示 = 窗口 CSS × DISPLAY_PIXEL_SCALE（像素倍率与 dpi 一起定，1dp = DISPLAY_ZOOM CSS px）；
  // 之后由 resizeDisplay 跟随窗口。
  const display = computeDisplayMetrics(
    document.documentElement.clientWidth,
    document.documentElement.clientHeight,
  );
  const newDisplay = `${display.width}x${display.height}/${display.dpi}`;
  const file = ReadableStream.from(createReadStream(serverPath));
  await AdbScrcpyClient.pushServer(adb, file, DefaultServerPath);
  const options = new AdbScrcpyOptions4_0({
    ...buildMirrorOptions(config, { videoCodec: codec, newDisplay }),
    scid: createScid(),
  });
  const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
  return { client, display };
}

export function codecName(codec) {
  const { ScrcpyVideoCodecNameMap } = req("@yume-chan/scrcpy");
  return ScrcpyVideoCodecNameMap.get(codec) ?? "unknown";
}
