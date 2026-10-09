/**
 * 睡了、而且**不再产生新帧**的电源状态。
 * `Hangup` 不在里面 —— 那是 HyperOS 投屏登记过的灭屏态（面板灭着仍继续合成，见
 * `electron/mirror/miProjection.js`），报「已休眠」就是谎报。
 */
export const FROZEN_STATES = new Set(["Asleep", "Dozing"]);

/**
 * 盯住「设备睡下去了」，用于镜像窗口的「已休眠」横幅。
 * 只在**醒→睡**那次转变上报一次，回到醒再报一次，中间不重复回调。
 * 为什么不去判「画面定住」：帧停住有三类成因（链路断 / 应用被别的显示收回 / 设备睡了），
 * 从画面判得猜；`mWakefulness` 是设备上的一手读数。
 * @param {{
 *   read: () => Promise<string | null>,
 *   onChange: (asleep: boolean) => void,
 *   intervalMs?: number,
 *   shouldSkip?: () => boolean,
 * }} deps `shouldSkip` 用来在窗口不可见时不去打扰设备
 * @returns {() => void} 停止
 */
export function createSleepWatcher({ read, onChange, intervalMs = 2500, shouldSkip }) {
  let asleep = false;
  let stopped = false;
  const tick = async () => {
    if (stopped || shouldSkip?.()) return;
    const state = await read().catch(() => null);
    if (stopped) return;
    // 读不到当「不知道」：一次 adb 失败不该谎报休眠、弹出一个点不动的横幅。
    if (!state) return;
    const now = FROZEN_STATES.has(state);
    if (now === asleep) return;
    asleep = now;
    onChange(now);
  };
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
