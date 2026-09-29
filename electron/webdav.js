import http from "node:http";
import { randomUUID } from "node:crypto";
import { resolveDevicePath } from "./devfs.js";

// ---------------------------------------------------------------------------
// 本地 WebDAV（只读）
//
// macOS 自带的 `mount_webdav` 能把 http://127.0.0.1:<port>/<token>/ 挂成真正的卷，
// 不需要管理员、不需要 macFUSE、不需要系统扩展 —— 所以「在电脑上直接翻手机目录」这件事
// 可以完全留在 Electron 里做。一个服务进程按 token 挂多台/多卷，token 是随机串：
// 端口只监听 127.0.0.1，但本机其它进程同样能连，没 token 就摸不到别人的挂载点。
//
// 写：PUT/MKCOL/DELETE/MOVE/COPY 直接落到设备；`/`（根目录卷）在 Android 上是只读文件系统，
// 所以按挂载点各自决定 `readOnly`，不是一个全局开关。
// ---------------------------------------------------------------------------

const READ_ONLY_METHODS = "OPTIONS, PROPFIND, GET, HEAD";
const WRITABLE_METHODS = "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK";
const MUTATORS = new Set(["PUT", "MKCOL", "DELETE", "MOVE", "COPY", "LOCK"]);

const CONTENT_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  xml: "application/xml",
  apk: "application/vnd.android.package-archive",
  zip: "application/zip",
};

export function contentTypeFor(name) {
  const ext = String(name).split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** XML 文本转义（文件名里出现 `&` `<` 是常态）。 */
export function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

/** 设备相对路径 → DAV:href（每段单独百分号编码；集合带尾斜杠）。 */
export function hrefFor(prefix, relPath, dir) {
  const segments = String(relPath ?? "").split("/").filter(Boolean).map(encodeURIComponent);
  const base = `/${prefix}${segments.join("/")}`;
  return dir && !base.endsWith("/") ? `${base}/` : base;
}

/**
 * 锁状态是**记账不是强制**：这台挂载点只有我们自己在写，所以 LOCK 只要给出一个合法
 * 的 opaque token、UNLOCK 认这个 token 就够了。真去拦并发写反而会把访达自己的
 * 「先锁再写」流程堵死。
 */
export function createLockStore() {
  const locks = new Map();
  return {
    lock(devicePath, owner) {
      const token = `urn:uuid:${randomUUID()}`;
      locks.set(token, { devicePath, owner });
      return token;
    },
    unlock(token) {
      return locks.delete(token);
    },
    of(devicePath) {
      for (const [token, lock] of locks) if (lock.devicePath === devicePath) return token;
      return null;
    },
  };
}

function propXml(entry, prefix, relPath, writable) {
  const href = hrefFor(prefix, relPath, entry.dir);
  const modified = entry.mtimeMs ? new Date(entry.mtimeMs).toUTCString() : new Date(0).toUTCString();
  const lockSupport = writable
    ? `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`
    : `<D:supportedlock><D:locknull/></D:supportedlock>`;
  return (
    `<D:response><D:href>${href}</D:href><D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(entry.name)}</D:displayname>` +
    `<D:resourcetype>${entry.dir ? "<D:collection/>" : ""}</D:resourcetype>` +
    `<D:getcontentlength>${entry.dir ? 0 : entry.size}</D:getcontentlength>` +
    `<D:getlastmodified>${modified}</D:getlastmodified>` +
    `<D:creationdate>${modified.replace("GMT", "+00:00").replace(/^(\w{3}, )/, "$1")}</D:creationdate>` +
    `<D:getetag>"${entry.size.toString(16)}-${(entry.mtimeMs || 0).toString(16)}"</D:getetag>` +
    lockSupport +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

/**
 * PROPFIND 响应体。`self` 是被请求的资源，`children` 是 Depth:1 时的一层子项。
 * `displayName` 只作用在挂载根那一条上：设备侧的目录名是 `0` / `DCIM` 这种，
 * 直接当卷标题既看不懂也不该露出来。
 * @param {{ prefix: string, self: object, children: object[] | null, displayName?: string }} input
 */
export function buildPropfindXml({ prefix, self, children, displayName, writable = true }) {
  const relOf = (entry) => {
    // self/children 里带的是设备绝对路径；href 只需要挂载根之下的相对部分。
    const root = entry.__root ?? "";
    return root && entry.path.startsWith(root) ? entry.path.slice(root.length).replace(/^\//, "") : entry.path;
  };
  const selfRel = relOf(self);
  const selfEntry = selfRel === "" && displayName ? { ...self, name: displayName } : self;
  const parts = [propXml(selfEntry, prefix, selfRel, writable)];
  for (const child of children ?? []) parts.push(propXml(child, prefix, relOf(child), writable));
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:S="http://apache.org/haveged/">${parts.join("")}</D:multistatus>`;
}

/** `bytes=100-199` / `bytes=100-` / `bytes=-50`（后缀只取"从哪开始"，Finder 主要用前两种）。 */
export function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function sendXml(res, status, body, writable = true) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "application/xml; charset=utf-8",
    "content-length": payload.length,
    dav: writable ? "2" : "1",
    "ms-author-via": "DAV",
    allow: writable ? WRITABLE_METHODS : READ_ONLY_METHODS,
  });
  res.end(payload);
}

/**
 * 起一个只监听 127.0.0.1 的 WebDAV 服务。
 * @param {{ resolveToken: (token: string) => { serial: string, root: string } | null }} router
 */
export function createDeviceDavServer(router) {
  const server = http.createServer((req, res) => {
    handle(req, res, router).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`AndDrive WebDAV: ${error?.message || error}`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** macOS 自己往卷根/目录里撒的元数据文件，不该出现在手机上。 */
export function isMacMetadataName(name) {
  if (!name) return false;
  return (
    name === ".DS_Store" ||
    name === ".Trashes" ||
    name === ".fseventsd" ||
    name === ".Spotlight-V100" ||
    // 挂载点建好时实测各问一次，全是 macOS 自己的哨兵文件（手机上不会有）
    name === ".hidden" ||
    name.startsWith(".metadata_") ||
    name.startsWith(".ql_") ||
    name.startsWith("._") ||
    name.startsWith(".AppleDouble") ||
    name.startsWith(".com.apple.")
  );
}

/** Destination 头 → 同一挂载点内的目标相对路径；跨挂载/越界一律 null。 */
export function resolveDestination(header, token, root) {
  if (typeof header !== "string") return null;
  let target;
  try {
    target = new URL(header);
  } catch {
    // 有些客户端只给路径。
    target = new URL(header, "http://127.0.0.1");
  }
  const [targetToken = "", ...rest] = target.pathname.split("/").filter(Boolean);
  if (targetToken !== token) return null;
  return resolveDevicePath(root, `/${rest.join("/")}`);
}

/** 一个进程内共享：挂载点只有我们自己在写，锁不需要跨服务实例。 */
const lockStore = createLockStore();

function fail(res, status, message, allowed) {
  res.writeHead(status, {
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(message),
    ...(allowed ? { allow: allowed } : {}),
  });
  res.end(message);
}

function done(res, status, adapter) {
  // `dav` / `ms-author-via` 必须每个响应都带：`mount_webdav` 看的是 OPTIONS 上的 DAV 头，
  // 少一次就当这不是 WebDAV 服务器，直接挂不上且不报错。
  // class 2（支持 LOCK）是**可写的先决条件**：man mount_webdav 写明连到 Class 1 服务器时
  // 即使没要求也会强制 rdonly。
  const writable = !adapter?.readOnly;
  res.writeHead(status, {
    allow: writable ? WRITABLE_METHODS : READ_ONLY_METHODS,
    dav: writable ? "2" : "1",
    "ms-author-via": "DAV",
    "content-length": "0",
  });
  res.end();
}

/** 设备侧报错文案映射成 HTTP 状态：找不到 ≠ 服务器坏了。 */
function statusForError(error) {
  const text = String(error?.message || error);
  if (/no such file|does not exist|not found/i.test(text)) return 404;
  if (/read-only file system/i.test(text)) return 403;
  if (/denied|permission/i.test(text)) return 403;
  if (/exists/i.test(text)) return 405;
  return 500;
}

async function handle(req, res, router) {
  if (process.env.ANDDRIVE_DAV_TRACE) console.error("[req]", req.method, req.headers.range || "-");
  // `OPTIONS *` 是能力探测，不带挂载前缀：不能按未知 token 处理成 404。
  if (!req.url || req.url === "*" || req.url === "/") {
    res.writeHead(200, {
      allow: WRITABLE_METHODS,
      dav: "2",
      "ms-author-via": "DAV",
      "content-length": "0",
    });
    res.end();
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  const [token = "", ...rest] = url.pathname.split("/").filter(Boolean);
  const adapter = router(token);
  const allowed = adapter?.readOnly ? READ_ONLY_METHODS : WRITABLE_METHODS;
  if (!adapter) {
    fail(res, 404, "not mounted");
    return;
  }
  const relPath = rest.join("/");
  const devicePath = resolveDevicePath(adapter.root, `/${relPath}`);
  if (!devicePath) {
    fail(res, 403, "forbidden", allowed);
    return;
  }

  if (req.method === "OPTIONS") {
    done(res, 200, adapter);
    return;
  }

  // 访达对目录里**每个条目**都会问一次 `._xxx`，还会问 `.DS_Store`。这些东西我们从不真写到
  // 手机上（上面 MUTATORS 里吞掉了），所以也绝不该拿它去问设备：690 项的相机夹一次打开
  // 就是 690 次 sync.stat 往返，全是要不到的。直接 404，答案一模一样。
  if (!MUTATORS.has(req.method) && isMacMetadataName(relPath.split("/").pop())) {
    fail(res, 404, "not found", allowed);
    return;
  }

  if (MUTATORS.has(req.method)) {
    if (adapter.readOnly) {
      req.resume();
      fail(res, 403, "read-only mount", allowed);
      return;
    }
    const name = relPath.split("/").pop();
    if (isMacMetadataName(name)) {
      // 访达自己造的 .DS_Store / ._xxx 不落手机：吞掉请求体后回成功。
      req.resume();
      done(res, req.method === "DELETE" ? 204 : 201, adapter);
      return;
    }
  }

  try {
    if (req.method === "PROPFIND") {
      const entry = await adapter.stat(devicePath);
      if (!entry) {
        fail(res, 404, "not found", allowed);
        return;
      }
      const wantsChildren = (req.headers.depth ?? "infinity") !== "0" && entry.dir;
      const children = wantsChildren ? await adapter.list(devicePath) : null;
      sendXml(
        res,
        207,
        buildPropfindXml({
          prefix: `${token}/`,
          self: tag(entry, adapter.root),
          children: children?.map((item) => tag(item, adapter.root)) ?? null,
          displayName: adapter.displayName,
          writable: !adapter.readOnly,
        }),
        !adapter.readOnly,
      );
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await sendFile(req, res, adapter, devicePath, allowed);
      return;
    }

    if (req.method === "LOCK") {
      // 只读卷不该被锁：上面 MUTATORS 已经拦掉了。
      const href = hrefFor(`${token}/`, relPath, false);
      const lockToken = lockStore.lock(devicePath, "");
      const xml =
        `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
        `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
        `<D:depth>${String(req.headers.depth || "infinity") === "0" ? "0" : "infinity"}</D:depth>` +
        `<D:owner>${xmlEscape(req.headers["user-agent"] || "AndDrive")}</D:owner>` +
        `<D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${lockToken}</D:href></D:locktoken>` +
        `<D:lockroot><D:href>${href}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
      sendXml(res, 200, xml, true);
      return;
    }

    if (req.method === "UNLOCK") {
      // 锁只是记账：token 认得就删，认不得也回 204（UNLOCK 必须幂等，否则访达会卡在删除流程里）。
      lockStore.unlock(url.searchParams.get("Lock-Token"));
      done(res, 204, adapter);
      return;
    }

    if (req.method === "PUT") {
      await adapter.write(devicePath, req);
      done(res, 201, adapter);
      return;
    }

    if (req.method === "MKCOL") {
      await adapter.mkdir(devicePath);
      done(res, 201, adapter);
      return;
    }

    if (req.method === "DELETE") {
      // 挂载点自身不许删：删掉它等于把整个卷清空。
      if (devicePath === adapter.root) {
        fail(res, 403, "cannot delete the mounted root", allowed);
        return;
      }
      await adapter.remove(devicePath);
      done(res, 204, adapter);
      return;
    }

    if (req.method === "MOVE" || req.method === "COPY") {
      const target = resolveDestination(req.headers.destination, token, adapter.root);
      if (!target) {
        fail(res, 400, "bad Destination", allowed);
        return;
      }
      if (target === adapter.root || devicePath === adapter.root) {
        fail(res, 403, "cannot move the mounted root", allowed);
        return;
      }
      if (String(req.headers.overwrite || "").toUpperCase() === "F" && (await adapter.stat(target))) {
        req.resume();
        fail(res, 412, "target exists", allowed);
        return;
      }
      if (req.method === "MOVE") await adapter.move(devicePath, target);
      else await adapter.copy(devicePath, target);
      done(res, 201, adapter);
      return;
    }
  } catch (error) {
    req.resume();
    fail(res, statusForError(error), String(error?.message || error).slice(0, 200), allowed);
    return;
  }

  req.resume();
  fail(res, 405, "method not allowed", allowed);
}

async function sendFile(req, res, adapter, devicePath, allowed) {
  const entry = await adapter.stat(devicePath);
  if (!entry || entry.dir) {
    fail(res, 404, "not found", allowed);
    return;
  }
  const range = parseRange(req.headers.range, entry.size);
  const start = range?.start ?? 0;
  const length = range ? range.end - range.start + 1 : entry.size;
  const headers = {
    "content-type": contentTypeFor(entry.name),
    "content-length": length,
    "accept-ranges": "bytes",
    etag: `"${entry.size.toString(16)}-${(entry.mtimeMs || 0).toString(16)}"`,
    dav: "1",
    "ms-author-via": "DAV",
  };
  if (entry.mtimeMs) headers["last-modified"] = new Date(entry.mtimeMs).toUTCString();
  if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${entry.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  // 把长度交给设备侧去截（dd count_bytes）；只有它不认长度时我们才自己掐。
  const file = await adapter.open(devicePath, start, length);
  if (range && !file.truncated) {
    let sent = 0;
    file.stream.on("data", (chunk) => {
      sent += chunk.length;
      if (sent > length) file.close();
    });
  }
  // 读窗口命中时数据已经在内存里，直接 end(buffer)：走一遍 Stream 反而每次多花 ~100ms。
  if (file.buffer) {
    res.end(file.buffer);
    return;
  }
  // 设备侧的读随时可能失败（本地缓存条目正被 LRU 淘汰、adb 链路断掉都算），
  // 而 `pipe` 不转发源头的 error —— 没人监听就是未捕获异常，整个主进程跟着没了。
  // 这里把响应打断，客户端按"连接中断"重试即可。
  file.stream.on("error", () => res.destroy());
  file.stream.pipe(res);
  res.on("close", file.close);
}

function tag(entry, root) {
  return { ...entry, __root: root };
}
