import { app, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CHANNELS } from "./ipcContract.js";
import { resolveDeviceStableId } from "./adb.js";
import { isValidPackageName, isValidSerial } from "./validators.js";

// ---------------------------------------------------------------------------
// 应用收藏（favorites）
//
// 结构：{ [稳定设备标识]: string[] }，写入 userData/favorites.json。
// 键**不是** adb 传输地址：无线重连一次地址就换一个，拿地址当键会让收藏"凭空丢失"。
// 收藏只影响界面分组与置顶，不改变设备上的任何状态。
// ---------------------------------------------------------------------------

const MAX_FAVORITES_PER_DEVICE = 500;

const storePath = () => path.join(app.getPath("userData"), "favorites.json");

/** @param {unknown} value @returns {string | null} */
export function sanitizePackage(value) {
  if (!isValidPackageName(value)) return null;
  return value.trim();
}

/** @param {unknown} value @returns {string[]} */
export function sanitizeFavoriteList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const favorites = [];
  for (const item of value) {
    const pkg = sanitizePackage(item);
    if (!pkg || seen.has(pkg)) continue;
    seen.add(pkg);
    favorites.push(pkg);
    if (favorites.length >= MAX_FAVORITES_PER_DEVICE) break;
  }
  return favorites;
}

/** @param {unknown} value @returns {Record<string, string[]>} */
export function sanitizeStore(value) {
  if (!value || typeof value !== "object") return {};
  const store = {};
  for (const [serial, list] of Object.entries(value)) {
    if (!isValidSerial(serial)) continue;
    const favorites = sanitizeFavoriteList(list);
    if (favorites.length) store[serial] = favorites;
  }
  return store;
}

async function readStore() {
  try {
    const data = await fs.readFile(storePath());
    return sanitizeStore(JSON.parse(data.toString("utf8")));
  } catch {
    return {};
  }
}

/** 传输地址 → 稳定标识；解析不了（掉线等）就退回地址本身。 */
async function resolveStableId(serial) {
  try {
    return (await resolveDeviceStableId(serial)) || serial;
  } catch {
    return serial;
  }
}

/** @param {Record<string, string[]>} store */
async function writeStore(store) {
  const file = storePath();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
    return true;
  } catch (error) {
    console.warn("Failed to write favorites:", error);
    return false;
  }
}

/** @param {string} serial @returns {Promise<string[]>} */
export async function getFavorites(serial) {
  if (!isValidSerial(serial)) return [];
  const stableId = await resolveStableId(serial);
  const store = await readStore();
  return store[stableId] || [];
}

/**
 * 切换某台设备上某个应用的收藏状态，返回更新后的收藏列表。
 * @param {string} serial @param {string} packageName
 * @returns {Promise<string[] | null>}
 */
export async function toggleFavorite(serial, packageName) {
  const pkg = sanitizePackage(packageName);
  if (!isValidSerial(serial) || !pkg) {
    return null;
  }
  const stableId = await resolveStableId(serial);
  const store = await readStore();
  const current = new Set(store[stableId] || []);
  if (current.has(pkg)) current.delete(pkg);
  else current.add(pkg);
  store[stableId] = [...current].slice(0, MAX_FAVORITES_PER_DEVICE);
  if (!(await writeStore(store))) {
    // 写盘失败必须报错：渲染层是乐观更新（`useFavorites.toggleFavorite`），
    // 只有 reject 才会把星标回滚并提示用户。返回新列表等于「假装存下来了」。
    throw new Error("收藏没能保存：写入本地文件失败");
  }
  return store[stableId];
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.favoritesGet, (_, serial) => getFavorites(serial));
ipcMain.handle(CHANNELS.favoritesToggle, (_, serial, packageName) =>
  toggleFavorite(serial, packageName),
);
