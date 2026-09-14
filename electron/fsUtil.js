import { promises as fs } from "node:fs";
import path from "node:path";

// 主进程里几处缓存/临时目录共用的文件系统小工具。

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 删除目录下 mtime 早于 maxAgeMs 的条目（缓存清理）；单个失败忽略。 */
export async function pruneStaleEntries(dir, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  const entries = await fs.readdir(dir).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const stat = await fs.stat(entryPath).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** 把一个清理动作包成“进程内只执行一次”，失败不抛出。 */
export function onceAsync(task) {
  let promise = null;
  return () => {
    promise ||= Promise.resolve()
      .then(task)
      .catch(() => {});
    return promise;
  };
}
