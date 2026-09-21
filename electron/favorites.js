import { app, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CHANNELS } from "./ipcContract.js";
import { resolveDeviceStableId } from "./adb.js";
import { collapseAddressKeys } from "./deviceIdentity.js";

// ---------------------------------------------------------------------------
// 应用收藏（favorites）
//
// 结构：{ [稳定设备标识]: string[] }，写入 userData/favorites.json。
// 键**不是** adb 传输地址：无线重连一次地址就换一个，早先版本因此每次重连都
// 让用户以为收藏丢了（旧数据会在第一次读写时一次性并入稳定键，并先备份文件）。
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

/** 旧数据只合并一次（每个进程）。 */
let legacyCollapsed = false;

/**
 * 把历史遗留的「按传输地址存」的桶并进当前设备的稳定键。
 *
 * 宽松策略：所有地址形的键都并进来，不去猜它们属于哪台设备。收藏只是界面置顶，
 * 多并进来的包名在别的设备上也只会因为「本机没装」而不显示；反过来漏并就是用户
 * 数据凭空消失。重写前先把原文件备份成 `favorites.json.bak`，随时可回退。
 */
async function collapseLegacy(store, stableId) {
  if (legacyCollapsed) return store;
  legacyCollapsed = true;
  const { store: next, mergedCount } = collapseAddressKeys(store, stableId);
  if (!mergedCount) return store;
  try {
    await fs.copyFile(storePath(), `${storePath()}.bak`);
  } catch {
    // 原文件不存在或备份失败：继续合并，只是少一份回退副本
  }
  await writeStore(next);
  console.info(`[favorites] 已把 ${mergedCount} 条旧收藏并入设备稳定标识 ${stableId}`);
  return next;
}

/** 传输地址 → 稳定标识；解析不了（掉线等）就退回地址本身，至少不比旧行为差。 */
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
  if (typeof serial !== "string" || !serial || serial.length > MAX_SERIAL_LENGTH) return [];
  const stableId = await resolveStableId(serial);
  const store = await collapseLegacy(await readStore(), stableId);
  return store[stableId] || [];
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
  const stableId = await resolveStableId(serial);
  const store = await collapseLegacy(await readStore(), stableId);
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
