// 桌面投屏快捷方式的纯逻辑部分（无 Electron 依赖，可独立测试）。
//
// 快捷方式是一个 `.adr` 文件，内容为 JSON：`{ type, version, url }`，
// `url` 是 `anddrive://mirror?…` 地址。双击时系统按文件关联交给 AndDrive，
// 主进程读取文件并还原出投屏请求。
//
// 后缀避开了 `.anddrive`：那是 AndroMeld 已声明的文件类型（其“投屏设置指引”），
// 会被系统优先交给 AndroMeld。`.adr` 目前无人占用，AndDrive 才能成为默认。

/** `anddrive://` 自定义协议，需与 electron-builder.json 的 protocols 一致。 */
export const MIRROR_SCHEME = "anddrive";
/** 快捷方式文件后缀，必须与 electron-builder.json 的 fileAssociations 一致。 */
export const MIRROR_FILE_EXTENSION = "adr";
const SHORTCUT_FILE_TYPE = "anddrive-mirror-shortcut";
const SHORTCUT_FILE_VERSION = 1;
const MAX_SERIAL_LENGTH = 1024;
const MAX_LABEL_LENGTH = 120;
const MAX_NAME_LENGTH = 80;

/** @param {unknown} value @returns {string} */
export function sanitizeSerial(value) {
  if (typeof value !== "string") throw new Error("设备地址无效");
  const serial = value.trim();
  if (!serial || serial.length > MAX_SERIAL_LENGTH || /\s/.test(serial)) {
    throw new Error("设备地址无效");
  }
  return serial;
}

/** 去掉控制字符并截断的展示文本；非字符串返回空串。 */
export function sanitizeLabel(value) {
  if (typeof value !== "string") return "";
  let cleaned = "";
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) >= 0x20) cleaned += char;
  }
  return cleaned.trim().slice(0, MAX_LABEL_LENGTH);
}

/** 生成可用作文件名的字符串。 */
export function sanitizeShortcutName(label, fallback) {
  const raw =
    sanitizeLabel(label) || (typeof fallback === "string" ? fallback : "") || "AndDrive 投屏";
  const cleaned = raw
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || "AndDrive 投屏";
}

/**
 * 构造唤起投屏的 URL。所有字段经 URLSearchParams 编码，无法注入 shell。
 * @param {{ serial: string, packageName: string, label?: string }} request
 */
export function buildMirrorUrl(request) {
  const url = new URL(`${MIRROR_SCHEME}://mirror`);
  url.searchParams.set("address", request.serial);
  url.searchParams.set("package", request.packageName);
  if (request.label) url.searchParams.set("label", request.label);
  return url.toString();
}

/**
 * 解析快捷方式 URL；非法或非投屏 URL 返回 null。
 * @param {unknown} rawUrl
 * @returns {{ serial: string, packageName: string, label: string } | null}
 */
export function parseMirrorUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${MIRROR_SCHEME}:` || url.hostname !== "mirror") return null;
  const serial = url.searchParams.get("address");
  const packageName = url.searchParams.get("package");
  if (!serial || !packageName) return null;
  const label = url.searchParams.get("label") || packageName;
  return { serial, packageName, label };
}

/** 快捷方式文件内容：JSON 序列化的投屏地址，便于将来扩展字段。 */
export function buildShortcutContent(request) {
  return `${JSON.stringify(
    { type: SHORTCUT_FILE_TYPE, version: SHORTCUT_FILE_VERSION, url: buildMirrorUrl(request) },
    null,
    2,
  )}\n`;
}

/**
 * 解析快捷方式文件内容（JSON 包装格式，见 buildShortcutContent）。
 * @param {unknown} content
 * @returns {{ serial: string, packageName: string, label: string } | null}
 */
export function parseShortcutContent(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const data = JSON.parse(trimmed);
    if (data && typeof data.url === "string") return parseMirrorUrl(data.url);
  } catch {
    // 落到下方统一返回 null
  }
  return null;
}

/** 判断 argv 里的某个参数是否是 `.adr` 快捷方式文件。 */
export function isShortcutFile(value) {
  return (
    typeof value === "string" &&
    value.toLowerCase().endsWith(`.${MIRROR_FILE_EXTENSION}`)
  );
}

/**
 * 从命令行参数里找出 `.adr` 快捷方式路径（冷启动 / second-instance 用）。
 * @param {unknown} args
 * @returns {string | null}
 */
export function extractShortcutFile(args) {
  if (!Array.isArray(args)) return null;
  for (const arg of args) {
    if (isShortcutFile(arg)) return arg;
  }
  return null;
}

/**
 * 从命令行参数里找出 `anddrive://` URL（协议唤起 / second-instance 用）。
 * @param {unknown} args
 * @returns {string | null}
 */
export function extractMirrorUrl(args) {
  if (!Array.isArray(args)) return null;
  for (const arg of args) {
    if (typeof arg === "string" && arg.startsWith(`${MIRROR_SCHEME}://`)) return arg;
  }
  return null;
}
