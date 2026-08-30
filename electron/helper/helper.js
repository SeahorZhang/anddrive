import { execFile } from "node:child_process";
import { adbExec, adbExecSafe, ensureServer } from "../adb/adbClient.js";
import { readAppCache, writeAppCache } from "../cache/appCache.js";
import { adbPath, helperApkPath } from "../paths.js";

export const HELPER_PACKAGE = "com.anddrive.helper";

/**
 * Message prefix marking failures where the helper cannot be installed or run
 * on the device; the renderer turns these into an actionable install prompt.
 */
export const HELPER_SETUP_ERROR_PREFIX = "HELPER_SETUP:";

const HELPER_ENTRY_CLASS = "com.anddrive.helper.ListMain";
const LIST_TIMEOUT_MS = 120000;
const LIST_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Device-side package state
// ---------------------------------------------------------------------------

/**
 * A package may linger in `pm list` as a ghost after user-0 removal while its
 * APK is gone, so trust `pm path` (real APK location) instead.
 */
export async function isHelperInstalled(serial) {
  return (await deviceApkPath(serial)) != null;
}

/** @returns {Promise<string | null>} on-device base.apk path of the helper */
export async function deviceApkPath(serial) {
  try {
    const output = await adbExec("-s", serial, "shell", "pm", "path", HELPER_PACKAGE);
    const line = output.split("\n").find((l) => l.startsWith("package:"));
    return line ? line.slice("package:".length).trim() || null : null;
  } catch {
    return null;
  }
}

export async function installHelper(serial) {
  const apkPath = helperApkPath();
  return adbExec("-s", serial, "install", "-r", apkPath);
}

/**
 * Remove the helper from the device with a plain `adb uninstall`.
 * Some ROMs print a spurious `Failure [...]` here while actually succeeding,
 * so the output is not treated as authoritative either way.
 * @param {string} serial
 */
export async function uninstallHelper(serial) {
  // adbExecSafe never rejects: on this ROM a *successful* uninstall still
  // exits 1 and prints "Failure [...]". Output is logged, not trusted.
  return await adbExecSafe("-s", serial, "uninstall", HELPER_PACKAGE);
}

/**
 * Run the one-shot ListMain entry inside app_process as shell (uid 2000) and
 * resolve with its stdout text. The installed helper serves purely as the
 * classpath: no component starts and no permission is granted to the package.
 * @param {string} serial
 */
export function runHelperList(serial, extraArgs = []) {
  return deviceApkPath(serial).then((apkPath) => {
    if (!apkPath) {
      throw new Error(HELPER_SETUP_ERROR_PREFIX + "设备上未找到 Helper");
    }
    return new Promise((resolve, reject) => {
      execFile(
        adbPath(),
        [
          "-s",
          serial,
          "exec-out",
          `CLASSPATH=${apkPath}`,
          "app_process",
          "/system/bin",
          HELPER_ENTRY_CLASS,
          ...extraArgs,
        ],
        { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && !stdout && !stderr) reject(new Error(String(error.message)));
          else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        },
      );
    });
  });
}

// ---------------------------------------------------------------------------
// ListMain stdout parsing
// ---------------------------------------------------------------------------

/**
 * Parse ListMain stdout into renderer-shaped apps.
 * @param {string} text raw JSON line: {"apps":[{"packageName","label","iconPng"?}]}
 */
export function normalizeListOutput(stdout, stderr = "") {
  const raw = String(stdout ?? "");
  // Some ROMs print linker/ART noise around the JSON line; extract the object
  // between the outermost braces instead of parsing the whole stdout.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const detail = [stderr.trim().split("\n").slice(-3).join(" | "), raw.slice(0, 200)]
    .filter(Boolean)
    .join(" ␤ ");
  if (start === -1 || end <= start) {
    throw new Error(`Invalid helper output: ${detail || "(empty)"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error(`Invalid helper output: ${detail}`);
  }
  if (!parsed || !Array.isArray(parsed.apps)) {
    throw new Error(`Invalid helper output: no apps array`);
  }
  return parsed.apps.map((/** @type {any} */ app) => ({
    packageName: typeof app?.packageName === "string" ? app.packageName : "",
    label: typeof app?.label === "string" && app.label ? app.label : "",
    iconUrl:
      typeof app?.iconPng === "string" && app.iconPng
        ? `data:image/png;base64,${app.iconPng}`
        : null,
  }));
}

/** @param {{ packageName: string, label?: string, iconUrl?: string | null }} app */
function normalizeApp(app) {
  return {
    packageName: app.packageName,
    label: app.label || app.packageName,
    iconUrl: app.iconUrl || null,
  };
}

function uniqueApps(apps) {
  const seen = new Set();
  return apps.map(normalizeApp).filter((app) => {
    if (!app.packageName || seen.has(app.packageName)) return false;
    seen.add(app.packageName);
    return true;
  });
}

// ---------------------------------------------------------------------------
// App-list loading
// ---------------------------------------------------------------------------

/**
 * Load the installed-app list (labels and icons inline) for one device.
 * The app_process run is one-shot, so this resolves with the complete list.
 * @param {string} serial
 */
export async function loadInstalledApps(serial) {
  await ensureServer();
  if (!(await isHelperInstalled(serial))) await installHelper(serial);
  const { stdout } = await runHelperList(serial);
  const apps = uniqueApps(normalizeListOutput(stdout));

  // Phase 1 carries no icons; overlay the ones from the local cache so the
  // renderer can paint a complete-looking list before batch fetching starts.
  const now = Date.now();
  const cache = await readAppCache(serial);
  const cachedByPackage = new Map((cache?.apps || []).map((app) => [app.packageName, app]));
  const merged = apps.map((app) => {
    const cachedIcon = cachedByPackage.get(app.packageName);
    return {
      ...app,
      iconUrl: cachedIcon?.iconUrl || null,
      iconUpdatedAt: cachedIcon?.iconUpdatedAt || null,
    };
  });
  await writeAppCache(serial, snapshot(now, merged));
  return merged;
}

/** Shared snapshot shape for the app cache. */
function snapshot(now, apps) {
  return { authoritativeAt: now, writtenAt: now, apps: [...apps] };
}

/**
 * Fetch icons (base64 PNG data URLs) for one batch of packages — the renderer
 * calls this repeatedly, ~20 packages at a time.
 * @param {string} serial
 * @param {string[]} packages
 */
export async function getAppIcons(serial, packages) {
  const { stdout } = await runHelperList(serial, ["--icons", packages.join(",")]);
  const now = Date.now();
  // Stamp the fetch time so the renderer can tell fresh icons from expired ones.
  const fetched = normalizeListOutput(stdout)
    .filter((app) => app.iconUrl)
    .map((app) => ({ ...app, iconUpdatedAt: now }));

  // Persist each batch so the next cold start paints icons immediately.
  const cache = await readAppCache(serial);
  const byPackage = new Map((cache?.apps || []).map((app) => [app.packageName, { ...app }]));
  for (const app of fetched) {
    byPackage.set(app.packageName, {
      ...(byPackage.get(app.packageName) || app),
      iconUrl: app.iconUrl,
      iconUpdatedAt: now,
    });
  }
  await writeAppCache(serial, snapshot(cache?.authoritativeAt || now, [...byPackage.values()]));
  return fetched;
}
