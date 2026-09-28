import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({
  app: {
    getPath: () => state.userData,
  },
  ipcMain: { handle: vi.fn() },
}));

const {
  readAppCache,
  mutateAppCache,
  deleteAppCache,
  getCachedApps,
  writeIconFiles,
  readIconFiles,
  CACHE_MAX_AGE_MS,
  CACHE_VERSION,
} = await import("../../electron/adb.js");

/**
 * 图标拆到文件后，快照唯一的写入口是 `mutateAppCache`（`writeAppCache` 已随之删除）。
 * 这几条测试因此改为走生产写路径 —— 覆盖比原来更强：连的是同一把串行锁。
 */
const writeSnapshotInto = (value) => mutateAppCache(serial, () => value);

const serial = "192.168.1.20:5555";
const cacheFile = () =>
  path.join(
    state.userData,
    "app-cache",
    "apps-v1",
    `${createHash("sha256").update(serial).digest("hex")}.json`,
  );
const snapshot = () => ({
  authoritativeAt: Date.now() - 1000,
  writtenAt: Date.now(),
  apps: [
    {
      packageName: "com.example.app",
      label: "Example",
      iconUrl: null,
      iconUpdatedAt: null,
    },
  ],
});

beforeEach(async () => {
  state.userData = await fs.mkdtemp(path.join(os.tmpdir(), "anddrive-cache-test-"));
});

afterEach(async () => {
  await fs.rm(state.userData, { recursive: true, force: true });
});

describe("app cache persistence", () => {
  it("round trips a versionless domain snapshot", async () => {
    await writeSnapshotInto(snapshot());
    expect(await readAppCache(serial)).toMatchObject({ version: CACHE_VERSION });
  });

  it.each([
    ["corrupt", "{not-json"],
    [
      "expired",
      JSON.stringify({
        version: CACHE_VERSION,
        authoritativeAt: 1,
        writtenAt: Date.now() - CACHE_MAX_AGE_MS - 1,
        apps: [],
      }),
    ],
    [
      "wrong version",
      JSON.stringify({
        version: CACHE_VERSION - 1,
        authoritativeAt: Date.now(),
        writtenAt: Date.now(),
        apps: [],
      }),
    ],
  ])("removes %s cache data safely", async (_name, contents) => {
    await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
    await fs.writeFile(cacheFile(), contents);

    expect(await readAppCache(serial)).toBeNull();
    await expect(fs.access(cacheFile())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a fresh temp file that belongs to an in-flight write", async () => {
    const tmpFile = `${cacheFile()}.999.deadbeef.tmp`;
    await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
    await fs.writeFile(tmpFile, "in-flight");

    await writeSnapshotInto(snapshot());

    await expect(fs.access(tmpFile)).resolves.toBeUndefined();
  });

  it("resolves concurrent writes for the same device without dropping either", async () => {
    const results = await Promise.all([
      writeSnapshotInto(snapshot()),
      writeSnapshotInto(snapshot()),
    ]);

    expect(results).toHaveLength(2);
    expect((await readAppCache(serial)).apps).toHaveLength(1);
  });

  // 旧 D4：图标是按批发来的，每批「读整份 → 并进内存 → 写回整份」。
  // 不串行时后完成的那批拿着自己那次读到的旧快照，会把先完成那批整块盖掉。
  it("keeps every concurrent read-modify-write batch for one device", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const packages = ["com.a", "com.b", "com.c", "com.d"];

    const batches = packages.map((packageName) =>
      mutateAppCache(serial, async (current) => {
        // 四个批次全部在完成写盘之前拿到锁外的读，正是旧 bug 的形状。
        await gate;
        const apps = [...(current?.apps ?? [])];
        if (!apps.some((app) => app.packageName === packageName)) {
          apps.push({ packageName, label: packageName, iconUrl: null, iconUpdatedAt: null });
        }
        return { authoritativeAt: Date.now(), writtenAt: Date.now(), apps };
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all(batches);

    const saved = await readAppCache(serial);
    expect(saved.apps.map((app) => app.packageName).sort()).toEqual(packages);
  });

  // 「清除缓存」必须等正在收尾的写入落完再删：否则删除先跑完、写入的 rename 后落地，
  // 用户看到的就是「清了，列表又自己回来了」。
  it("waits for an in-flight write before clearing the cache", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const writing = mutateAppCache(serial, async () => {
      await gate;
      return snapshot();
    });

    await new Promise((resolve) => setImmediate(resolve));
    const clearing = deleteAppCache(serial);
    release();
    await Promise.all([writing, clearing]);

    expect(await readAppCache(serial)).toBeNull();
  });
});

describe("icon files (O6)", () => {
  const png = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  const iconPath = (packageName) =>
    path.join(
      state.userData,
      "app-cache",
      "icons-v1",
      `${createHash("sha256").update(serial).digest("hex")}`,
      `${createHash("sha256").update(packageName).digest("hex")}.png`,
    );

  it("round trips icons through per-package files", async () => {
    const written = await writeIconFiles(serial, [
      { packageName: "com.a", dataUrl: png([1, 2, 3]) },
      { packageName: "com.b", dataUrl: png([9]) },
    ]);

    expect(written.sort()).toEqual(["com.a", "com.b"]);
    // 快照里不该再有图标本体（O6 的目的：整份 JSON 不再随批次膨胀）
    expect(await fs.readFile(iconPath("com.a"))).toEqual(Buffer.from([1, 2, 3]));

    const read = await readIconFiles(serial, ["com.a", "com.b", "com.missing"]);
    expect(Object.keys(read).sort()).toEqual(["com.a", "com.b"]);
    expect(read["com.a"].dataUrl).toBe(png([1, 2, 3]));
    expect(read["com.a"].updatedAt).toBeGreaterThan(0);
  });

  it("drops entries whose icon is not a PNG data URL without failing the batch", async () => {
    const written = await writeIconFiles(serial, [
      { packageName: "com.ok", dataUrl: png([1]) },
      { packageName: "com.bad", dataUrl: "data:text/plain;base64,QQ==" },
      { packageName: "com.null", dataUrl: null },
    ]);

    expect(written).toEqual(["com.ok"]);
  });

  it("does not serve icons older than the refresh window", async () => {
    await writeIconFiles(serial, [{ packageName: "com.a", dataUrl: png([1]) }]);
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(iconPath("com.a"), stale, stale);

    expect(await readIconFiles(serial, ["com.a"])).toEqual({});
  });

  it("clears icon files together with the snapshot", async () => {
    await writeSnapshotInto(snapshot());
    await writeIconFiles(serial, [{ packageName: "com.a", dataUrl: png([1]) }]);

    expect(await deleteAppCache(serial)).toBe(true);

    // 只删 JSON 不删图标的话，「清除缓存」后旧图标会被立刻原样端回来
    expect(await readIconFiles(serial, ["com.a"])).toEqual({});
    await expect(fs.stat(iconPath("com.a"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("survives a missing icon directory", async () => {
    expect(await readIconFiles("never-seen-device", ["com.a"])).toEqual({});
  });

  // O6 的验收面：冷启动仍然"秒出图标"，而且**不去问设备**。
  it("serves cached apps with icons hydrated from disk", async () => {
    await writeSnapshotInto({
      authoritativeAt: Date.now(),
      writtenAt: Date.now(),
      apps: [{ packageName: "com.a", label: "A" }],
    });
    expect((await getCachedApps(serial))[0].iconUrl).toBeNull();

    await writeIconFiles(serial, [{ packageName: "com.a", dataUrl: png([7, 7]) }]);

    const hydrated = await getCachedApps(serial);
    expect(hydrated[0]).toMatchObject({ packageName: "com.a", label: "A", iconUrl: png([7, 7]) });
    expect(typeof hydrated[0].iconUpdatedAt).toBe("number");
  });
});
