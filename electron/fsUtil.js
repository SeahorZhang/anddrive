import { promises as fs } from "node:fs";

// 主进程里几处缓存/临时目录共用的文件系统小工具。

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
