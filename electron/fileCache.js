import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 文件内容缓存（把"网络盘"变成"打开过一次就是本地盘"）
//
// 抄的是 FileProvider 的物化语义（Sideport / AndroMeld 靠它拿到本地盘手感）：客户端第一次
// 读某个文件时，除了把要的那一段给它，还在背后把整份拉到本地磁盘；之后所有读（包括拖进度条
// 的随机 seek）都从本地磁盘出，不再受 adb 链路带宽限制（实测无线 adb 上限只有 ~8 MB/s）。
//
// 键里带 size 与 mtime：手机侧改了文件就自动落到另一个键，旧条目等 LRU 回收 ——
// 不需要"检测外部变更"那套逻辑。
// ---------------------------------------------------------------------------

/** 超过这个大小不物化（缓存也放不下，且多半是一次性拷走）。 */
export const MATERIALIZE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * 物化按块要，每块都重新问调用方要一次。一次 `dd` 拉整份会长时间独占 adb 链路与并发额度，
 * 用户那边的"正在看"就被饿死（实测 5MB 播放读从 ~1s 恶化到 13s）。
 */
export const MATERIALIZE_CHUNK = 2 * 1024 * 1024;

/** Range → 本地文件的读取区间；越界夹到文件末尾。 */
export function rangeSlice(size, start = 0, length) {
  if (!Number.isFinite(size) || size <= 0) return null;
  // 起点已在文件之外：给空而不是把最后一个字节重复发出去。
  if (Number.isFinite(start) && start >= size) return null;
  const from = Number.isFinite(start) && start > 0 ? Math.trunc(start) : 0;
  const want = Number.isFinite(length) && length > 0 ? Math.trunc(length) : size - from;
  const to = Math.min(from + want - 1, size - 1);
  if (to < from) return null;
  return { start: from, end: to };
}

/** 缓存条目名：设备 + 路径 + 大小 + 修改时间。 */
export function cacheKey({ serial, path, size, mtimeMs }) {
  return createHash("sha256")
    .update(`${serial}\u0000${path}\u0000${size}\u0000${mtimeMs ?? 0}`)
    .digest("hex");
}

/**
 * @param {{ dir: string, budgetBytes: number }} options 存放目录与容量上限（测试给临时目录）
 */
export function createFileCache({ dir, budgetBytes }) {
  /** 正在物化的键 → Promise：同一个文件只允许一份在跑。 */
  const inflight = new Map();
  /** 设备路径 → 该路径已写过的键集合。键里有 size/mtime，改过的文件会有好几个键。 */
  const byPath = new Map();
  const entryPath = (key) => join(dir, key);

  async function completeEntry(key, size) {
    // 半截的 `.part` 不算命中，只有改名后的完整文件才算。
    const info = await stat(entryPath(key)).catch(() => null);
    return info?.isFile() && info.size === size ? entryPath(key) : null;
  }

  /** 按 atime 从旧到新丢，直到回到预算内；刚写入的那个不参与。 */
  async function evict(keepKey) {
    const files = await readdir(dir).catch(() => []);
    const entries = [];
    let total = 0;
    for (const name of files) {
      if (name.endsWith(".part")) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (!info?.isFile()) continue;
      total += info.size;
      entries.push({ name, size: info.size, atime: info.atimeMs ?? 0 });
    }
    if (total <= budgetBytes) return;
    entries.sort((a, b) => a.atime - b.atime);
    for (const item of entries) {
      if (total <= budgetBytes) break;
      if (item.name === keepKey) continue;
      await unlink(join(dir, item.name)).catch(() => {});
      total -= item.size;
    }
  }

  /** 命中就碰一下 atime，让"正在看的文件"不被 LRU 踢掉。 */
  async function touch(key) {
    const now = new Date();
    await utimes(entryPath(key), now, now).catch(() => {});
  }

  /**
   * 读一段。返回 null 表示本地没有 —— 调用方走网络，并应当顺手 `materialize`。
   * @param {{ serial: string, path: string, size: number, mtimeMs?: number, start?: number, length?: number }} input
   */
  async function read(input) {
    const slice = rangeSlice(input.size, input.start, input.length);
    if (!slice) return null;
    const key = cacheKey(input);
    remember(input, key);
    const local = await completeEntry(key, input.size);
    if (!local) return null;
    await touch(key);
    // 先真的把文件打开，再交出一个不会再失败的流：条目随时可能被 LRU 淘汰，
    // 而 `createReadStream(path)` 是延后开文件的 —— 淘汰发生在 open 之前就会抛一个
    // 没人监听的 ENOENT，实测直接把进程带崩（产品里就是主进程没了）。
    // 打不开就返回 null，调用方按"本地没有"走设备侧，语义正好。
    const handle = await open(local).catch(() => null);
    if (!handle) return null;
    return { stream: handle.createReadStream(slice), close: () => {}, truncated: true };
  }

  /**
   * 后台物化整份文件。
   * @param {{ serial: string, path: string, size: number, mtimeMs?: number }} input
   * @param {(start: number, length: number) => Promise<Buffer>} fetch 从设备取一段字节
   * @param {() => Promise<void>} [beforeChunk] 每块之前的让路点；抛错即放弃这次物化
   */
  function materialize(input, fetch, beforeChunk) {
    const { size } = input;
    if (!Number.isFinite(size) || size <= 0 || size > MATERIALIZE_MAX_BYTES) return Promise.resolve(false);
    const key = cacheKey(input);
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      await mkdir(dir, { recursive: true });
      await evict(key);
      if (await completeEntry(key, size)) return true;
      remember(input, key);
      const part = `${entryPath(key)}.part`;
      /**
       * 写入端**按需开**：让路点第一轮就放弃时一个字节都没有，那时连文件都不该创建 ——
       * `createWriteStream` 是延后开文件的，"先开再 destroy + unlink" 会删在 open 之前，
       * 实测留下一个永远清不掉的 `.part`。真的要写之后，清理也必须等 `'close'` 再 `unlink`。
       */
      let sink = null;
      const discard = async () => {
        if (!sink) return;
        // 等 `'close'` 再删，但**最多等 2 秒**：流已经关完时 `'close'` 不会再发，
        // 死等会让这个键的 inflight 永远挂着（这个文件从此不再物化）。
        // POSIX 下对仍开着的 fd 调 unlink 也是立刻从目录里消失，所以超时删不会留残骸。
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          if (sink.destroyed || sink.writableEnded) return done();
          sink.once("close", done);
          sink.on("error", done);
          sink.destroy();
        });
        await unlink(part).catch(() => {});
      };
      try {
        for (let offset = 0; offset < size; offset += MATERIALIZE_CHUNK) {
          await beforeChunk?.();
          const chunk = await fetch(offset, Math.min(MATERIALIZE_CHUNK, size - offset));
          sink ??= createWriteStream(part, { flags: "w" });
          const written = await new Promise((resolve, reject) =>
            sink.write(chunk, (error) => (error ? reject(error) : resolve(chunk.length))),
          );
          if (written !== chunk.length) throw new Error("写入不完整");
        }
        if (!sink) throw new Error("一个字节都没取到");
        await new Promise((resolve, reject) => sink.end((error) => (error ? reject(error) : resolve())));
        const info = await stat(part).catch(() => null);
        if (!info || info.size !== size) throw new Error("物化不完整");
        await rename(part, entryPath(key));
        return true;
      } catch {
        await discard();
        return false;
      }
    })();
    inflight.set(key, run);
    run.then(() => inflight.delete(key), () => inflight.delete(key));
    return run;
  }

  function remember(input, key) {
    const id = `${input.serial}\u0000${input.path}`;
    let keys = byPath.get(id);
    if (!keys) byPath.set(id, (keys = new Set()));
    keys.add(key);
  }

  /**
   * 我们自己写过 / 删过 / 改名过的路径，缓存全部作废（按路径找，因为旧 size/mtime
   * 已经算不出当初那个键了）。
   */
  async function invalidatePath(serial, path) {
    const keys = byPath.get(`${serial}\u0000${path}`) ?? new Set();
    byPath.delete(`${serial}\u0000${path}`);
    for (const key of keys) {
      inflight.delete(key);
      await unlink(entryPath(key)).catch(() => {});
      await unlink(`${entryPath(key)}.part`).catch(() => {});
    }
  }

  return { read, materialize, invalidatePath, entryPath };
}
