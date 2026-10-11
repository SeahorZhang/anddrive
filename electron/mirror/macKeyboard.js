// Mac 键盘（G1）在桌面这一侧的「输入法归属」管理：把设备的默认输入法切到我们的
// `MirrorInputMethodService`，期间盯着它别被别人抢走，关掉时原样还回去。
//
// 为什么非得是输入法（而不是上游 scrcpy 的文本注入）：`injectText` 送不了非 ASCII（真机两组单变量
// 实测，与设备上装哪个输入法无关），`adb shell input text` 在 MIUI 14 直接 NPE —— 全在
// `docs/NATIVE_MIRROR.md` §G1 切片里记着。
//
// 三条实测换来的设计，别再试：
// 1. **`ime set` 会报 `selected for user #0` 但值根本没变** ⇒ 不信任何命令的返回值，写完一律回读。
// 2. **直写 `settings put secure default_input_method` 才有效**，而且能在竞品同场镜像时守住。
// 3. **对面也在跑夺回循环**（AndroMeld 的设备侧进程持续断言它的输入法）⇒ 两家都无限抢就是乒乓，
//    所以重断言有上限，抢不过就停手并如实告诉用户，等用户再点一次开关。
//
// ⚠️ 这个模块**不 import adb**（只 import node:crypto）：设备读写全部由调用方注入
// （`tests/electron/*` 是按导出枚举 mock `electron/adb.js` 的，新模块沾上它会连带打裂那几份测试）。

import { randomBytes } from "node:crypto";

/** 随包 helper 里那条输入法的组件 id（`helper-app`，Slice 1）。 */
export const MAC_KEYBOARD_IME = "com.anddrive.helper/.MirrorInputMethodService";

/** 要抢的就是这一格 secure 设置。 */
export const SETTING_DEFAULT_IME = "default_input_method";

/**
 * 设备侧留一份「用户原来的输入法」：Mac 进程崩了/被强杀时，下一次开启能从这里捡回来。
 * 竞品的同一条实测是 `/data/local/tmp/anddrive-mirror-ime-state-user-0.json`（JSON，含 `originalInputMethodId`）。
 * 我们只存一行明文就够了，不照抄它的 JSON 形状。
 */
export const STASH_FILE = "/data/local/tmp/anddrive-mac-keyboard-original.txt";

/** 夺回轮询间隔。比竞品的断言节奏慢一档就抢不过，快一档就变成打架；2s 是实测能守住的那档。 */
export const RECONCILE_INTERVAL_MS = 2000;

/** 连续重断言多少次还拿不回来就停手（防乒乓）。 */
export const REASSERT_LIMIT = 3;

/**
 * 输入法 id 的形状。它会被拼进设备 shell 的 `echo` / `cat`，所以字符集必须卡死 ——
 * 值来自设备回读（不是我们自己写的常量），不能当可信输入用。
 * @param {unknown} value
 */
export function isSafeImeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(value);
}

/**
 * Mac ↔ 输入法那条通道的**抽象 socket 名**：设备侧输入法监听它，桌面侧用
 * `adb.createSocket('localabstract:…')` 连过去 —— 与 scrcpy 自己那条 `localabstract:scrcpy_<scid>`
 * 同一机制，不需要 `forward`、两端都不占 TCP 端口。
 */
export const BRIDGE_SOCKET = "anddrive-mac-keyboard";

/**
 * 握手 token 写在哪一格 `Settings.Global`。抽象 socket 在设备上是**任何 app 都连得上**的
 * （没有文件权限位、Java 侧也拿不到 SO_PEERCRED），所以连上之后第一句必须对上这个暗号 ——
 * 否则同一台手机上的别的软件就能往用户正聚焦的输入框里注字。竞品用 binder + session token
 * 解决同一件事；我们走 Settings 是因为桌面侧本来就有写它的通道（归属那几条命令同一条链路），
 * 而输入法读 `Settings.Global` 不需要任何权限。
 */
export const BRIDGE_TOKEN_SETTING = "anddrive_mac_keyboard_token";

/** `cat` 回来的内容：去掉换行与设备那句「No such file...」。 */
function cleanShellOut(stdout) {
  const line = String(stdout ?? "")
    .split("\n")[0]
    .trim();
  return line && isSafeImeId(line) ? line : null;
}

/**
 * @typedef {"off" | "active" | "switched_away" | "unavailable" | "parked"} MacKeyboardState
 *   - `active` 我们的输入法在位。
 *   - `switched_away` 被别的（用户手动切的、或别的镜像 app 抢的）拿走且我们已停手 —— 竞品的
 *     `mirror.ime.feedback.switched_away` 就是这一格。
 *   - `unavailable` 读不到/写不进，或**不知道原值**（宁可不开，也不能把用户键盘永久顶掉）。
 *   - `parked` 用户在手机上按了胶囊的 ×（让出）：输入法还是我们的，但不再抢也不再送字。
 */

/**
 * 造一台设备的输入法归属管理器。同一台设备多个镜像窗口共用一份（见 `session.js` 那张表）。
 *
 * @param {{
 *   readIme: () => Promise<string | null>,
 *   writeIme: (value: string) => Promise<boolean>,
 *   runShell: (command: string) => Promise<{ ok: boolean, stdout: string }>,
 *   onState?: (state: MacKeyboardState) => void,
 *   intervalMs?: number,
 *   limit?: number,
 *   setIntervalImpl?: (fn: () => void, ms: number) => unknown,
 *   clearIntervalImpl?: (handle: unknown) => void,
 * }} deps 三个设备操作都要已绑好这台设备；`readIme` 回 null = 读不到。
 */
export function createMacKeyboard(deps) {
  const {
    readIme,
    writeIme,
    runShell,
    onState = () => {},
    intervalMs = RECONCILE_INTERVAL_MS,
    limit = REASSERT_LIMIT,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = deps;

  /** @type {MacKeyboardState} */
  let state = "off";
  /** 是否归我们管（`state` 是"管成什么样"，两者要分开：开启那一拍 state 还是 off，但已经在管了）。 */
  let running = false;
  /** 用户原来的输入法；只有拿到合法值才允许开启（否则还原不了）。 */
  let original = null;
  /**
   * 用户在设备上按了胶囊上的 ×（"这一会儿把键盘还给我"）。停手但**不还原归属** ——
   * 输入法还是我们那条，只是不再抢、也不再送字。桌面端再点一次开关即撤销。
   */
  let parked = false;
  /** 这次会话的握手 token；`enable` 时新生成（每次开启换一个），关掉即清。 */
  let token = null;
  let attempts = 0;
  let timer = null;

  function emit(next) {
    if (state === next) return;
    state = next;
    onState(next);
  }

  async function readStash() {
    return cleanShellOut((await runShell(`cat ${STASH_FILE} 2>/dev/null`)).stdout);
  }

  /** 设备上还启用的、不是我们的那一条输入法 —— stash 丢了时的兜底落点（宁可猜一个也别让手机没键盘）。 */
  async function pickFallbackIme() {
    const { stdout } = await runShell("ime list -s");
    const line = String(stdout)
      .split("\n")
      .map((value) => value.trim())
      .find((value) => isSafeImeId(value) && value !== MAC_KEYBOARD_IME);
    return line ?? null;
  }

  /**
   * 认领一次"上一任没还原"的残留：设备上是我们的输入法、而我们这边没在管。
   * dev 实例重启 / 进程被强杀都会留下这种状态。不认领的话：页面查到 `off`、按钮是暗的，
   * 点一下走 `enable()` 又因为认不出原值回 `unavailable` ⇒ **谁都关不掉，手机还没有键盘**
   * （10-11 用户报"关闭 mac 打字失效"就是这个）。
   */
  async function adopt() {
    if (running) return state;
    if ((await readIme()) !== MAC_KEYBOARD_IME) return state;
    const stashed = await readStash();
    original = stashed && stashed !== MAC_KEYBOARD_IME ? stashed : await pickFallbackIme();
    if (!original) {
      emit("unavailable");
      return state;
    }
    running = true;
    parked = false;
    attempts = 0;
    // 把原值补回设备侧那份：下一次再异常退出时才有得捡。
    await runShell(`echo ${original} > ${STASH_FILE}`);
    emit("active");
    timer = setIntervalImpl(reconcile, intervalMs);
    return state;
  }

  /**
   * 盯一次：在位就算成功；不在位且还有额度就重新断言（写完必须回读）；
   * 额度用光就停手 —— 这时候继续抢是和对面打架，不是解决问题。
   */
  async function reconcile() {
    // 用户按过 ×（让出）之后这一趟整个空转：不写、也不改状态 —— 那会儿输入法还是我们的，
    // 但"在位"不代表"在用"，把它报回 `active` 会让桌面那颗开关自己又亮起来。
    if (!running || parked) return state;
    const current = await readIme();
    if (current === MAC_KEYBOARD_IME) {
      attempts = 0;
      emit("active");
      return state;
    }
    if (current === null) {
      emit("unavailable");
      return state;
    }
    if (attempts >= limit) {
      emit("switched_away");
      return state;
    }
    attempts += 1;
    await writeIme(MAC_KEYBOARD_IME);
    emit((await readIme()) === MAC_KEYBOARD_IME ? "active" : "switched_away");
    return state;
  }

  async function enable() {
    if (running) {
      // 用户又点了一次「开」（包括从 `parked` 恢复）：额度装满、把 × 撤掉的定时器与 stash 补回来，再抢一次。
      // 上限是为了防乒乓（两家互写），不是"这台设备从此归别人"——没有这一条，
      // 停手之后开关就点不动了（10-11 真机撞到的：静置 9s 被抢走后怎么点都不回来）。
      attempts = 0;
      parked = false;
      if (original) await runShell(`echo ${original} > ${STASH_FILE}`);
      if (!timer) timer = setIntervalImpl(reconcile, intervalMs);
      return reconcile();
    }
    const current = await readIme();
    // 读不到当前值 = 没法原样还回去，那就不开（同 `keepAwake` 那条口径）。
    if (current === null) {
      emit("unavailable");
      return state;
    }
    if (current === MAC_KEYBOARD_IME) {
      // 上一次没走到还原（进程被强杀 / dev 重启）：设备上那份才是用户的原输入法；
      // 那份也没了就从"设备上还启用的别的输入法"里挑一个 —— 宁可猜一个，也别让手机没键盘。
      const stashed = await readStash();
      original = stashed && stashed !== MAC_KEYBOARD_IME ? stashed : await pickFallbackIme();
    } else {
      original = isSafeImeId(current) ? current : null;
    }
    if (!original) {
      emit("unavailable");
      return state;
    }
    // 每次开启换一个新的握手 token：设备上那条抽象 socket 谁都能连，暗号得是这次会话的。
    token = randomBytes(16).toString("hex");
    await runShell(`settings put global ${BRIDGE_TOKEN_SETTING} ${token}`);
    await runShell(`ime enable ${MAC_KEYBOARD_IME}`);
    await runShell(`echo ${original} > ${STASH_FILE}`);
    running = true;
    parked = false;
    attempts = 0;
    await reconcile();
    timer = setIntervalImpl(reconcile, intervalMs);
    return state;
  }

  async function disable() {
    if (!running) return state;
    running = false;
    parked = false;
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    attempts = 0;
    const back = original;
    original = null;
    token = null;
    if (back) await writeIme(back);
    await runShell(`rm -f ${STASH_FILE}`);
    // 设备上留个 null 比留一个旧 token 好：输入法那边读到空就知道"没人配对了"，直接拒连。
    await runShell(`settings put global ${BRIDGE_TOKEN_SETTING} null`);
    emit("off");
    return state;
  }

  /**
   * 设备侧按了胶囊上的 × = **让出键盘**：把用户的原输入法立刻写回去，让他在手机上用自己的键盘。
   * ⚠️ 不能只是"收起视图"（第一版这么做的，被用户当场打回：「关不掉 mac 打字了，调不出来手机输入法」）——
   *   我们这条输入法**没有键**，占着归属又不显形，手机上就打不出任何字。竞品的 × 也是还原
   *   （它日志里那句 `restoreOriginalInputMethodIfNeeded`）。
   * 意图（`wanted`）留在桌面端：状态是 `parked` 而不是 `off`，桌面那颗再点一下即重新接管。
   */
  async function park() {
    if (!running) return state;
    parked = true;
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    if (original) await writeIme(original);
    await runShell(`rm -f ${STASH_FILE}`);
    emit("parked");
    return state;
  }

  return {
    enable,
    disable,
    reconcile,
    adopt,
    park,
    getState: () => state,
    getOriginal: () => original,
    getToken: () => token,
  };
}
