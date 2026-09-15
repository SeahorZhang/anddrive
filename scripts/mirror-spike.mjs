#!/usr/bin/env node
// M0 协议验证脚本（不启动 Electron）：
// 直接把随包的 scrcpy-server 拉起来并读取视频流，打印元数据与包统计。
// 可选把裸码流写成文件，用 `ffprobe -show_frames` 检查关键帧/分辨率。
//
// 用法：
//   node scripts/mirror-spike.mjs <serial> [h264|h265|av1] [raw-out.h264] [秒数]
//
// 例：
//   node scripts/mirror-spike.mjs adb-XXXX._adb-tls-connect._tcp h265 /tmp/mirror.h265 15

import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdbServerNodeJsClient } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptions4_0 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, ScrcpyVideoCodecNameMap } from "@yume-chan/scrcpy";
import { ReadableStream } from "@yume-chan/stream-extra";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adbBin = path.join(root, "resources/adb/mac/adb");
const serverPath = path.join(root, "resources/scrcpy/scrcpy-server");

const [, , serial, codec = "h265", rawOut, seconds = "15"] = process.argv;
if (!serial) {
  console.error("用法: node scripts/mirror-spike.mjs <serial> [h264|h265|av1] [raw-out] [秒数]");
  process.exit(1);
}

execFileSync(adbBin, ["start-server"]);

const serverClient = new AdbServerNodeJsClient();
const adb = await serverClient.createAdb({ serial });
console.log(`[spike] 已连接设备 ${serial}`);

console.log("[spike] 推送 scrcpy-server…");
const source = ReadableStream.from(createReadStream(serverPath));
await AdbScrcpyClient.pushServer(adb, source, DefaultServerPath);

const options = new AdbScrcpyOptions4_0({
  video: true,
  audio: false,
  control: true,
  sendStreamMeta: true,
  videoCodec: codec,
  videoBitRate: 24_000_000,
  maxFps: 60,
  newDisplay: "1920x1080/320",
  keepActive: true,
  // scrcpy server 用 Integer.parseInt(scid, 16) 解析，最高位必须为 0。
  scid: ((randomBytes(4).readUInt32BE(0) & 0x7fffffff) >>> 0).toString(16).padStart(8, "0"),
});

console.log(`[spike] 启动 scrcpy-server（${codec}）…`);
const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
const video = await client.videoStream;
if (!video) {
  console.error("[spike] 未拿到视频流");
  process.exit(1);
}

const name = ScrcpyVideoCodecNameMap.get(video.metadata.codec) ?? "unknown";
console.log(`[spike] codec=${name} (${video.metadata.codec}) device=${video.metadata.deviceName ?? "-"}`);

// 目标应用：有包名就通过控制消息启动
const packageName = process.env.MIRROR_PACKAGE;
if (packageName) {
  await client.controller?.startApp(packageName);
  console.log(`[spike] 已请求启动 ${packageName}`);
}

const out = rawOut ? createWriteStream(rawOut) : null;
if (out) console.log(`[spike] 裸码流写入 ${rawOut}`);

let packets = 0;
let bytes = 0;
let configs = 0;
const t0 = Date.now();
let lastLog = t0;

const timer = setTimeout(() => {
  console.log("[spike] 达到时长，停止");
  void client.close();
}, Number(seconds) * 1000);

try {
  const reader = video.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "configuration") {
      configs += 1;
      out?.write(value.data);
    } else if (value.type === "data") {
      packets += 1;
      bytes += value.data.length;
      out?.write(value.data);
    } else if (value.type === "session") {
      console.log(`[spike] session ${value.width}x${value.height} clientResize=${value.isClientResize}`);
    }
    if (Date.now() - lastLog > 1000) {
      console.log(`[spike] data=${packets} bytes=${bytes} configs=${configs}`);
      lastLog = Date.now();
    }
  }
} catch (error) {
  console.warn("[spike] 视频流异常：", error?.message || error);
} finally {
  clearTimeout(timer);
  await new Promise((resolve) => (out ? out.end(resolve) : resolve()));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[spike] 结束：${packets} 个 data 包 / ${bytes} 字节 / ${configs} 个 config 包，用时 ${elapsed}s`);
  await client.close().catch(() => {});
  await adb.close().catch(() => {});
  process.exit(0);
}
