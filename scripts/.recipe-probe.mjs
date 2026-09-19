#!/usr/bin/env node
// 临时探针（跑完即删）：验证「pad 画面能不能在物理屏恢复原状后仍然留在虚拟显示上」。
// 步骤：物理屏改大屏 + compat 开 → app 在物理屏起 pad → 搬到宽虚拟显示 →
//       物理屏 wm size/density reset → 再模拟 flex 跟随 resizeDisplay → 每步量窗口。
// 用法：node scripts/.recipe-probe.mjs <serial>

import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdbServerNodeJsClient } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptions4_0 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath } from "@yume-chan/scrcpy";
import { ReadableStream } from "@yume-chan/stream-extra";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adbBin = path.join(root, "resources/adb/mac/adb");
const serverPath = path.join(root, "resources/scrcpy/scrcpy-server");
const [, , serial] = process.argv;
const pkg = "com.ss.android.ugc.aweme";
const CHANGE = "OVERRIDE_ANY_ORIENTATION_TO_USER";

const sh = (cmd) => {
  try {
    return execFileSync(adbBin, ["-s", serial, "shell", cmd], { encoding: "utf8" }).trim();
  } catch (error) {
    return `ERR ${error.message}`;
  }
};
const show = (label) =>
  console.log(
    `  → ${label}: ` +
      sh(
        `dumpsys window windows | grep -E 'Window #.*${pkg}' -A28 | grep -oE 'mDisplayId=[0-9]+|mBounds=Rect\\([^)]*\\)|mMaxBounds=Rect\\([^)]*\\)|sw[0-9]+dp w[0-9]+dp h[0-9]+dp [0-9]+dpi' | head -4 | tr '\\n' ' '`,
      ),
  );

const cleanup = () => {
  sh(`am compat reset ${CHANGE} ${pkg} >/dev/null 2>&1`);
  sh("wm size reset >/dev/null 2>&1; wm density reset >/dev/null 2>&1");
  console.log("[cleanup] compat + wm 已还原");
};
process.on("exit", cleanup);

console.log("[1] 物理屏改大屏 + compat 开 + 冷启动到物理屏");
sh(`am force-stop ${pkg}`);
sh("wm size 1920x1080; wm density 160");
sh(`am compat enable ${CHANGE} ${pkg}`);
sh(`am start -n ${pkg}/.splash.SplashActivity >/dev/null`);
await new Promise((r) => setTimeout(r, 10000));
show("物理屏上的窗口");

console.log("[2] 建宽虚拟显示 1920x1080/240 并 startApp 搬过去");
const adb = await new AdbServerNodeJsClient().createAdb({ serial });
await AdbScrcpyClient.pushServer(adb, ReadableStream.from(createReadStream(serverPath)), DefaultServerPath);
const client = await AdbScrcpyClient.start(
  adb,
  DefaultServerPath,
  new AdbScrcpyOptions4_0({
    video: true,
    audio: false,
    control: true,
    sendStreamMeta: false,
    videoCodec: "h265",
    maxFps: 60,
    newDisplay: "1920x1080/240",
    flexDisplay: true,
    keepActive: true,
    scid: ((randomBytes(4).readUInt32BE(0) & 0x7fffffff) >>> 0).toString(16).padStart(8, "0"),
  }),
);
await client.videoStream;
await client.controller?.startApp(pkg);
await new Promise((r) => setTimeout(r, 9000));
show("虚拟显示上的窗口");

console.log("[3] 物理屏还原（wm size/density reset）—— 看 pad 掉不掉");
sh("wm size reset; wm density reset");
await new Promise((r) => setTimeout(r, 6000));
show("还原后的窗口");

console.log("[4] 模拟 flex 跟随：resizeDisplay 1600x900");
await client.controller?.resizeDisplay({ width: 1600, height: 900 });
await new Promise((r) => setTimeout(r, 6000));
show("resize 后的窗口");

console.log("[5] compat 关掉（模拟会话结束）—— 看 pad 掉不掉");
sh(`am compat reset ${CHANGE} ${pkg}`);
await new Promise((r) => setTimeout(r, 6000));
show("关开关后的窗口");

await client.close?.().catch(() => {});
process.exit(0);
