import { CHANNELS } from "../../electron/ipcContract.js";
import { getServerClient, acquireDeviceAdb, startScrcpy, codecName } from "./connect.js";

// ---------------------------------------------------------------------------
// 直连会话（每窗口一个 scrcpy client）：adb/scrcpy 全用 Tango 官方库建立
// 于本进程；视频/音频/控制流不跨进程。音频失败自动降级纯画面。
// ---------------------------------------------------------------------------

const current = { client: null, info: null };

/**
 * @param {Record<string, unknown>} info mirror:initGet 的启动参数
 * @param {{
 *   onMeta: (meta: Record<string, unknown>) => void,
 *   onVideoPacket: (packet: unknown) => Promise<void> | void,
 *   onAudioPacket: (packet: unknown) => void,
 *   onEnded: () => void,
 * }} handlers
 */
export async function startSession(info, { onMeta, onVideoPacket, onAudioPacket, onEnded }) {
  const adb = await acquireDeviceAdb(getServerClient(), info.serial);
  const client = await startScrcpy({ adb, serverPath: info.serverPath, config: info.config });
  current.client = client;
  current.info = info;

  const video = await client.videoStream;
  if (!video) throw new Error("scrcpy 未返回视频流");

  // 音频失败只降级为纯画面（scrcpy 4.0 仅支持 Opus）。
  let audioConfigured = false;
  try {
    const audioMeta = await client.audioStream;
    if (audioMeta?.type === "success") {
      void pumpLoop(audioMeta.stream, onAudioPacket, null);
      audioConfigured = true;
    } else {
      console.warn(`[mirror] 设备音频不可用（${audioMeta?.type ?? "disabled"}），仅转发画面`);
    }
  } catch (error) {
    console.warn("[mirror] 设备音频不可用：", error?.message || error);
  }

  onMeta({
    id: info.id,
    serial: info.serial,
    packageName: info.packageName,
    label: info.label,
    codec: video.metadata.codec,
    codecName: codecName(video.metadata.codec),
    width: video.width,
    height: video.height,
    hasAudio: audioConfigured,
  });

  // scrcpy server 自行退出（设备断开 / 进程被杀）→ 通知主进程并关窗。
  client.exited
    .then(() => {
      if (current.client) onEnded();
    })
    .catch(() => {});

  void pumpLoop(video.stream, onVideoPacket, onEnded);

  const controller = client.controller;
  await controller?.startApp(info.packageName).catch(() => {});
  if (info.prefs?.turnScreenOff) {
    await controller?.setDisplayPower(false).catch(() => {});
  }

  report("ready", {
    codec: video.metadata.codec,
    codecName: codecName(video.metadata.codec),
    hasAudio: audioConfigured,
  });
  return { hasAudio: audioConfigured };
}

function report(kind, payload = {}) {
  const id = current.info?.id ?? "";
  ipcRendererSend(CHANNELS.mirrorState, { id, kind, ...payload });
}

/** 镜像窗口（非隔离 + nodeIntegration）由 preload 注入的 ipcRenderer。 */
function ipcRendererSend(channel, payload) {
  window.__anddriveIpc?.send(channel, payload);
}

/** 通用流泵（Tango 官方流 API）；send 失败只告警。 */
async function pumpLoop(stream, send, onDone) {
  const reader = stream.getReader();
  for (;;) {
    try {
      const next = await reader.read();
      if (next.done) break;
      await send(next.value);
    } catch {
      break;
    }
  }
  onDone?.();
}

/** 当前 controller（Tango 的 ScrcpyControlMessageWriter）；未连接返回 null。 */
export function getController() {
  return current.client?.controller ?? null;
}

/** 关闭当前 scrcpy client（窗口 beforeunload / 主进程 stop 时调用）。 */
export function stopSession() {
  if (!current.client) return null;
  const closing = current.client.close?.().catch?.(() => {}) ?? null;
  current.client = null;
  current.info = null;
  return closing;
}
