// 让 HyperOS 在息屏后继续把新帧合成进我们的采集显示。
//
// 画面「定住」的真机制（2026-09-29 拆 `miui-services.jar` + MirrorOS4.apk 得到）：
// 普通息屏时 PowerManagerService 给 SurfaceFlinger 发 GOING_TO_SLEEP，SF 就此不再驱动非交互
// 显示 —— 虚拟显示停止合成，客户端一切计数都还健康，画面却是静止的。小米互联服务不受影响，
// 因为它在会话建立时调 `MirrorManager.beginSynergy()`，而那只是个客户端方法：往
// `Settings.Secure` 写 `synergy_mode=1`。设备到 bedtime 时 `updateWakefulnessLocked` 看见
// `shouldEnterHangUpLocked()` 为真（projection 或 synergy 开着）就不走 sleep/doze，改走
// `hangUpNoUpdateLocked(true)`：wakefulness 进 `Hangup`，并给 SF 发
// DISPLAY_START_GOING_TO_HANGUP —— 面板灭着、合成照跑。
//
// 所以这扇门是「电源策略认不认这次会话是投屏」，不是 wakelock（当年那七条 wakelock 路全灭
// 是必然的），也不是权限：`WRITE_SECURE_SETTINGS` adb shell 本来就持有。官方 app 只在会话
// 生命周期的两端碰这个键，不轮询、不心跳。
//
// 置位要赶在设备睡之前：进 Hangup 的判定发生在 bedtime，睡着后再补没人接。
// 之前那版写 `screen_project_in_screening` + 睡下后补 `screen_project_hang_up_on` 也能进
// Hangup，但那是 WFD 投屏子系统的键和系统内部动作，不是互联的姿势。

/** 互联 `beginSynergy()` 写的那个键。 */
export const KEY_SYNERGY = "synergy_mode";

/**
 * 声明「本机正在协同投屏」，返回还原函数（关会话时调用）。
 * @param {{ serial: string, put: (serial: string, key: string, value: 0 | 1) => Promise<unknown> }} deps
 */
export function startMiProjection({ serial, put }) {
  let closed = false;
  const begin = put(serial, KEY_SYNERGY, 1);

  return async function restore() {
    if (closed) return;
    closed = true;
    // 清除要等置位落地，否则两次 adb 调用换了顺序，设备最终留在 1。
    await begin.catch(() => {});
    await put(serial, KEY_SYNERGY, 0);
  };

}
