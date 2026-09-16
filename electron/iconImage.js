import { app } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathExists } from "./fsUtil.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 应用图标（iconUrl）
//
// 应用图标在各处都是 `data:image/png;base64,…` 形式。这里集中处理：
// - 校验/解码；
// - macOS 风格合成（Android 图标是铺满画布的方形，直接当 macOS 图标会填满整个
//   Dock 磁贴、看起来比系统图标大一圈，这里补上系统规范的留白与圆角）；
// 合成结果按原图内容哈希缓存，只算一次。
// ---------------------------------------------------------------------------

const OSASCRIPT = "/usr/bin/osascript";
const SIPS = "/usr/bin/sips";
const CACHE_DIR = "icon-cache";
const MAX_ICON_BYTES = 512 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const COMPOSE_SCRIPT = `use framework "AppKit"
use scripting additions
on run argv
	set src to item 1 of argv
	set dst to item 2 of argv
	set canvasSize to 1024
	set margin to 100
	set contentSize to canvasSize - margin * 2
	set radius to 185
	set srcImg to current application's NSImage's alloc()'s initWithContentsOfFile:src
	set canvas to current application's NSImage's alloc()'s initWithSize:(current application's NSMakeSize(canvasSize, canvasSize))
	canvas's lockFocus()
	set rect to current application's NSMakeRect(margin, margin, contentSize, contentSize)
	set clipPath to current application's NSBezierPath's alloc()'s init()
	clipPath's appendBezierPathWithRoundedRect:rect xRadius:radius yRadius:radius
	clipPath's addClip()
	srcImg's drawInRect:rect fromRect:(current application's NSMakeRect(0, 0, 0, 0)) operation:(current application's NSCompositingOperationSourceOver) fraction:1.0
	canvas's unlockFocus()
	set tiffData to canvas's TIFFRepresentation()
	tiffData's writeToFile:dst atomically:true
	return "ok"
end run`;

const cacheRoot = () => path.join(app.getPath("userData"), CACHE_DIR);
const composedDir = () => path.join(cacheRoot(), "composed");

/** 校验图标 data URL；非法返回 null。 */
export function sanitizeIcon(iconUrl) {
  if (iconUrl == null) return null;
  if (typeof iconUrl !== "string" || !iconUrl.startsWith(PNG_DATA_URL_PREFIX)) return null;
  const encoded = iconUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  if (Buffer.byteLength(encoded, "base64") > MAX_ICON_BYTES) return null;
  return iconUrl;
}

/** 图标 data URL → PNG Buffer；非法返回 null。 */
export function iconPngBuffer(iconUrl) {
  const icon = sanitizeIcon(iconUrl);
  if (!icon) return null;
  return Buffer.from(icon.slice(PNG_DATA_URL_PREFIX.length), "base64");
}

const iconHash = (iconPng) => createHash("sha256").update(iconPng).digest("hex").slice(0, 16);

async function renderMacosIcon(iconPng, hash) {
  const dir = composedDir();
  await fs.mkdir(dir, { recursive: true });
  const token = randomBytes(8).toString("hex");
  const srcPath = path.join(dir, `${token}.src.png`);
  const tiffPath = path.join(dir, `${token}.tiff`);
  const tmpPath = path.join(dir, `${token}.png`);
  try {
    await fs.writeFile(srcPath, iconPng);
    await execFileAsync(OSASCRIPT, ["-e", COMPOSE_SCRIPT, srcPath, tiffPath]);
    await execFileAsync(SIPS, ["-s", "format", "png", "-z", "1024", "1024", tiffPath, "--out", tmpPath]);
    const buffer = await fs.readFile(tmpPath);
    // 原子落盘；并发命中同一图标时覆盖同内容，无碍。
    await fs.rename(tmpPath, path.join(dir, `${hash}.png`));
    return buffer;
  } finally {
    await Promise.all(
      [srcPath, tiffPath, tmpPath].map((file) => fs.rm(file, { force: true }).catch(() => {})),
    );
  }
}

/**
 * 把应用图标合成成 macOS 风格（留白 + 圆角）。非 macOS 或合成失败时原样返回。
 * @param {Buffer | null} iconPng
 * @returns {Promise<Buffer | null>}
 */
export async function composeMacosIconPng(iconPng) {
  if (!iconPng || process.platform !== "darwin") return iconPng;

  const cachePath = path.join(composedDir(), `${iconHash(iconPng)}.png`);
  try {
    return await fs.readFile(cachePath);
  } catch {
    // 未缓存，下面合成
  }
  try {
    return await renderMacosIcon(iconPng, iconHash(iconPng));
  } catch (error) {
    console.warn("AndDrive: 合成 macOS 图标失败：", error?.message || error);
    return iconPng;
  }
}
