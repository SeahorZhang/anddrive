import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { AdbServerNodeJsClient } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptions4_0 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, ScrcpyVideoCodecNameMap } from "@yume-chan/scrcpy";
import { ReadableStream } from "@yume-chan/stream-extra";
import { ensureServer, scrcpyServerPath } from "../adb.js";
import { buildMirrorOptions, resolveNativeCodec } from "./options.js";

// ---------------------------------------------------------------------------
// 自研客户端协议层（Tango / @yume-chan）
//
// scrcpy-client 那层被替换成 Tango：它负责 push scrcpy-server、启动
// app_process、建立 video/control socket，并把视频流解析成
// `ScrcpyVideoStreamPacket`。主进程只做搬运，解码/渲染在渲染进程完成。
// Tango 目前对 scrcpy 4.0 的支持在 beta 分支，版本已在 package.json 锁定。
// ---------------------------------------------------------------------------

/** Tango 直连内置 adb daemon（默认 127.0.0.1:5037）。 */
let serverClient = null;

function getServerClient() {
  if (!serverClient) serverClient = new AdbServerNodeJsClient();
  return serverClient;
}

/**
 * 8 位十六进制会话 id，避免多会话共用同名 socket。
 * scrcpy server 用 `Integer.parseInt(scid, 16)` 解析，最高位必须为 0，
 * 否则 8 位十六进制会溢出成负数并抛 NumberFormatException。
 */
export function createScid() {
  return (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, "0");
}

/**
 * 按 serial 复用 adb transport：同一设备的多条镜像会话共用一条连接，
 * 引用计数归零时才关闭。会话各自的 video/control socket 仍由 Tango 独立建立。
 * @type {Map<string, { adb: import("@yume-chan/adb").Adb, refs: number }>}
 */
const adbTransports = new Map();

/**
 * 获取设备的 adb transport（按 serial 复用）。
 * @param {string} serial
 * @returns {Promise<import("@yume-chan/adb").Adb>}
 */
export async function acquireDeviceAdb(serial) {
  if (typeof serial !== "string" || !serial.trim()) throw new Error("设备序列号无效");
  const key = serial.trim();
  const existing = adbTransports.get(key);
  if (existing) {
    existing.refs += 1;
    return existing.adb;
  }
  await ensureServer();
  const adb = await getServerClient().createAdb({ serial: key });
  adbTransports.set(key, { adb, refs: 1 });
  return adb;
}

/** 释放设备的 adb transport；引用计数归零时关闭。 */
export function releaseDeviceAdb(serial) {
  const key = typeof serial === "string" ? serial.trim() : "";
  const entry = adbTransports.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  adbTransports.delete(key);
  void entry.adb.close().catch(() => {});
}

/** codec 数值 id → `H264` / `H265` / `Av1`，未知返回 `unknown`。 */
export function codecName(codecId) {
  return ScrcpyVideoCodecNameMap.get(codecId) ?? "unknown";
}

/**
 * 把随包的 scrcpy-server 推到设备临时目录。server 版本和客户端必须一致，
 * 这里不做缓存判断，先保证正确性。
 * @param {import("@yume-chan/adb").Adb} adb
 */
export async function pushScrcpyServer(adb) {
  const file = ReadableStream.from(createReadStream(scrcpyServerPath()));
  await AdbScrcpyClient.pushServer(adb, file, DefaultServerPath);
  return DefaultServerPath;
}

/**
 * 启动一次 scrcpy 会话（只建立连接，不建窗口）。
 * @param {{ adb: import("@yume-chan/adb").Adb, config?: unknown }} params
 * @returns {Promise<InstanceType<typeof AdbScrcpyClient>>}
 */
export async function startScrcpyClient({ adb, config }) {
  const { codec, downgraded } = resolveNativeCodec(config);
  if (downgraded) {
    console.warn(`[mirror] 自研引擎暂不支持所选编码，改用 ${codec}`);
  }
  const options = new AdbScrcpyOptions4_0({
    ...buildMirrorOptions(config, { videoCodec: codec }),
    scid: createScid(),
  });
  return AdbScrcpyClient.start(adb, DefaultServerPath, options);
}
