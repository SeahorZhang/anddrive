import { LARGE_SCREEN_COMPAT } from "../../shared/scrcpyConfig.js";

// ---------------------------------------------------------------------------
// 大屏（pad）模式配方编排
//
// 要解决的问题：锁竖屏的 app（抖音这类）在**横形状**虚拟显示上会被 Android 16 的 size-compat
// 压成居中竖条（帧内左右大黑），而虚拟显示的形状等于镜像窗口形状，窗口一拖宽就中招。
//
// 真机量出来的唯一可行配方（缺一步都不成立）：
//   1. `am compat enable OVERRIDE_ANY_ORIENTATION_TO_USER <pkg>` —— 让系统不再听 app 的方向锁。
//      **这条只在物理屏生效**，直接打在 scrcpy 虚拟显示上无效（四种启动顺序都试过）。
//   2. `wm size/density` 把**物理屏**临时改成横形大屏（sw 远超 600dp）。
//   3. 重启 app —— compat 是进程启动时读的，热着的进程不会重读。
//   4. 轮询到 app 在物理屏上已经 `mBounds == mMaxBounds` 且横向，说明它自己进了 pad。
//   5. 建宽虚拟显示 + `startApp` 把它搬过去：pad 状态跟着过去，`mBounds == mMaxBounds`。
//   6. 搬完再把物理屏 `wm size reset` 还原 —— 实测还原后虚拟显示上的 pad 不掉，
//      后续 `resizeDisplay` 跟随窗口也仍然铺满。
//
// 所以本模块的 `enter` 只做到第 4 步（物理屏**先不还原**，避免 app 在搬走之前掉回竖屏），
// 渲染层把会话建好、app 搬走后调 `settle` 还原物理屏；`settle` 另有超时兜底，
// 万一渲染层中途挂了，手机屏幕也不会一直停在横形大屏。
// ---------------------------------------------------------------------------

/** 临时把物理屏改成的横形大屏：sw = 1080/160×160 = 1080dp，远超 600dp 门槛。 */
export const PAD_PROBE_DISPLAY = Object.freeze({ width: 1920, height: 1080, dpi: 160 });
/** 轮询 app 是否已在物理屏上以 pad 铺满。 */
export const PAD_PROBE_INTERVAL_MS = 600;
export const PAD_PROBE_TIMEOUT_MS = 12000;
/** 渲染层忘了 settle 时的兜底还原（它要在 startApp 搬走 app 之后才 settle）。 */
export const PAD_SETTLE_TIMEOUT_MS = 30000;

/**
 * @param {{
 *   setCompat: (serial: string, packageName: string, enabled: boolean) => Promise<{ ok: boolean, message?: string }>,
 *   overrideGeometry: (serial: string, box: { width: number, height: number, dpi: number }) => Promise<unknown>,
 *   resetGeometry: (serial: string) => Promise<unknown>,
 *   forceStop: (serial: string, packageName: string) => Promise<unknown>,
 *   launch: (serial: string, packageName: string) => Promise<unknown>,
 *   geometry: (serial: string, packageName: string) => Promise<{ full: boolean, landscape: boolean }>,
 *   sleep?: (ms: number) => Promise<void>,
 *   setTimer?: (callback: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   log?: (message: string) => void,
 *   probeIntervalMs?: number,
 *   probeTimeoutMs?: number,
 *   settleTimeoutMs?: number,
 * }} deps 全部依赖注入，本模块不碰 Electron 与 adb，便于单测。
 */
export function createPadMode(deps) {
  const {
    setCompat,
    overrideGeometry,
    resetGeometry,
    forceStop,
    launch,
    geometry,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle),
    log = (message) => console.warn(message),
    probeIntervalMs = PAD_PROBE_INTERVAL_MS,
    probeTimeoutMs = PAD_PROBE_TIMEOUT_MS,
    settleTimeoutMs = PAD_SETTLE_TIMEOUT_MS,
  } = deps;

  /** @type {Map<string, number>} `serial|pkg` → 还在用大屏模式的会话数 */
  const refs = new Map();
  /** @type {Map<string, { timer: unknown, settled: boolean }>} 等待 settle 的物理屏覆盖 */
  const pending = new Map();
  const key = (serial, packageName) => `${serial}|${packageName}`;

  async function armSettle(serial, timeoutMs) {
    if (pending.has(serial)) return;
    const timer = setTimer(() => settle(serial), timeoutMs);
    pending.set(serial, { timer, settled: false });
  }

  /**
   * 还原物理屏（幂等）。渲染层在 app 已被搬到虚拟显示之后调用。
   * @param {string} serial
   */
  function settle(serial) {
    const entry = pending.get(serial);
    if (!entry) return;
    pending.delete(serial);
    clearTimer(entry.timer);
    void resetGeometry(serial).catch(() => {});
  }

  /**
   * 进入大屏模式：跑到「app 已在物理屏上以 pad 铺满」为止，物理屏保持临时覆盖等 settle。
   * @param {string} serial
   * @param {string} packageName
   * @returns {Promise<boolean>} 是否成功（失败时设备状态已全部还原）
   */
  async function enter(serial, packageName) {
    const id = key(serial, packageName);
    if ((refs.get(id) ?? 0) > 0) {
      refs.set(id, refs.get(id) + 1);
      return true;
    }
    const compat = await setCompat(serial, packageName, true).catch((error) => ({
      ok: false,
      message: error?.message || String(error),
    }));
    if (!compat.ok) {
      log(`[mirror] 大屏模式不可用（${compat.message ?? "设备不支持"}），保持手机布局`);
      return false;
    }
    try {
      await overrideGeometry(serial, PAD_PROBE_DISPLAY);
      // compat 是进程启动时读的：进程活着就必须先停一次。
      await forceStop(serial, packageName).catch(() => {});
      await launch(serial, packageName);
      // 按次数轮询（而不是墙钟截止点）：单测里 sleep 是瞬时的，用 Date.now() 会空转上万次。
      const attempts = Math.max(1, Math.round(probeTimeoutMs / probeIntervalMs));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await sleep(probeIntervalMs);
        const state = await geometry(serial, packageName).catch(() => null);
        if (state?.full && state?.landscape) {
          refs.set(id, 1);
          await armSettle(serial, settleTimeoutMs);
          return true;
        }
      }
      log("[mirror] 等 app 进 pad 超时，还原设备状态并按手机布局继续");
    } catch (error) {
      log(`[mirror] 大屏模式准备失败（${error?.message || error}），按手机布局继续`);
    }
    await rollback(serial, packageName);
    return false;
  }

  /**
   * 退出大屏模式：引用计数归零才还原 compat；物理屏覆盖一并 settle。
   * @param {string} serial
   * @param {string} packageName
   */
  async function exit(serial, packageName) {
    settle(serial);
    const id = key(serial, packageName);
    if (!refs.has(id)) return;
    const count = refs.get(id) - 1;
    if (count > 0) {
      refs.set(id, count);
      return;
    }
    refs.delete(id);
    await setCompat(serial, packageName, false).catch(() => {});
  }

  async function rollback(serial, packageName) {
    refs.delete(key(serial, packageName));
    const entry = pending.get(serial);
    if (entry) {
      clearTimer(entry.timer);
      pending.delete(serial);
    }
    // 物理屏覆盖可能是刚打上还没 settle 的，失败路径必须自己擦干净。
    await resetGeometry(serial).catch(() => {});
    await setCompat(serial, packageName, false).catch(() => {});
  }

  return { enter, exit, settle, tracked: () => refs.size, pendingSettle: () => pending.size };
}

/** 供日志/文档引用：这条 change 的名字与 id（真机排查时直接敲）。 */
export const PAD_COMPAT_CHANGE = LARGE_SCREEN_COMPAT;
