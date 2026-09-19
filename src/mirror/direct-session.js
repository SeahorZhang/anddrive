import { CHANNELS } from "../../electron/ipcContract.js";
import { getServerClient, acquireDeviceAdb, startScrcpy, codecName } from "./connect.js";
import { computeDisplayMetrics } from "../../shared/scrcpyConfig.js";
import { createDisplayFollower } from "./displayFollow.js";

// ---------------------------------------------------------------------------
// 直连会话（每窗口一个 scrcpy client）：adb/scrcpy 全用 Tango 官方库建立
// 于本进程；视频/音频/控制流不跨进程。音频失败自动降级纯画面。
// ---------------------------------------------------------------------------

const current = {
  client: null,
  info: null,
  resizeObserver: null,
  follower: null,
  stopping: false,
  /** 本次会话是否成功走了大屏（pad）配方，决定关会话时要不要还原 compat。 */
  pad: false,
};

/** 当前窗口对应的虚拟显示尺寸（像素倍率与 dpi 都在 `computeDisplayMetrics` 里定）。 */
function viewportDisplay() {
  return computeDisplayMetrics(
    document.documentElement.clientWidth,
    document.documentElement.clientHeight,
  );
}

/** 主进程的大屏配方入口（`electron/mirror/padMode.js`）；任何失败都只是退回普通布局。 */
async function padMode(action, info) {
  try {
    return await window.__anddriveIpc?.invoke(CHANNELS.mirrorPadMode, {
      action,
      serial: info.serial,
      packageName: info.packageName,
    });
  } catch (error) {
    console.warn(`[mirror] 大屏模式 ${action} 失败：`, error?.message || error);
    return false;
  }
}

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
  // 大屏配方先跑：主进程会打开 compat 开关、把物理屏临时改成横形大屏、重启目标 app
  // 并等它自己进 pad 横屏。**必须在建虚拟显示之前**做完，否则 app 会以竖屏锁起来，
  // 之后搬到宽显示只会被 size-compat 压成竖条（真机量过四种顺序）。
  current.pad = (await padMode("enter", info)) === true;
  // 先记下来：后面任何一步失败，stopSession 都要能拿到 serial/packageName 去还原。
  current.info = info;
  const adb = await acquireDeviceAdb(getServerClient(), info.serial);
  const { client, display: initialDisplay } = await startScrcpy({
    adb,
    serverPath: info.serverPath,
    config: info.config,
  });
  current.client = client;
  current.info = info;

  const video = await client.videoStream;
  if (!video) throw new Error("scrcpy 未返回视频流");

  // 采集 scrcpy server 的 stdout（stderr 会并入），异常退出时可供排查/上报。
  const serverErrors = new Set();
  try {
    const outputReader = client.output.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await outputReader.read();
          if (done) break;
          if (/error|error:|exception|fail/i.test(value)) {
            serverErrors.add(value);
            console.warn(`[mirror] server: ${value}`);
          }
        }
      } catch {
        // 流结束
      }
    })();
  } catch {
    // output 不可用不影响会话
  }

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
      if (current.client && !current.stopping) {
        const detail = [...serverErrors].slice(-4).join(" / ");
        onEnded(detail);
      }
    })
    .catch(() => {});

  void pumpLoop(video.stream, onVideoPacket, (detail) => onEnded(detail));

  const controller = client.controller;
  await controller?.startApp(info.packageName).catch(() => {});
  // app 已经被搬到虚拟显示上，这时候才可以把物理屏还原（实测还原后虚拟显示上的 pad 不掉）。
  if (current.pad) await padMode("settle", info);
  if (info.prefs?.turnScreenOff) {
    await controller?.setDisplayPower(false).catch(() => {});
  }

  // 虚拟显示跟随窗口（scrcpy `--flex-display` / -x 语义）：官方 resizeDisplay
  // 控制消息驱动，窗口一变化虚拟显示即按窗口尺寸重排（排版随之变化）。
  // 像素 = 窗口 CSS × DISPLAY_PIXEL_SCALE；1dp = DISPLAY_ZOOM CSS px。
  //
  // 只在尺寸真的变化时才下发：初始尺寸已用于创建虚拟显示（`connect.js` 的
  // `newDisplay`），启动阶段再补发一条完全相同的请求会让服务端白走一次
  // `virtualDisplay.resize()` → capture reset；而虚拟显示是
  // `VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT`，每次配置变更设备上的应用都会
  // 重新决定方向，表现出来就是镜像画面反复旋转。合并/去重逻辑见
  // `src/mirror/displayFollow.js`。
  //
  // 尺寸来自 documentElement（视口）的 ResizeObserver，而不是 window 的
  // `resize` 事件 + innerWidth：macOS 上窗口被系统缩放/吸附时，resize 事件
  // 可能滞后甚至不触发，innerWidth 会读到旧值，导致宽度不跟随。
  const follower = createDisplayFollower({
    send: (size) => controller?.resizeDisplay({ width: size.width, height: size.height }),
  });
  follower.seed(initialDisplay);
  current.follower = follower;

  // observe() 会立即回调一次当前尺寸：窗口在会话建立期间变过的话，这次就会补上。
  const observer = new ResizeObserver(() => follower.request(viewportDisplay()));
  observer.observe(document.documentElement);
  current.resizeObserver = observer;

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
  current.stopping = true;
  if (current.resizeObserver) {
    current.resizeObserver.disconnect();
    current.resizeObserver = null;
  }
  if (current.follower) {
    current.follower.dispose();
    current.follower = null;
  }
  // 还原设备：compat 开关（按包）与可能还挂着的物理屏覆盖。放在 client 判空之前 ——
  // enter 成功但 scrcpy 没起来时，也必须把手机状态还回去。
  if (current.pad && current.info) void padMode("exit", current.info);
  current.pad = false;
  if (!current.client) return null;
  const closing = current.client.close?.().catch?.(() => {}) ?? null;
  current.client = null;
  current.info = null;
  return closing;
}
