// 设备存储按卷建模（纯函数，主/渲染层都能用；采集在 electron/storage.js）。
//
// 数据只有一个来源：helper 的 `StorageMain`（app_process，shell uid）。它逐条对齐竞品的读法 ——
// 卷用 `StorageManager.getVolumes()` + `VolumeInfo` 反射枚举，**内部卷的总容量走存储统计服务**
// （带保留区，这台机上 528.0 GB），可用量走 `StatFs.getAvailableBytes()`。
// 之前用 `df -k` 读的是文件系统容量（512.4 GB），和手机设置/竞品都对不上，所以整条 df 路径删掉了：
// 同一个面板里不许有两个容量口径。

/** 面板上根目录那一格的形状（Android 的 `/` 没有"容量"可言，只列条目数）。 */
const ROOT_VOLUME = {
  id: "root",
  label: "根目录",
  path: "/",
  kind: "root",
};

/**
 * 相机不是卷，是内部存储下的 `DCIM` 目录 —— 但它是用户最常想单独挂的东西
 * （挂上就是一台可以直接拖照片出来的网络相机），所以从内部存储派生一格。
 */
const CAMERA_DIR = "DCIM";

function toCount(value) {
  const count = Number(value);
  // helper 读不到目录时给 -1，与「空目录（0 项）」是两回事。
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function roundPercent(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((used / total) * 100);
}

/** helper 的一条卷 → 面板用的卷；`usedBytes` 按「总容量 − 可用」算，与竞品同口径。 */
function toVolume(raw) {
  const totalBytes = Number(raw?.totalBytes);
  const freeBytes = Number(raw?.freeBytes);
  const hasCapacity = Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(freeBytes);
  const usedBytes = hasCapacity ? totalBytes - freeBytes : null;
  const internal = raw?.kind === "internal";
  return {
    id: internal ? "internal" : `sd:${raw?.id ?? raw?.path ?? ""}`,
    label: internal ? "内部存储" : raw?.description || "SD 卡",
    path: typeof raw?.path === "string" ? raw.path : "",
    kind: internal ? "shared" : "removable",
    // 共享存储与可移动卡是 FUSE 挂载，shell uid 写得动。
    readOnly: false,
    entryCount: toCount(raw?.entryCount),
    totalBytes: hasCapacity ? totalBytes : null,
    usedBytes,
    availableBytes: hasCapacity ? freeBytes : null,
    percentUsed: roundPercent(usedBytes, totalBytes),
  };
}

/**
 * helper stdout → 卷列表。
 * @param {string} text 一行 JSON：`{"volumes":[...],"rootEntries":N}`
 */
export function parseHelperReport(text) {
  const raw = String(text ?? "");
  // 某些 ROM 会在 JSON 前后打 linker/ART 噪声，取最外层花括号之间的内容。
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Helper 存储输出无法解析");
  const payload = JSON.parse(raw.slice(start, end + 1));

  const volumes = (Array.isArray(payload?.volumes) ? payload.volumes : []).map(toVolume);
  volumes.push({
    ...ROOT_VOLUME,
    // Android 的 `/` 是只读文件系统，挂出来只能看。
    readOnly: true,
    entryCount: toCount(payload?.rootEntries),
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    percentUsed: null,
  });

  const internal = volumes.find((item) => item.id === "internal") || null;
  if (internal) {
    volumes.unshift({
      id: "camera",
      label: "相机存储",
      path: `${internal.path}/${CAMERA_DIR}`,
      kind: "camera",
      entryCount: null,
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      percentUsed: null,
    });
  }

  return {
    volumes,
    summary: {
      totalBytes: internal?.totalBytes ?? null,
      usedBytes: internal?.usedBytes ?? null,
      availableBytes: internal?.availableBytes ?? null,
      percentUsed: internal?.percentUsed ?? null,
    },
  };
}
