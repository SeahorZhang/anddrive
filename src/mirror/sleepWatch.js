/**
 * 睡了、而且**不再产生新帧**的电源状态。
 * `Hangup` 不在里面 —— 那是 HyperOS/MIUI 投屏登记过的灭屏态（面板灭着仍继续合成，见
 * `electron/mirror/miProjection.js`），报「已休眠」就是谎报。
 */
export const FROZEN_STATES = new Set(["Asleep", "Dozing"]);

/**
 * **面板确定灭着**的 wakefulness 态 = 冻结态 + `Hangup`。
 *
 * 为什么 `Hangup` 必须单独列进来：它是 HyperOS/MIUI 投屏态的灭屏，**面板物理灭着，但
 * SurfaceFlinger 照旧报 `powerMode=On`**（合成还在跑，那正是 `synergy_mode` 这扇门的目的）。
 * 真机实测（Mi 10 / HyperOS V816）走**超时灭屏**（bedtime → `updateWakefulnessLocked`）后：
 * `mWakefulness=Hangup` + `powerMode=On` 稳定保持。于是只按 `powerMode` 判屏灭就会把它当成亮屏 ——
 * 长条那颗按钮永远翻不到「恢复亮屏」（用户 10-11 报：「手机已经是关闭屏幕，打开镜像后
 * 悬浮栏上的关闭屏幕按钮并没有打开」）。
 *
 * ⚠️ 它**不能**并进 `FROZEN_STATES`：那一个管的是「要不要弹『已休眠』」，而 `Hangup` 画面还在动。
 * 两个集合的语义不同，别合并。
 */
export const PANEL_OFF_STATES = new Set([...FROZEN_STATES, "Hangup"]);

/**
 * 屏灭着 = 面板读数不是 `'ON'`（`OFF` / `DOZE`…，见 `electron/adb.js` 的 `parsePanelPower`），
 * 或设备在**面板确定灭着**的态里（睡下 / `Hangup`）。
 * 面板读数拿不到（ROM 的 SF 不 dump `powerMode`）时退回后一条，至少不会比只看 `mWakefulness` 更差。
 * ⚠️ 这条判据是长条那颗「关屏使用 / 恢复亮屏」的唯一依据：`setDisplayPower(OFF)` 只关面板、
 * 设备还 `Awake`，只看 `wakefulness` 那颗按钮就翻不回来，再点一次还是关屏（用户 10-10）。
 * @param {{ wakefulness: string | null, screen: string | null }} state
 */
export function panelIsOff(state) {
  const off = PANEL_OFF_STATES.has(state.wakefulness);
  return state.screen ? state.screen !== "ON" || off : off;
}

/**
 * 屏灭着时，要把它弄亮该走哪条路：`true` = **真唤醒**（`input keyevent 224`，即横幅「继续使用」那条），
 * `false` = `setDisplayPower(Normal)`（scrcpy 控制消息，回系统默认）。
 *
 * 判据只有 `mWakefulness` 一条，因为这两条路的能力边界正好按它分：
 * - 设备**不是** `Awake`（`Asleep` / `Dozing` / `Hangup`）：屏是**电源管理**灭的。
 *   `setDisplayPower` 只改 SurfaceFlinger、**唤不动**它 —— 真机实测（Mi 10 / HyperOS V816）：
 *   `Hangup` 下发 `Normal` 之后 8 秒仍是 `Hangup`（按钮会亮着却点不动，就是「再点一次点不亮」那个洞）。
 * - 设备 `Awake`：屏是我们自己用 `setDisplayPower(OFF)` 关的，回 `Normal` 就对（这条路不占 `INJECT_EVENTS`，
 *   比真唤醒稳，别改）。
 * @param {{ wakefulness: string | null }} state
 */
export function needsRealWake(state) {
  return state?.wakefulness !== "Awake";
}

/**
 * 盯住设备的两条电源读数（`mWakefulness` + SF 的 `powerMode`），给镜像窗口的「已休眠」横幅和长条上那颗「关屏使用」图标用。
 *
 * 两条时间线（用户 10-10：「已休眠、点击按钮继续使用这个不灵敏」—— 原来只有 2.5s 一拍的慢轮询，
 * 点了按钮也得等下一拍才撤）：
 * - 平时 `intervalMs` 慢轮询：每一拍都是一次 adb 调用，不能开太凶；
 * - `kick()` 之后转 `fastMs` 快轮询，持续 `fastWindowMs`，用于「刚点了继续使用 / 刚按过关屏 /
 *   刚把长条唤出来」这些状态预期要变的时刻；窗口期到自己回慢轮询。
 *
 * 回调 `onChange(asleep, state)`：第一次读就报，之后读数（睡/醒 或 面板亮/灭）**任一变了**就报，
 * `state = { wakefulness, screen }` 原样带出（页面据此画那颗「关屏使用 / 恢复亮屏」图标）。
 * 为什么两条都要报出去（只看第一个布尔会漏）：
 * - MIUI 按电源键灭屏进的是 `Hangup` —— 它不算休眠（画面还在合成，不能弹「已休眠」），**但屏确实是灭的**；
 * - 长条那颗「关屏使用」走 scrcpy 的 `setDisplayPower`，**只关面板、设备还 `Awake`** —— 只看睡没睡，
 *   那颗按钮翻不回「恢复亮屏」，再点一次还是关屏（用户 10-10）。
 * @param {{
 *   read: () => Promise<{ wakefulness: string | null, screen: string | null } | null>,
 *   onChange: (asleep: boolean, state: { wakefulness: string | null, screen: string | null }) => void,
 *   intervalMs?: number,
 *   fastMs?: number,
 *   fastWindowMs?: number,
 *   shouldSkip?: () => boolean,
 * }} deps `shouldSkip` 用来在窗口不可见时不去打扰设备
 * @returns {{ stop: () => void, kick: () => void }}
 */
export function createSleepWatcher({
  read,
  onChange,
  intervalMs = 1500,
  fastMs = 300,
  fastWindowMs = 5000,
  shouldSkip,
}) {
  /** 上一次报出去的读数指纹；`null` = 还没定基线。 */
  let lastKey = null;
  let stopped = false;
  let fastUntil = 0;
  let timer = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, Date.now() < fastUntil ? fastMs : intervalMs);
  };

  async function tick() {
    if (stopped) return;
    if (!shouldSkip?.()) {
      const state = await read().catch(() => null);
      if (stopped) return;
      // 两个读数都没有就当「不知道」：一次 adb 失败不该谎报休眠、弹出一个点不动的横幅 ——
      // 但**这一拍跳过、下一拍照读**，链子不能因为一次读不到就断掉。
      // **第一次读也要报**：页面初始当设备是醒的，开窗那一刻手机已经睡着的话，
      // 只有这一报才能弹出「已休眠」（上一版把它当基线吞掉，就是同一个洞的另一半）。
      const known = state && (state.wakefulness || state.screen);
      // 两条读数一起比（对象每拍都是新的，只能比内容）。
      const key = known ? `${state.wakefulness}|${state.screen}` : null;
      if (key && key !== lastKey) {
        lastKey = key;
        onChange(FROZEN_STATES.has(state.wakefulness), state);
      }
    }
    schedule();
  }

  // 自排链（不是 `setInterval`）：这样快慢两档能在同一处切换，`kick` 也好插一拍。
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** 立刻读一次，并在接下一段时间里快轮询（预期状态要变时用）。 */
    kick() {
      if (stopped) return;
      fastUntil = Date.now() + fastWindowMs;
      if (timer) clearTimeout(timer);
      timer = null;
      tick();
    },
  };
}
