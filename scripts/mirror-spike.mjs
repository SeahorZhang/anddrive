#!/usr/bin/env node
// M0 协议验证脚本（不启动 Electron）：
// 直接把随包的 scrcpy-server 拉起来并读取视频流，打印元数据与包统计。
// 可选把裸码流写成文件，用 `ffprobe -show_frames` 检查关键帧/分辨率。
//
// 用法：
//   node scripts/mirror-spike.mjs <serial> [h264|h265|av1|vp8|vp9] [raw-out.h264] [秒数]
//
// 例：
//   node scripts/mirror-spike.mjs adb-XXXX._adb-tls-connect._tcp h265 /tmp/mirror.h265 15

import { execFileSync, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdbServerNodeJsClient } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptions4_1 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, ScrcpyVideoCodecNameMap } from "@yume-chan/scrcpy";
import { ReadableStream } from "@yume-chan/stream-extra";
import { scrcpyServerResource, SCRCPY_SERVER_VERSION } from "../shared/scrcpyConfig.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adbBin = path.join(root, "resources/adb/mac/adb");
// 默认跑上游原生那份产物；`SPIKE_SERVER=patched` 换带 `debug.anddrive.vd.*` 的那份，同一套参数 A/B。
const serverPath = path.join(
  root,
  "resources",
  scrcpyServerResource({ largeScreenDisplay: process.env.SPIKE_SERVER === "patched" }),
);

const [, , serial, codec = "h265", rawOut, seconds = "15"] = process.argv;
if (!serial) {
  console.error("用法: node scripts/mirror-spike.mjs <serial> [h264|h265|av1] [raw-out] [秒数]");
  process.exit(1);
}

// 帧率取证用的可选参数（默认保持原 M0 行为）。
//   SPIKE_DISPLAY=<w>x<h>/<dpi>  虚拟显示几何（默认 1920x1080/320）
//   SPIKE_FPS=<n>                maxFps（默认 60）
//   SPIKE_BITRATE=<M>            码率上限，单位 Mbps（默认 24）
//   SPIKE_MOTION=1               在镜像那块显示上匀速来回滑动，提供受控运动源
// 应用默认路径发的是**空串**（上游语义：主屏尺寸 + 主屏密度）。空串会被下面的 `||` 吞成默认值，
// 所以给它一个显式入口：`SPIKE_NO_DISPLAY=1` 才是和线上默认路径一致的那一条。
const envDisplay = process.env.SPIKE_NO_DISPLAY ? "" : process.env.SPIKE_DISPLAY || "1920x1080/320";
const envFps = Number(process.env.SPIKE_FPS || 60);
const envBitRateM = Number(process.env.SPIKE_BITRATE || 24);
const driveMotion = process.env.SPIKE_MOTION === "1";

execFileSync(adbBin, ["start-server"]);

const serverClient = new AdbServerNodeJsClient();
const adb = await serverClient.createAdb({ serial });
console.log(`[spike] 已连接设备 ${serial}`);

console.log("[spike] 推送 scrcpy-server…");
const source = ReadableStream.from(createReadStream(serverPath));
await AdbScrcpyClient.pushServer(adb, source, DefaultServerPath);

const options = new AdbScrcpyOptions4_1(
  {
    video: true,
    audio: false,
    control: true,
    sendStreamMeta: true,
    videoCodec: codec,
    videoBitRate: Math.round(envBitRateM * 1_000_000),
    maxFps: envFps,
    newDisplay: envDisplay,
    keepActive: true,
    // scrcpy server 用 Integer.parseInt(scid, 16) 解析，最高位必须为 0。
    scid: ((randomBytes(4).readUInt32BE(0) & 0x7fffffff) >>> 0).toString(16).padStart(8, "0"),
  },
  // 随包 server 会比对客户端声明的版本，不等直接退出（见 `shared/scrcpyConfig.js`）。
  { version: SCRCPY_SERVER_VERSION },
);

console.log(`[spike] 启动 scrcpy-server（${codec} ${envDisplay} fps=${envFps} ${envBitRateM}M）…`);
const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
const video = await client.videoStream;
if (!video) {
  console.error("[spike] 未拿到视频流");
  process.exit(1);
}

const name = ScrcpyVideoCodecNameMap.get(video.metadata.codec) ?? "unknown";
console.log(`[spike] codec=${name} (${video.metadata.codec}) device=${video.metadata.deviceName ?? "-"}`);

// 本会话虚拟显示的 id：server stdout 的 `New display: WxH/D (id=N)` 才有。
// 运动源必须打到这块显示上（`input` 不带 -d 会打到手机主屏，镜像画面根本不动）。
let displayId = null;
try {
  const outputReader = client.output.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await outputReader.read();
      if (done) break;
      const matched = /\(id=(\d+)\)/.exec(String(value));
      if (matched) displayId = Number(matched[1]);
    }
  })();
} catch {
  console.warn("[spike] output 不可用，无法解析显示 id");
}
for (let i = 0; i < 40 && displayId === null; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.log(`[spike] 虚拟显示 id=${displayId ?? "未知"}`);

/**
 * 受控运动源：匀速来回滑动。坐标按显示尺寸取百分比，这样不同分辨率下视觉速度一致，
 * fps 才可比（`docs/NATIVE_MIRROR.md` §4.0）。
 */
let motion = null;
if (driveMotion) {
  if (displayId === null) {
    console.warn("[spike] 拿不到显示 id，跳过运动源（测出来的帧数只反映内容动静）");
  } else {
    const [geom] = envDisplay.split("/");
    const [dw, dh] = geom.split("x").map(Number);
    if (!(dw > 0) || !(dh > 0)) {
      // 不传尺寸（`SPIKE_NO_DISPLAY=1`）时显示是主屏尺寸，这里的坐标得从设备实际尺寸取，
      // spike 不去猜：宁可跳过运动源，也不要往一块未知的显示上滑。
      console.warn("[spike] 本次没传显示尺寸，跳过运动源（帧数只反映内容动静）");
    } else {
      const cx = Math.round(dw * 0.5);
      const y0 = Math.round(dh * 0.72);
      const y1 = Math.round(dh * 0.28);
      const loop = `while true; do input -d ${displayId} swipe ${cx} ${y0} ${cx} ${y1} 300; input -d ${displayId} swipe ${cx} ${y1} ${cx} ${y0} 300; done`;
      motion = spawn(adbBin, ["-s", serial, "shell", loop], { stdio: "ignore" });
      console.log("[spike] 运动源已启动（300ms 单程来回滑）");
      // 让列表先动起来，再开始统计（头几秒还在惯性滚动）。
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

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

// pts 间隔是「设备到底出多少帧」的直接读数：它不受传输抖动影响，
// 和入站包数分开看才能区分「设备只编这么多」和「链路把帧挤成一串」。
let lastPts = null;
let ptsSum = 0;
let ptsCount = 0;
let ptsMax = 0;
let lastArrive = null;
let gapMax = 0;
let gapOver50 = 0;

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
      const now = Date.now();
      if (lastArrive !== null) {
        const gap = now - lastArrive;
        if (gap > gapMax) gapMax = gap;
        if (gap > 50) gapOver50 += 1;
      }
      lastArrive = now;
      if (value.pts != null && lastPts != null) {
        // scrcpy 的 pts 单位是微秒。
        const d = Number(value.pts - lastPts) / 1000;
        if (d > 0) {
          ptsSum += d;
          ptsCount += 1;
          if (d > ptsMax) ptsMax = d;
        }
      }
      if (value.pts != null) lastPts = value.pts;
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
  motion?.kill();
  await new Promise((resolve) => (out ? out.end(resolve) : resolve()));
  const elapsed = (Date.now() - t0) / 1000;
  console.log(
    `[spike] 结束：${packets} 个 data 包 / ${bytes} 字节 / ${configs} 个 config 包，` +
      `用时 ${elapsed.toFixed(1)}s → ${((packets / elapsed) * 1).toFixed(1)} 包/秒，` +
      `码率 ${((bytes * 8) / elapsed / 1_000_000).toFixed(1)}Mbps`,
  );
  console.log(
    `[spike] pts 间隔 均值=${ptsCount ? (ptsSum / ptsCount).toFixed(1) : "-"}ms ` +
      `最大=${ptsMax.toFixed(1)}ms（≈${ptsCount ? (1000 / (ptsSum / ptsCount)).toFixed(1) : "-"}fps 设备出帧）；` +
      `入站间隙 最大=${gapMax}ms、>50ms 的有 ${gapOver50} 次（≈链路突发）`,
  );
  await client.close().catch(() => {});
  await adb.close().catch(() => {});
  process.exit(0);
}
