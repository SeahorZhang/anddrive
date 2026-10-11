// Mac ↔ 输入法那条桥（G1 Slice 3）：连设备上输入法监听的**抽象** socket，
// 走 `adb.createSocket('localabstract:<name>')` —— 与 scrcpy 自己那条 `localabstract:scrcpy_<scid>`
// 同一机制，两端都不开 TCP 端口、不需要 `forward`。
//
// 线格式：一行一条 JSON，双向。
//   Mac → 输入法：`{op:'hello',token}`（第一句，必须对上 `Settings.Global` 里那格）、`{op:'commit',text}`。
//   输入法 → Mac：`{op:'hello',proto,caps}`、`{op:'yield'}`（用户在手机上按了胶囊的 ×）、`{op:'pong'}`、
//     `{op:'caret',x,top,bottom}`（手机光标的屏幕矩形，设备 px；`valid:false` = 光标没了，见下）。
//
// ⚠️ 为什么要 token：抽象 socket 在设备上是任何 app 都连得上的，不对暗号就等于把
// "往用户正聚焦的输入框里注字"这个能力开放给整台手机（10-11 真机验过：假 token 连上即被断）。
//
// 断线只退避重连，**不攒提交队列**：没连上时把文本攒下来，会在用户没察觉的情况下突然吐出一大段。

const RECONNECT_MS = 1500;
/** 保活：每 4s 一条 ping；9s 没等到回话就当这条连接已经死了（半开连接看不出来，见下）。 */
const PING_MS = 4000;
const PONG_TIMEOUT_MS = 9000;


/**
 * @param {{
 *   getAdb: () => unknown,                     // 本窗口的 adb（直连会话建起来那份）
 *   socketName: string,                        // 主进程推过来的桥 socket 名
 *   token: string,                             // 主进程写在 Settings.Global 里的那次会话暗号
 *   onYield?: () => void,                      // 设备侧按了 × → 转告主进程去 parked
 *   onNack?: (reason: string) => void,         // 送进去的文本没落进任何输入框 → 给用户一句话
 *   onCaret?: (rect: { x: number, top: number, bottom: number } | null) => void,  // 手机光标的屏幕矩形；null = 现在没有
 * }} options
 */
export function createMacKeyboardBridge({ getAdb, socketName, token, onYield, onNack, onCaret }) {
  /** @type {{ write: (chunk: Uint8Array) => Promise<void> } | null} */
  let writer = null;
  let socket = null;
  let disposed = false;
  let retryTimer = null;
  /** 最后一次听到设备说话的时刻。半开连接（设备那边已经关了、我们的 `read()` 却永不返回）
   *  只能靠它发现 —— 10-11 真机就是这么把 × 弄丢的：`hello sent` 之后设备侧其实已经断了。 */
  let lastPongAt = 0;
  let keepalive = null;

  function line(value) {
    return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  }

  function handleLine(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // 不是 JSON 就当没看见：这条通道上不该有别的说话方，出现了也不该被我们放大。
    }
    // 设备主动说的话都算它还活着（hello / pong 都走这条）。
    lastPongAt = Date.now();
    if (msg?.op === "yield") onYield?.();
    if (msg?.op === "nack") onNack?.(String(msg.reason ?? ""));
    if (msg?.op === "caret") onCaret?.(readCaret(msg));
  }

  /**
   * 设备报来的光标矩形（屏幕坐标、设备 px）。字段缺一个就当作"现在没有光标"（null）——
   * 设备侧读不到插入点时送的就是 `valid:false`，页面据此退回自己攒的那个锚点。
   */
  function readCaret(msg) {
    if (msg.valid === false) return null;
    const { x, top, bottom } = msg;
    if (![x, top, bottom].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
    return { x, top, bottom };
  }

  /** 一条连接的生命周期：连上 → 报暗号 → 读行，直到对端断开；然后退避重来。 */
  async function session() {
    try {
      socket = await getAdb().createSocket(`localabstract:${socketName}`);
      writer = socket.writable.getWriter();
      await writer.write(line({ op: "hello", token }));
      lastPongAt = Date.now();
      const reader = socket.readable.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) break;
          const row = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (row) handleLine(row);
        }
      }
    } catch {
      // 连不上（输入法进程还没起、桥被占、adb 断了）都算这一类：下面统一退避重连。
    }
    writer = null;
    try {
      socket?.close?.();
    } catch {
      /* 已经关了 */
    }
    socket = null;
  }

  async function loop() {
    while (!disposed) {
      await session();
      if (disposed) return;
      await new Promise((resolve) => {
        retryTimer = setTimeout(resolve, RECONNECT_MS);
      });
      retryTimer = null;
    }
  }

  /** 定时 ping；超过 PONG_TIMEOUT_MS 没听到设备说话就掐掉这条连接，让 `loop()` 重连。 */
  function keepaliveBeat() {
    if (disposed || !writer) return;
    if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
      try {
        socket?.close?.();
      } catch {
        /* 已经关了 */
      }
      return;
    }
    void writer.write(line({ op: "ping" }));
  }

  return {
    start() {
      if (disposed) return;
      keepalive = setInterval(keepaliveBeat, PING_MS);
      void loop();
    },
    async stop() {
      disposed = true;
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      writer = null;
      try {
        socket?.close?.();
      } catch {
        /* 已经关了 */
      }
      socket = null;
    },
    /**
     * 合成中的文字：每敲一个字母一条，所以不等回执也不报错（下一条就来覆盖，丢了无所谓）。
     * @param {string} text 空串 = 结束合成（别把半截拼音留在人家输入框里）
     */
    compose(text) {
      if (!writer) return false;
      void writer.write(line({ op: "compose", text: String(text ?? "") }));
      return true;
    },
    /**
     * 送一段文本给输入法提交。没连着就回 false（调用方决定要不要提示用户），
     * 不等回执：`InputConnection.commitText` 是即发的，设备端不会回话。
     */
    commit(text) {
      if (!writer) return false;
      void writer.write(line({ op: "commit", text }));
      return true;
    },
    isConnected: () => writer !== null,
  };
}
