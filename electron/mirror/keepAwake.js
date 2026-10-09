// 镜像会话期间让设备别自己睡（keepAwake）。**只在 Android 13 及以下**（判据 `mirrorsMainDisplay(sdk)`，
// 所以那台设备上的整机镜像与点应用都算）。
//
// 为什么是这一档：它采的是手机那块屏，面板一灭服务端就不再产生新帧，窗口里定住的是最后一帧。
// HyperOS 有 `synergy_mode` → `Hangup` 那扇门（灭屏仍继续合成，见 `miProjection.js`），
// AOSP 与 Android 13 及以下没有 —— 用户 2026-10-09 的原话：「低版本安卓不会进入 hangup，
// 所以需要用 keepawake 的能力」，参照物是竞品（其 helper 的权限文案
// `android_permission.wake_lock` = 「保持设备唤醒」）。14+ 那档不开：它的保活另有那条门，
// 而「插电不息屏」是用户自己的电源偏好，不在需求里就不碰。
//
// 用的是平台自带那一格：`Settings.Global.stay_on_while_plugged_in`（`svc power stayon` 写的就是它），
// 不新写常驻服务、不占 `INJECT_EVENTS`。真机量过（Mi 10 / Android 13）：写 7 → `mStayOn=true`，
// 15s 息屏超时到点后 50s 仍 `mWakefulness=Awake`；只写 USB 位不生效（那台机报的是 AC powered）。
//
// **这是用户设备上的设置，不是我们可以顺手留下的东西**：开之前先读原值，最后一个会话关掉时原样写回。
// 同一台设备多个会话（13 及以下点过几个 app 就是几个窗口）共用一次改写，按引用计数还原 ——
// 关掉其中一个窗口不该把另一台还开着的镜像的保活撤掉。

/** 键名只在这里出现一次，adb 层的通用读写按它取值。 */
export const KEY_STAY_ON = "stay_on_while_plugged_in";

/** 插电保活的三个位一起：AC | USB | 无线。只写 USB 位在真机上不生效（设备报 AC）。 */
export const STAY_ON_ALL = 7;

/**
 * 每台设备一份。`ready` 是「读原值 + 写 7」这条链，`enabled` 只有在它成功落地后才为真。
 * @type {Map<string, {
 *   count: number,
 *   original: number,
 *   enabled: boolean,
 *   settled: Promise<boolean>,
 * }>}
 */
const holders = new Map();

/**
 * 声明「这台设备正在被镜像，插电时别息屏」。
 * @param {{ serial: string,
 *           read: (key: string) => Promise<number | null>,
 *           write: (key: string, mask: number) => Promise<boolean> }} deps
 *   两个函数都要已绑好这台设备；`read` 回 null = 读不到。
 * @returns {Promise<() => Promise<void>>} 还原函数（幂等；没开成时是空操作）
 */
export async function startKeepAwake({ serial, read, write }) {
  let state = holders.get(serial);
  if (state) {
    // 第二个会话不重新读、也不重复写：它只是又登记了一次「有人在用」。
    state.count += 1;
  } else {
    state = { count: 1, original: 0, enabled: false, settled: null };
    holders.set(serial, state);
    // 登记必须是同步的一步做完，否则两个会话同时进来会各读各的原始值、各写各的 7。
    state.settled = settle(state, read, write);
  }
  await state.settled;
  return restoreFor(serial, write);
}

/** 读原值 → 写 7。任一步不成就不动这台设备的设置。 */
async function settle(state, read, write) {
  // 读不到原值 = 没法原样还回去，那就不开（宁可这次不保活，也不把用户的设置留在我们手里）。
  const original = await read(KEY_STAY_ON).catch(() => null);
  if (!Number.isInteger(original)) return false;
  state.original = original;
  if (!(await write(KEY_STAY_ON, STAY_ON_ALL).catch(() => false))) return false;
  state.enabled = true;
  return true;
}

function restoreFor(serial, write) {
  let done = false;
  return async function restore() {
    if (done) return;
    done = true;
    const state = holders.get(serial);
    if (!state) return;
    state.count -= 1;
    if (state.count > 0) return;
    holders.delete(serial);
    // 走到这里置位早就落地了：还原函数是 `startKeepAwake` **await 过读写之后**才交出去的，
    // 所以不存在「还原跑在置位前面」把设备留在 7 的顺序问题（那是 `miProjection` 那边要操心的）。
    if (!state.enabled) return;
    // 失败不抛：会话都要结束了，不能因为一次 adb 失败把关窗流程卡住。
    // 下一次开会话会重新读当前值，最多是那台设备多亮一会儿。
    await write(KEY_STAY_ON, state.original).catch(() => {});
  };
}
