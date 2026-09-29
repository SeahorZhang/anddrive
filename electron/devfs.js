import { app } from "electron";
import { Readable } from "node:stream";
import { join } from "node:path";
import { AdbServerNodeJsClient } from "@yume-chan/adb-server-node-tcp";
import { onDeviceTeardown } from "./adb.js";
import { createFileCache } from "./fileCache.js";
import { createReadWindowCache, planWindowFetch } from "./readWindow.js";

// ---------------------------------------------------------------------------
// 设备文件系统
//
// 热路径（列目录 / 取属性 / 读 / 写）走 **adb sync 协议**，跑在一条长连接上
// （`@yume-chan/adb-server-node-tcp` → 本机 adb server）。之前每个请求 spawn 一次
// `adb` 进程，实测代价是：createAdb 11ms vs spawn 一次 ~300ms；895 项目录
// sync 111ms vs shell 200–360ms；读 2.6 MB sync 208ms vs `exec-out cat` 1.3s。
// 写也不再需要"先落本机临时文件再 adb push"（那条路不能流式，大文件双写本机磁盘）：
// sync 的 SEND 直接把请求体流到设备上。
//
// sync 没有对应操作的（带偏移的读、mkdir/rm/mv/cp）走同一条连接上的 `exec:` ——
// 它不分配 pty，所以二进制安全；但命令仍由设备侧 `sh -c` 执行，参数得我们自己引。
// 根目录 `/` 在 Android 上是只读文件系统（实测 `touch /x` → Read-only file system），
// 所以写不写得动按卷决定，不是全局开关。
// ---------------------------------------------------------------------------

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
/** dirent 的 DT_DIR；ls2 之外的旧设备只给 mode。 */
const DT_DIR = 4;
const DEFAULT_FILE_MODE = 0o644;
/**
 * sync 的压缩格式「不压缩」。`@yume-chan/adb` 没导出这个枚举，值取自 AOSP
 * `file_sync_protocol.h`（None=0 / Brotli=2 / Lz4=3 / Zstd=4）。
 * 必须显式传：不传时库会 `chooseFormat` 自动挑 Zstd（设备支持就选它），
 * 而我们这一跳到本机 adb server 根本不过网络，压缩纯属倒贴 —— 实测写 2.6 MB
 * 自动档 4.4s，关掉压缩后回到与 `adb push` 同级。
 */
const COMPRESSION_NONE = 0;

/**
 * 同时在飞的设备操作上限。抄 Sideport 的做法（它也是 6）：不限的话一次拖窗能排起
 * 几十个 dd，把这条本来就不快的链路堵死，观感反而更卡。
 */
const MAX_CONCURRENT_DEVICE_OPS = 6;
let activeOps = 0;
const waitingOps = [];

async function deviceSlot() {
  if (activeOps >= MAX_CONCURRENT_DEVICE_OPS) {
    await new Promise((resolve) => waitingOps.push(resolve));
  }
  activeOps += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    activeOps -= 1;
    waitingOps.shift()?.();
  };
}

/** 元数据类操作的超时；文件流不能套超时（拷大文件会正当中被打断）。 */
const OP_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 60_000;
/** `%n` 路径、`%F` 类型文字、`%s` 字节、`%Y` mtime（epoch 秒）。 */
const STAT_FORMAT = "%n|%F|%s|%Y";

// 清单要新（新建的文件得马上看得见），属性可以久一点：播放一个文件时访达会反复问它的
// 大小，太短的 TTL 会在一次播放中途过期，于是每个 Range 请求都多付一次往返。
const STAT_TTL_MS = 10_000;
const LIST_TTL_MS = 2000;

/**
 * 顺序读窗口。访达播放视频是按 **64 KB 一块**发 Range 请求的，每块都重新 seek 一次设备
 * 就要 150–350ms —— 那就是"几秒卡一次"。所以确认是"接着上一窗往下读"就一次取满 8 MB，
 * 后续请求全从内存出。
 * ⚠️ 反过来，**零散的小读绝不许多取**：图片夹里每个文件只读文件头 100–200 KB，
 * 曾经不管请求多小都按 2 MB 起取，实测开一次文件夹要 2.6 MB 真需求却从手机上拉了 42 MB
 * （16 倍），观感就是"全是图片的文件夹超慢"。窗大小由 `planWindowFetch` 决定。
 */
const WINDOW_BYTES = 8 * 1024 * 1024;
const WINDOW_BUDGET = 64 * 1024 * 1024;

/** key = `${serial}\0${path}`。存放与命中规则拆到 readWindow.js 单独测。 */
const windows = createReadWindowCache({ budgetBytes: WINDOW_BUDGET });

/**
 * 短 TTL 的元数据缓存。访达每打开一个文件都会逐层 PROPFIND 解析路径（实测一次开视频
 * 12 次），而这些查询打在 sync 上每次 10–80ms，纯固定开销。
 */
export function createTtlCache(ttlMs, maxEntries = 4000) {
  const store = new Map();
  const key = (serial, path) => `${serial}\u0000${path}`;
  const trim = () => {
    if (store.size > maxEntries) store.delete(store.keys().next().value);
  };
  return {
    async resolve(serial, path, loader) {
      const id = key(serial, path);
      const hit = store.get(id);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const value = await loader();
      store.set(id, { at: Date.now(), value });
      trim();
      return value;
    },
    /** 用别处已经拿到的数据填缓存（列目录顺带填子项属性）。 */
    fill(serial, path, value) {
      store.set(key(serial, path), { at: Date.now(), value });
      trim();
    },
    /** 设备侧改了什么，就把"它本身 + 它的内容 + 它所在目录的清单"全部作废。 */
    invalidate(serial, path) {
      store.delete(key(serial, path));
      store.delete(key(serial, `${path}/`));
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      // 目录清单的键带尾斜杠，比较时统一去掉，否则新建文件后父目录清单还留着。
      const doomed = [];
      for (const id of store.keys()) {
        const [owner, target] = id.split("\u0000");
        if (owner !== serial) continue;
        const flat = target.length > 1 ? target.replace(/\/+$/, "") : target;
        if (flat === parent || flat === path || target.startsWith(`${path}/`)) doomed.push(id);
      }
      for (const id of doomed) store.delete(id);
    },
    has: (serial, path) => store.has(key(serial, path)) || store.has(key(serial, `${path}/`)),
    clear: () => store.clear(),
    get size() {
      return store.size;
    },
  };
}

const statCache = createTtlCache(STAT_TTL_MS);
const listCache = createTtlCache(LIST_TTL_MS);

/** 任何写操作之后作废元数据与该文件的读窗口；导出给测试与将来的外部失效。 */
export function invalidateDeviceMeta(serial, path) {
  statCache.invalidate(serial, path);
  listCache.invalidate(serial, path);
  windows.drop(`${serial}\u0000${path}`);
  const staleServed = [];
  const prefix = `${serial}\u0000${path}\u0000`;
  for (const id of lastTouched.keys()) if (id.startsWith(prefix)) lastTouched.delete(id);
  for (const id of servedBytes.keys()) if (id.startsWith(prefix)) staleServed.push(id);
  for (const id of staleServed) servedBytes.delete(id);
  fileCache.invalidatePath(serial, path).catch(() => {});
}

// ---------------------------------------------------------------------------
// 设备连接
// ---------------------------------------------------------------------------

let serverClient = null;
/** serial → 建线中的 Promise（并发请求共用同一次 createAdb） */
const connections = new Map();

function client() {
  serverClient ??= new AdbServerNodeJsClient();
  return serverClient;
}

/** 一条设备长连接；建失败过的连接会被丢掉，下次调用重建。 */
export async function getDeviceConnection(serial) {
  let pending = connections.get(serial);
  if (!pending) {
    pending = client().createAdb({ serial });
    pending.catch(() => connections.delete(serial));
    connections.set(serial, pending);
  }
  return pending;
}

export async function closeDeviceConnection(serial) {
  const pending = connections.get(serial);
  if (!pending) return;
  connections.delete(serial);
  const adb = await pending.catch(() => null);
  await adb?.close?.().catch?.(() => {});
}

export function clearDeviceMetaCache() {
  statCache.clear();
  listCache.clear();
  windows.clear();
}

// ---------------------------------------------------------------------------
// 路径与解析
// ---------------------------------------------------------------------------

/** 单引号包住并把内部单引号转义掉：设备侧唯一安全的引法。 */
export function quoteShell(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * WebDAV 请求里的相对路径 → 设备绝对路径。
 * `root` 是挂载时锁死的那个目录，任何越界（`..`、坏百分号编码）都返回 null，
 * 由调用方发 404 —— 挂载点之外不该被看见，哪怕设备侧本来就读不到。
 */
export function resolveDevicePath(root, requestPath) {
  if (typeof root !== "string" || !root.startsWith("/")) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(String(requestPath ?? ""));
  } catch {
    return null;
  }
  const segments = [];
  for (const part of decoded.split(/[/?#]/)) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    segments.push(part);
  }
  const base = root === "/" ? "" : root.replace(/\/+$/, "");
  // 空请求路径就是挂载根本身；这里不能塌回 "/"，否则每个卷都会露出设备的真实根目录。
  if (!segments.length) return base || "/";
  return `${base}/${segments.join("/")}`;
}

/**
 * sync 的 stat / dirent 记录 → 面板与 WebDAV 用的条目。
 * `size`/`mtime` 在 ls2/stat2 下是 BigInt，统一收成数字；目录判定优先看 `type`
 * （dirent 的 d_type），旧设备只给 `mode` 时按 S_IFDIR 位判。
 */
export function toDeviceEntry(path, raw) {
  const mode = Number(raw?.mode ?? 0);
  const dir = Number(raw?.type) === DT_DIR || (mode & S_IFMT) === S_IFDIR;
  const size = Number(raw?.size ?? 0);
  const mtime = Number(raw?.mtime ?? 0);
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1) || path,
    dir,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    mtimeMs: Number.isFinite(mtime) && mtime > 0 ? mtime * 1000 : 0,
  };
}

/**
 * `toybox stat -c '%n|%F|%s|%Y'` 的多行输出 → 条目。
 * 从右往左取字段：路径本身可以含 `|`，而类型/大小/时间不可能。
 * 只给"设备不支持 stat2"的老 ROM 兜底用。
 * @param {string} text
 */
export function parseStatOutput(text) {
  const entries = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const mtimeSec = Number(parts.pop());
    const size = Number(parts.pop());
    const type = parts.pop();
    const path = parts.join("|");
    if (!path.startsWith("/")) continue;
    entries.push({
      path,
      name: path.slice(path.lastIndexOf("/") + 1) || path,
      dir: type === "directory",
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      mtimeMs: Number.isFinite(mtimeSec) && mtimeSec > 0 ? mtimeSec * 1000 : 0,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 设备命令
// ---------------------------------------------------------------------------

/**
 * 在长连接上跑一条设备命令。
 *
 * 首选 `shell,v2,raw:`：stdout / stderr 分开，还带**真退出码**（Sideport 也是走这条）。
 * 老的 `exec:` 没有退出码通道、且 stdout 与 stderr 混在一起，只能"一有输出就算失败"，
 * 所以只在设备不支持 shell_v2 时兜底。
 */
async function runOnDevice(serial, args, timeoutMs = OP_TIMEOUT_MS) {
  const adb = await getDeviceConnection(serial);
  const signal = AbortSignal.timeout(timeoutMs);
  if (adb.features?.has?.("shell_v2")) {
    const result = await adb.subprocess.shell.spawn(args, signal).wait();
    const stderr = decode(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(stderr.split("\n").filter(Boolean).pop() || `命令失败（退出码 ${result.exitCode}）`);
    }
    return decode(result.stdout).trim();
  }
  const text = await decode(await adb.subprocess.noneProtocol.spawn(args, signal).wait()).trim();
  if (text) throw new Error(text.split("\n").pop());
  return text;
}

function decode(bytes) {
  return new TextDecoder().decode(bytes ?? new Uint8Array());
}

async function shellStat(serial, path) {
  // 走 shell_v2 时 stdout 就是结果、stderr 不会混进来，所以不再需要 `2>/dev/null`。
  const out = await runOnDevice(serial, [
    "toybox", "stat", "-c", quoteShell(STAT_FORMAT), quoteShell(path),
  ]).catch(() => "");
  return parseStatOutput(out)[0] ?? null;
}

// ---------------------------------------------------------------------------
// 属性与目录（带缓存）
// ---------------------------------------------------------------------------

/** 单个路径的属性；不存在返回 null。 */
export function statDevicePath(serial, path) {
  return statCache.resolve(serial, path, async () => {
    const adb = await getDeviceConnection(serial);
    if (!adb.sync.supportsStat2) return shellStat(serial, path);
    const stat = await adb.sync.stat(path).catch(() => null);
    return stat ? toDeviceEntry(path, stat) : null;
  });
}

/** 列一层目录；空目录与读不到都是空数组。 */
export function listDeviceDir(serial, path) {
  return listCache.resolve(serial, `${path}/`, async () => {
    const adb = await getDeviceConnection(serial);
    const entries = await adb.sync.readdir(path).catch(() => null);
    if (!entries) return [];
    const base = path === "/" ? "" : path;
    const mapped = entries
      .filter((entry) => entry?.name && entry.name !== "." && entry.name !== "..")
      .map((entry) => toDeviceEntry(`${base}/${entry.name}`, entry));
    // 访达列完目录会**逐个条目**再问一次属性（895 项就是 895 次）。清单里本来就有
    // 这些字段，顺手把子项的 stat 填进缓存，省掉整轮往返。
    for (const item of mapped) statCache.fill(serial, item.path, item);
    return mapped;
  });
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/** 内容缓存：整个进程一份，放在 userData 下（卸载/退出都不碰设备）。 */
const fileCache = createFileCache({
  dir: join(app.getPath("userData"), "file-cache"),
  budgetBytes: 4 * 1024 * 1024 * 1024,
});

/**
 * 累计读过这么多字节才物化整个文件。缩略图/预览只要文件头几 KB～几十 KB，
 * 一翻相册就几十上百个文件各拉一整份，链路直接被自己堵死（实测观感反而更慢）。
 * 真在看视频或拷文件才会越过这条线。
 */
const MATERIALIZE_TRIGGER_BYTES = 4 * 1024 * 1024;
/** 块间休息：把后台带宽压到链路的一小截。 */
const THROTTLE_BETWEEN_CHUNKS_MS = 800;
/** 这个文件连续这么久没被读，才允许后台物化继续。 */
const FILE_QUIET_MS = 4000;

/** 累计等满这么久这个文件还是没安静下来，这一轮物化就放弃（下一次读会重新触发）。 */
const MATERIALIZE_MAX_WAIT_MS = 60_000;

/** 每个文件累计已发出的字节（键同 fileCache，文件一改就自动分家）。 */
const servedBytes = new Map();
/** 每个文件最近一次被读的时刻：物化只有在"这个文件没在被看"时才动手。 */
const lastTouched = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheIdOf(serial, path, meta) {
  return `${serial}\u0000${path}\u0000${meta.size}\u0000${meta.mtimeMs ?? 0}`;
}

/**
 * 物化的让路点，每块之前跑一次。判据是**这个文件还在被读**，不是"链路是否空闲" ——
 * 窗内命中是 0ms，链路永远看着是空的，按链路让路等于不让。
 */
function waitForFileIdle(id) {
  const deadline = Date.now() + MATERIALIZE_MAX_WAIT_MS;
  let chunksSoFar = 0;
  return async () => {
    if (chunksSoFar++) await sleep(THROTTLE_BETWEEN_CHUNKS_MS);
    while (Date.now() - (lastTouched.get(id) ?? 0) < FILE_QUIET_MS) {
      if (Date.now() > deadline) throw new Error("物化一直在让路");
      await sleep(200);
    }
  };
}

function materializeFile(meta, serial, path, id) {
  return fileCache.materialize(
    { serial, path, size: meta.size, mtimeMs: meta.mtimeMs },
    (start, length) => fetchBytes(serial, path, start, length),
    waitForFileIdle(id),
  );
}

/** 从设备取一段字节（占一个并发额度）。 */
async function fetchBytes(serial, path, start, want) {
  const release = await deviceSlot();
  try {
    // 从文件头取一律走 sync RECV：`toybox dd` 要 spawn 一个进程，实测一个 100–400 KB
    // 的小文件 131ms，而同样的量 sync RECV（读够就取消）只要 45ms。图片夹一次开几十个
    // 这种小文件，差的就是这 3 倍固定开销；dd 只留给"从中间偏移取"（RECV 不支持偏移）。
    return start === 0
      ? await fetchFromStartUnlocked(serial, path, want)
      : await fetchBytesUnlocked(serial, path, start, want);
  } finally {
    release();
  }
}

/** 从头取够 `want` 就取消整份 RECV（大文件不能被这一刀拖成整份传输）。 */
async function fetchFromStartUnlocked(serial, path, want) {
  const adb = await getDeviceConnection(serial);
  const session = await adb.sync.createReadable(path, COMPRESSION_NONE);
  const source = Readable.fromWeb(session.readable);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= want) break;
    }
  } catch {
    // 取消半截 RECV 时链路可能报错，但已经拿到的那一段是真数据，照旧交出去。
  } finally {
    source.destroy();
  }
  return Buffer.concat(chunks, total);
}

async function fetchBytesUnlocked(serial, path, start, want) {
  const adb = await getDeviceConnection(serial);
  const bytes = await adb.subprocess.noneProtocol
    .spawn(
      [
        "toybox", "dd", `if=${quoteShell(path)}`, "bs=1M", "iflag=skip_bytes,count_bytes",
        `skip=${Math.trunc(start)}`, `count=${Math.trunc(want)}`, "2>/dev/null",
      ],
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
    .wait();
  return Buffer.from(bytes ?? new Uint8Array());
}

/**
 * 未命中时同步取多少：只按被要的那一段（下限 256 KB）。
 * 顺序续读时整窗在背后补（`prefetchWindow`）—— 把 8 MB 的传输算进"用户正在等的这一块"，
 * 观感就是播到第 4 秒卡一下。
 */
async function fetchWindowFor(serial, path, key, start, length) {
  const sequential = windows.end(key) === start;
  const want = planWindowFetch({ length, sequential, maxBytes: WINDOW_BYTES });
  const data = await fetchBytes(serial, path, start, want);
  windows.store(key, start, data);
  return { data, sequential };
}

/** 背后把这一窗补满到大窗；同一个键只允许一份在跑。 */
const prefetching = new Set();

function prefetchWindow(serial, path, key, start, id) {
  if (prefetching.has(key)) return;
  // 已经越过物化阈值的文件交给磁盘缓存，别再从链路上走一遍。
  if ((servedBytes.get(id) ?? 0) >= MATERIALIZE_TRIGGER_BYTES) return;
  prefetching.add(key);
  fetchBytes(serial, path, start, WINDOW_BYTES)
    .then((data) => windows.store(key, start, data))
    .catch(() => windows.drop(key))
    .finally(() => prefetching.delete(key));
}

async function openWindowed(serial, path, start, length, id) {
  const key = `${serial}\u0000${path}`;
  const hit = windows.hit(key, start, length);
  if (hit) return { buffer: hit, close: () => {}, truncated: true };
  const { data, sequential } = await fetchWindowFor(serial, path, key, start, length);
  if (sequential && data.length < WINDOW_BYTES) prefetchWindow(serial, path, key, start, id);
  return { buffer: data.subarray(0, Math.min(length, data.length)), close: () => {}, truncated: true };
}

/**
 * 统计"这个文件真被取走了多少字节"。按**请求长度**记会翻车：访达对每个文件都发一条
 * "从这个偏移一直到文件尾"的读，实际只要前几百 KB 就收手，那样相册里每张 12 MB 的照片
 * 都会被判定成"值得物化"，然后每张都白拉一整份。
 */
function noteServed(id, bytes) {
  const before = servedBytes.get(id) ?? 0;
  servedBytes.set(id, before + bytes);
  return before < MATERIALIZE_TRIGGER_BYTES && before + bytes >= MATERIALIZE_TRIGGER_BYTES;
}

/**
 * 打开只读流。
 * sync 的 RECV 不支持偏移量，所以带 `start` 的读走设备侧 `dd`：
 * `iflag=skip_bytes,count_bytes` 是**字节精确的 lseek**（实测中段 1 MB 149ms、
 * 尾块 102ms），而 `tail -c +N` 要 350–830ms。
 * @returns {Promise<{ stream?: import("node:stream").Readable, buffer?: Buffer, close: () => void, truncated?: boolean }>}
 */
export async function openDeviceFile(serial, path, start = 0, length) {
  // 先看本地磁盘：物化过的文件从这里出，完全不碰 adb（这是"第二次打开秒开"的那一步）。
  const meta = await statDevicePath(serial, path);
  let id = null;
  if (meta && !meta.dir) {
    id = cacheIdOf(serial, path, meta);
    lastTouched.set(id, Date.now());
    const cached = await fileCache.read({ serial, path, size: meta.size, mtimeMs: meta.mtimeMs, start, length });
    if (cached) return cached;
  }
  // 长度已知且不超过一窗：走窗口缓存。整份拷贝（没有 Range）不进内存，直接流过去。
  if (Number.isFinite(length) && length > 0 && length <= WINDOW_BYTES) {
    const file = await openWindowed(serial, path, Number.isFinite(start) ? start : 0, length, id);
    // 只有**真被取走**的量才参与"要不要整份留在本地"的判断；流式路径不触发物化，
    // 因为那本来就是客户端在整份读，背后再拉一遍纯属翻倍。
    if (id && noteServed(id, file.buffer.length)) materializeFile(meta, serial, path, id).catch(() => {});
    return file;
  }
  const adb = await getDeviceConnection(serial);
  if (Number.isFinite(start) && start > 0) {
    const args = [
      "toybox", "dd", `if=${quoteShell(path)}`, "bs=1M", "iflag=skip_bytes,count_bytes",
      `skip=${Math.trunc(start)}`,
    ];
    if (Number.isFinite(length) && length > 0) args.push(`count=${Math.trunc(length)}`);
    const process = await adb.subprocess.noneProtocol.spawn(args);
    return {
      stream: Readable.fromWeb(process.output),
      close: () => process.kill?.(),
      // dd 已经按 count_bytes 收口，服务端不用再截断。
      truncated: args.some((arg) => String(arg).startsWith("count=")),
    };
  }
  // 读同理：不传 compression 会被自动升到 Zstd，解压这一侧的 CPU 白付。
  const session = await adb.sync.createReadable(path, COMPRESSION_NONE);
  return {
    stream: Readable.fromWeb(session.readable),
    close: () => {
      session.readable?.cancel?.().catch?.(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/** 把一条本机流写进设备路径：sync SEND 全程流式，不落临时文件。 */
export async function writeDeviceFile(serial, devicePath, stream) {
  const adb = await getDeviceConnection(serial);
  await adb.sync.write({
    path: devicePath,
    permission: DEFAULT_FILE_MODE,
    compression: COMPRESSION_NONE,
    readable: Readable.toWeb(stream),
  });
  invalidateDeviceMeta(serial, devicePath);
}

export async function makeDeviceDir(serial, devicePath) {
  await runOnDevice(serial, ["toybox", "mkdir", quoteShell(devicePath)]);
  invalidateDeviceMeta(serial, devicePath);
}

/** 删除。递归是 WebDAV DELETE 的语义（删集合要连内容一起删）。 */
export async function removeDevicePath(serial, devicePath) {
  await runOnDevice(serial, ["toybox", "rm", "-r", quoteShell(devicePath)]);
  invalidateDeviceMeta(serial, devicePath);
}

export async function moveDevicePath(serial, from, to) {
  await runOnDevice(serial, ["toybox", "mv", quoteShell(from), quoteShell(to)]);
  invalidateDeviceMeta(serial, from);
  invalidateDeviceMeta(serial, to);
}

export async function copyDevicePath(serial, from, to) {
  await runOnDevice(serial, ["toybox", "cp", "-R", quoteShell(from), quoteShell(to)]);
  invalidateDeviceMeta(serial, to);
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/**
 * 一个挂载点对应的设备操作集合。WebDAV 服务只认这个接口，
 * 所以协议层可以用本机临时目录当假设备来测。
 */
export function createDeviceAdapter({ serial, root, readOnly, displayName }) {
  return {
    root,
    displayName,
    readOnly: Boolean(readOnly),
    stat: (path) => statDevicePath(serial, path),
    list: (path) => listDeviceDir(serial, path),
    open: (path, start, length) => openDeviceFile(serial, path, start, length),
    write: (path, stream) => writeDeviceFile(serial, path, stream),
    mkdir: (path) => makeDeviceDir(serial, path),
    remove: (path) => removeDevicePath(serial, path),
    move: (from, to) => moveDevicePath(serial, from, to),
    copy: (from, to) => copyDevicePath(serial, from, to),
  };
}

// 设备断开：连接留着只会让下一次 sync 调用挂在超时上；缓存与窗口同理
// （换设备后路径含义都变了）。
onDeviceTeardown((serial) => {
  clearDeviceMetaCache();
  return serial
    ? closeDeviceConnection(serial)
    : Promise.all([...connections.keys()].map((one) => closeDeviceConnection(one)));
});
