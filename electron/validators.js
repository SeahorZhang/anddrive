// adb serial 与 Android 包名的合法性判定，唯一出处。
// 原先 adb.js / favorites.js / shortcutCore.js / storage.js / mirror/session.js 各写一遍，
// 口径已经开始漂（package 一处带正则、一处只查长度；serial 一处挡空白、一处不挡）。
// 这里只给谓词；「抛错 / 返回 null / 返回 []」由各自的入口按自己的语义决定。

const MAX_SERIAL_LENGTH = 1024;
const MAX_PACKAGE_LENGTH = 512;
const PACKAGE_NAME_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/** 可用的 adb serial：非空、不含空白、长度合理。首尾空白不计较，调用方自己 trim。 */
export function isValidSerial(value) {
  if (typeof value !== "string") return false;
  const serial = value.trim();
  return !!serial && serial.length <= MAX_SERIAL_LENGTH && !/\s/.test(serial);
}

/** 可用的 Android 包名：点分字母数字下划线。 */
export function isValidPackageName(value) {
  if (typeof value !== "string") return false;
  const pkg = value.trim();
  return !!pkg && pkg.length <= MAX_PACKAGE_LENGTH && PACKAGE_NAME_RE.test(pkg);
}
