import { app, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CHANNELS } from "./ipcContract.js";

// ---------------------------------------------------------------------------
// 应用收藏（favorites）
//
// 结构：{ [serial]: string[] }，按设备 serial 隔离，写入 userData/favorites.json。
// 收藏只影响界面分组与置顶，不改变设备上的任何状态。
// ---------------------------------------------------------------------------

const MAX_SERIAL_LENGTH = 1024;
const MAX_PACKAGE_LENGTH = 512;
const MAX_FAVORITES_PER_DEVICE = 500;

const storePath = () => path.join(app.getPath("userData"), "favorites.json");

/** @param {unknown} value @returns {string | null} */
export function sanitizePackage(value) {
  if (typeof value !== "string") return null;
  const pkg = value.trim();
  if (!pkg || pkg.length > MAX_PACKAGE_LENGTH) return null;
  return pkg;
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
    if (typeof serial !== "string" || !serial || serial.length > MAX_SERIAL_LENGTH) continue;
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
  if (typeof serial !== "string" || !serial || serial.length > MAX_SERIAL_LENGTH) return [];
  return (await readStore())[serial] || [];
}

/**
 * 切换某台设备上某个应用的收藏状态，返回更新后的收藏列表。
 * @param {string} serial @param {string} packageName
 * @returns {Promise<string[] | null>}
 */
export async function toggleFavorite(serial, packageName) {
  const pkg = sanitizePackage(packageName);
  if (typeof serial !== "string" || !serial || serial.length > MAX_SERIAL_LENGTH || !pkg) {
    return null;
  }
  const store = await readStore();
  const current = new Set(store[serial] || []);
  if (current.has(pkg)) current.delete(pkg);
  else current.add(pkg);
  store[serial] = [...current].slice(0, MAX_FAVORITES_PER_DEVICE);
  await writeStore(store);
  return store[serial];
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(CHANNELS.favoritesGet, (_, serial) => getFavorites(serial));
ipcMain.handle(CHANNELS.favoritesToggle, (_, serial, packageName) =>
  toggleFavorite(serial, packageName),
);
