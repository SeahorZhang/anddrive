import { app } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const CACHE_VERSION = 2;
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const ICON_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_APPS = 5000;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_DEVICE_CACHES = 20;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const cacheRoot = () => path.join(app.getPath("userData"), "app-cache", "apps-v1");
const cacheKey = (serial) => createHash("sha256").update(serial).digest("hex");
const cachePath = (serial) => path.join(cacheRoot(), `${cacheKey(serial)}.json`);
const validTimestamp = (value) => Number.isFinite(value) && value >= 0;

function sanitizeIcon(iconUrl) {
  if (iconUrl == null) return null;
  if (typeof iconUrl !== "string" || !iconUrl.startsWith(PNG_DATA_URL_PREFIX)) return null;
  const encoded = iconUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  if (Buffer.byteLength(encoded, "base64") > MAX_ICON_BYTES) return null;
  return iconUrl;
}

function sanitizeApp(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.packageName !== "string" || !value.packageName || value.packageName.length > 512) return null;
  const label = typeof value.label === "string" && value.label ? value.label.slice(0, 1024) : value.packageName;
  const iconUrl = sanitizeIcon(value.iconUrl);
  const iconUpdatedAt = iconUrl && validTimestamp(value.iconUpdatedAt) ? value.iconUpdatedAt : null;
  return { packageName: value.packageName, label, iconUrl, iconUpdatedAt };
}

function sanitizeSnapshot(value, { allowExpired = false } = {}) {
  if (!value || value.version !== CACHE_VERSION || !Array.isArray(value.apps)) return null;
  if (!validTimestamp(value.authoritativeAt) || !validTimestamp(value.writtenAt)) return null;
  if (!allowExpired && Date.now() - value.writtenAt > CACHE_MAX_AGE_MS) return null;
  if (value.apps.length > MAX_APPS) return null;

  const seen = new Set();
  const apps = [];
  for (const valueApp of value.apps) {
    const cachedApp = sanitizeApp(valueApp);
    if (!cachedApp || seen.has(cachedApp.packageName)) return null;
    seen.add(cachedApp.packageName);
    apps.push(cachedApp);
  }
  return {
    version: CACHE_VERSION,
    authoritativeAt: value.authoritativeAt,
    writtenAt: value.writtenAt,
    apps,
  };
}

async function removeFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Failed to remove app cache:", error);
  }
}

export async function readAppCache(serial) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) return null;
  const filePath = cachePath(serial);
  try {
    const data = await fs.readFile(filePath);
    if (data.length > MAX_SNAPSHOT_BYTES) {
      await removeFile(filePath);
      return null;
    }
    const snapshot = sanitizeSnapshot(JSON.parse(data.toString("utf8")));
    if (!snapshot) await removeFile(filePath);
    return snapshot;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("Failed to read app cache:", error);
      await removeFile(filePath);
    }
    return null;
  }
}

export async function getCachedInstalledApps(serial) {
  const snapshot = await readAppCache(serial);
  if (!snapshot) return null;
  return {
    authoritativeAt: snapshot.authoritativeAt,
    apps: snapshot.apps.map(({ packageName, label, iconUrl }) => ({ packageName, label, iconUrl })),
  };
}

function serializeSnapshot(snapshot) {
  const sanitized = sanitizeSnapshot(snapshot, { allowExpired: true });
  if (!sanitized) return null;

  let data = JSON.stringify(sanitized);
  if (Buffer.byteLength(data) <= MAX_SNAPSHOT_BYTES) return data;
  for (const cachedApp of sanitized.apps) {
    cachedApp.iconUrl = null;
    cachedApp.iconUpdatedAt = null;
  }
  data = JSON.stringify(sanitized);
  return Buffer.byteLength(data) <= MAX_SNAPSHOT_BYTES ? data : null;
}

async function pruneCaches(protectedPath) {
  try {
    const root = cacheRoot();
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const filePath = path.join(root, entry.name);
      if (!entry.isFile()) continue;
      if (entry.name.includes(".tmp")) {
        await removeFile(filePath);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const stats = await fs.stat(filePath);
      if (Date.now() - stats.mtimeMs > CACHE_MAX_AGE_MS && filePath !== protectedPath) {
        await removeFile(filePath);
      } else {
        files.push({ filePath, mtimeMs: stats.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files.slice(MAX_DEVICE_CACHES)) {
      if (file.filePath !== protectedPath) await removeFile(file.filePath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Failed to prune app caches:", error);
  }
}

export async function writeAppCache(serial, snapshot) {
  if (typeof serial !== "string" || !serial || serial.length > 1024) return false;
  const data = serializeSnapshot(snapshot);
  if (data == null) {
    await removeFile(cachePath(serial));
    return false;
  }

  const root = cacheRoot();
  const filePath = cachePath(serial);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(tempPath, data, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
    await pruneCaches(filePath);
    return true;
  } catch (error) {
    console.warn("Failed to write app cache:", error);
    await removeFile(tempPath);
    return false;
  }
}

export { ICON_REFRESH_MS };
