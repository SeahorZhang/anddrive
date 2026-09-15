# 自研镜像引擎（实验）

> 除 scrcpy 原生窗口外，AndDrive 内置一个实验性的自研镜像客户端。
> 本文档记录其现状、架构与**剩余待办**，供后续排期使用。
> 相关原理见 [`PRINCIPLE_DOCUMENT.md`](PRINCIPLE_DOCUMENT.md)，功能路线图见 [`FEATURE_ROADMAP.md`](FEATURE_ROADMAP.md)。

## 1. 它是什么

复用随包的 `scrcpy-server`，用 Tango（`@yume-chan`）建立连接与读取视频流；视频包经主进程 IPC 送到每个会话独立的 Electron 镜像窗口，由 WebCodecs 解码、WebGL canvas 渲染，右侧操作栏由应用自绘。

在「启动镜像」对话框勾选 **使用原生渲染引擎（实验）** 开启（`src/components/ScrcpyLaunchDialog.vue`）。

## 2. 现状（已完成）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 协议与连接 | `electron/mirror/client.js` | Tango 负责 push server、启动 `app_process`、video/control socket；adb transport 按 serial 引用计数复用 |
| 参数映射 | `electron/mirror/options.js` | `ScrcpyConfig` → scrcpy 4.0 选项；编码回落、窗口/息屏偏好 |
| 会话与窗口 | `electron/mirror/session.js` | 独立窗口、IPC 送流、生命周期、断开/退出清理、异常退出提示 |
| 输入控制 | `electron/mirror/control.js`、`src/mirror/useMirrorInput.js` | 单指触控、滚轮、键盘（特殊键 + 文本注入）、操作栏按钮（返回/主屏/最近任务/通知栏/旋转/音量/电源） |
| 解码渲染 | `src/mirror/App.vue` | WebCodecs 解码；`AutoCanvasRenderer` 优先 WebGL，按显示尺寸出图；HUD 诊断 |
| 会话管理 UI | `src/composables/useScrcpySessions.js`、`src/components/ScrcpySessions.vue` | 与 scrcpy 会话合并展示，支持聚焦/关闭/全部关闭 |
| 无界面调试 | `scripts/mirror-spike.mjs` | `pnpm mirror:spike <serial> [h264\|h265] [raw-out] [秒数]` |

### 2.1 关键约束

- **协议层依赖 Tango beta**：scrcpy 4.0 支持位于 `3.0.0-beta.2`，版本已在 `package.json` 锁定，升级需回归。
- **编码**：启用 `h264` / `h265`（依赖平台 WebCodecs 硬解）；`av1` 未验证，自动回落 `h264`（`resolveNativeCodec`）。
- **帧率上限来自显示器**：可见帧率受屏幕刷新率限制（例如 4K@60 屏最高 60fps），与渲染管线无关。
- **只读之外的能力**：剪贴板、中文 IME、多指手势尚未接入。

## 3. 剩余待办

状态：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成。

### P1 输入与交互

- [ ] **剪贴板互通**
  - [ ] 本机 → 设备：`Cmd+V` 经 `controller.setClipboard` 下发（跳过 Cmd 组合键放行逻辑，仅拦截粘贴）
  - [ ] 设备 → 本机：订阅 `client.clipboard` 流，写入系统剪贴板
  - 验收：Android 输入框粘贴到本机复制的文本；设备复制后本机可粘贴
- [ ] **指针习惯补齐**
  - [ ] 右键 → 返回（`injectKeyCode` BACK 或 `backOrScreenOn`）
  - [ ] 中键 → 主屏
  - 验收：不依赖操作栏也能完成高频返回/回桌面
- [ ] **多指触控 / 捏合缩放**（当前 `pointerId` 固定为 0，仅单指）
  - 验收：地图/图片可双指缩放

### P2 会话与窗口

- [ ] **镜像窗口截图保存**：`decoder.snapshot()` → 主进程保存对话框/写文件
- [ ] **会话列表增强**：重开、截图、切换置顶等快捷动作（`ScrcpySessions.vue`）
- [ ] **窗口尺寸/位置记忆**：按应用或全局记住上次窗口大小
- [ ] **设备断线自动重连**：复用 `electron/adb.js` 的重连逻辑，会话级恢复

### P3 引擎收尾

- [ ] **音频转发**（首版明确未做）：audio socket → `AudioDecoder` → AudioWorklet
- [ ] **AV1 支持**：验证平台解码并移出回落名单
- [ ] **控制错误可见性**：`mirror:control` 失败目前仅 `console.warn`，可上报到会话 UI
- [ ] **服务端输出采集**：消费 `client.output`，把 scrcpy 报错并入异常退出提示
- [ ] **移除旧 scrcpy 引擎**：自研引擎达到功能对等且稳定后，删除 `electron/adb.js` 的 `startScrcpy` 路径、`electron/scrcpyApp.js` 与随包 `resources/scrcpy/scrcpy` 二进制（约 8.6MB）

## 4. 验证与排查

- 图形验证：`pnpm dev` → 连接设备 → 应用右键「启动镜像」→ 勾选实验引擎。
- 协议验证：`pnpm mirror:spike <serial> h265 /tmp/mirror.h265 15`，用 `ffprobe` 检查裸码流。
- 镜像窗口 HUD（仅 dev 显示）：`gl`（WebGL 是否可用）、`renderer/type`（webgl/bitmap、hardware/software）、`shown/draw/skipDraw`、`q`（decodeQueueSize）、`skipDec/reset`。
- 需要镜像窗口 DevTools 时设 `ANDRIVE_MIRROR_DEVTOOLS=1`（默认不开，避免影响性能）。

| HUD 现象 | 结论 |
| --- | --- |
| `q` 长期 >0、`reset` 增长 | 解码跟不上：降 `newDisplay` 分辨率 / `maxFps` / 码率，或换 H.264 |
| `gl=N ... bitmap` | WebGL 被判定为软件渲染，回落 2D |
| `skipDraw` 增长、`shown` 约等于 `draw` | 同一 vsync 内合并多帧（降延迟的预期行为） |

## 5. 关键文件

```text
electron/mirror/
  client.js     Tango 封装、adb transport 复用、push server、启动会话
  options.js    ScrcpyConfig → scrcpy 4.0 选项、编码回落、运行时偏好（纯函数）
  control.js    输入事件 → scrcpy 控制协议映射（纯函数）
  session.js    会话/窗口生命周期、IPC 送流、清理钩子、异常退出通知
src/mirror/
  main.js       镜像页入口
  App.vue       解码、渲染、HUD、操作栏、消息分发
  useMirrorInput.js  指针/滚轮/键盘 → 控制消息
shared/keys.js  Android 键值常量（主进程与渲染层共用）
mirror.html     镜像窗口页面（vite 多页面入口）
```
