import { CHANNELS } from "../../electron/ipcContract.js";
import { startSession, getController, stopSession, reclaimApp, getSessionInfo } from "./direct-session.js";
import { createOpusPlayer } from "./audio.js";
import { applyControl } from "../../electron/mirror/control.js";

// 镜像窗口（非隔离 + nodeIntegration）由 preload 注入 ipcRenderer 句柄。
const ipcRenderer =
  window.__anddriveIpc ?? window.require?.("electron")?.ipcRenderer;

// ---------------------------------------------------------------------------
// 直连形态的接入层（仅镜像窗口加载）：
// - 启动参数通过 invoke 拉取（避免 did-finish-load 时序竞态）
// - 视频包直接写 WebCodecs 解码器，音频包直接送 Opus 播放器
// - 输入控制直接写本进程的 control socket（不经过主进程）
// ---------------------------------------------------------------------------

let player = null;

/**
 * App.vue 启动入口：拉取启动参数 → 认领应用归属 → 建立直连会话 → 帧数据送解码管线。
 * 可以重复调用（被顶掉后点「接回」就是再来一次，这次换成我们顶掉别人）。
 * @param {{
 *   video: (packet) => Promise<void> | void,
 *   audio: (packet) => void,
 *   audioStats: (stats: Record<string, number>) => void,
 *   hooks: { onMeta?: (meta) => void, onAudioError?: (message: string) => void,
 *            onReflowStart?: (size) => void, onReflowAbort?: () => void },
 * }} apply App 侧管线接线
 */
export async function bootstrap(apply) {
  const info = await ipcRenderer.invoke(CHANNELS.mirrorInitGet);
  if (!info) throw new Error("镜像启动参数缺失");
  window.__anddriveMirrorId = info.id;
  window.addEventListener("beforeunload", () => stopSession());

  player = createOpusPlayer({
    onStats: (stats) => apply.audioStats?.(stats),
    onError: (message) => apply.hooks.onAudioError?.(String(message)),
  });

  return startSession(info, {
    onVideoPacket: apply.video,
    onAudioPacket: (packet) => {
      apply.audio?.(packet)
      player.push(packet)
    },
    onMeta: (meta) => apply.hooks.onMeta?.(meta),
    onReflowStart: (size) => apply.hooks.onReflowStart?.(size),
    onReflowAbort: () => apply.hooks.onReflowAbort?.(),
    onStolen: (stolen) => apply.hooks.onStolen?.(stolen),
    onEnded: (detail) => {
      // server 端自发退出（设备断开 / server 异常）。
      if (!window.__anddriveMirrorId) return
      ipcRenderer.send(CHANNELS.mirrorState, {
        id: info.id,
        kind: "exit",
        message: `scrcpy 服务意外退出，镜像已结束${detail ? `：${detail}` : ""}`,
      })
      window.close()
    },
  })
}

/** 「接回画面」：把被别的显示（别的投屏软件）拿走的应用原样搬回本窗口，不重启。 */
export { reclaimApp };

/** 本窗口的会话信息（包名 / 标签 / 序列号），镜像页取应用图标要用。 */
export { getSessionInfo };

/** 触控 / 键盘 → 直接写本进程内的 control socket。 */
export function sendControl(message) {
  const controller = getController();
  if (!controller) return;
  void applyControl(controller, message).catch((error) => {
    console.warn(`[mirror] 控制消息失败（${message?.kind}）：`, error?.message || error);
  });
}

/** 卸载/关窗：释放播放器与 scrcpy client。 */
export function dispose() {
  player?.dispose();
  player = null;
  window.__anddriveMirrorId = null;
  return stopSession();
}
