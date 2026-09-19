# 自研镜像引擎（实验）

> 除 scrcpy 原生窗口外，AndDrive 内置一个实验性的自研镜像客户端。
> 本文档记录其现状、架构与**剩余待办**，供后续排期使用。
> 相关原理见 [`PRINCIPLE_DOCUMENT.md`](PRINCIPLE_DOCUMENT.md)，功能路线图见 [`FEATURE_ROADMAP.md`](FEATURE_ROADMAP.md)。

## 1. 它是什么

复用随包的 `scrcpy-server`，**整个客户端用 Tango（`@yume-chan`）官方库在渲染进程内直连**：
adb 走官方 `@yume-chan/adb-server-node-tcp`（镜像窗口启用 `nodeIntegration`），
scrcpy 会话用官方 `@yume-chan/adb-scrcpy` / `@yume-chan/scrcpy` 建立，视频/音频流
不再跨进程，由 WebCodecs 解码、WebGL canvas 渲染。
控制协议完全由 Tango 的 `ScrcpyControlMessageWriter` 序列化（应用只做 DOM 事件 → writer 入参的映射）。

自研引擎是启动镜像的**默认**（`engine: "native"`，`normalizeScrcpyConfig` 校验/持久化）；
自研引擎唯一可用（原 scrcpy 引擎已删除，2026-09-16）。

主进程只承担：创建镜像窗口、下发启动参数（渲染层 invoke 拉取）、
维护会话记录（渲染层 ready/exit 上报）与断开/退出时关窗销毁。

## 2. 现状（已完成）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 协议与连接 | `src/mirror/connect.js` | Tango 官方 `AdbServerNodeJsClient` + `AdbScrcpyClient`；push server、`AdbScrcpyOptions4_0`、scid 由官方库直接处理 |
| 参数映射 | `electron/mirror/options.js` | `ScrcpyConfig` → scrcpy 4.0 选项；编码回落、窗口/息屏偏好、恒定 `flexDisplay`（`--flex-display`，窗口 resize → 官方 `resizeDisplay` 控制消息）。虚拟显示初始尺寸与后续跟随尺寸都由渲染层按 `窗口尺寸 × devicePixelRatio` 计算（`shared/scrcpyConfig.js` 的 `computeDisplayMetrics`），dpi 同步乘，于是 **1dp = 1 CSS px**、画面比例恒等于窗口比例。镜像只有大屏一种形态，不再压 600dp dpi 下限、也没有平板 1.5x（两者都已删除），见 §P3「大屏（pad）模式」|
| 显示跟随去重 | `src/mirror/displayFollow.js` | 只在尺寸**真的变化**时下发 `resizeDisplay`：初始尺寸已用于创建虚拟显示，重复下发会让服务端白走一次 `virtualDisplay.resize()` → capture reset，设备侧应用随之重新决定方向（表现为画面反复旋转）；同一合并窗口内只发最后一次。见 §3 排查记录 |
| 会话生命周期 | `electron/mirror/session.js` | 窗口管理、会话记录、断开/退出清理；`src/mirror/session.js` / `direct-session.js` 与官方流的接线；大屏配方 IPC（`mirror:padMode`）在此接线，编排在 `electron/mirror/padMode.js` |
| 输入控制 | `electron/mirror/control.js`、`src/mirror/useMirrorInput.js` | 单指触控、滚轮、键盘（特殊键 + 文本注入）；序列化全在 Tango（`injectTouch/...`），Android 键值/metaState 用官方 `AndroidKeyCode` / `AndroidKeyEventMeta` / `AndroidMotionEventAction` 常量 |
| 解码渲染 | `src/mirror/App.vue` | WebCodecs 解码；`AutoCanvasRenderer` 优先 WebGL，按显示尺寸出图；HUD 诊断 |
| 音频转发 | `src/mirror/audio.js` | scrcpy 4.0 Opus → WebCodecs `AudioDecoder` → AudioContext 排程播放；音频不可用时自动降级纯画面；会话表见 `docs/archive` 记录 |
| 会话管理 UI | `src/composables/useScrcpySessions.js`、`src/components/ScrcpySessions.vue` | 与 scrcpy 会话合并展示，支持聚焦/关闭/全部关闭 |
| 无界面调试 | `scripts/mirror-spike.mjs` | `pnpm mirror:spike <serial> [h264\|h265] [raw-out] [秒数]` |

### 2.1 关键约束

- **协议层依赖 Tango beta**：scrcpy 4.0 支持位于 `3.0.0-beta.2`，版本已在 `package.json` 锁定，升级需回归。
- **全用官方库、同一模块副本**：渲染层所有 `@yume-chan/*` 包必须经 preload 注入的
  `window.require` 获取（`sandbox:false` + `nodeIntegration`）。Vite 静态打包镜像侧的
  `@yume-chan/*` 会产生第二份模块实例，stream 内部类（`PushReadableStream`、
  `MaybeConsumable`）跨拷贝时写流会挂死——此坑已验证，改代码时务必保持
  `src/mirror/connect.js` 不静态 import 原生包。
- **编码**：启用 `h264` / `h265`（依赖平台 WebCodecs 硬解）；`av1` 未验证，自动回落 `h264`（`resolveNativeCodec`）。
- **音频仅 Opus**：scrcpy 4.0 的音频链路只支持 `opus`（`ScrcpyAudioCodec.Opus`），WebCodecs 直接解码；配置包是 `OpusHead`，preskip 在播放侧裁掉（`src/mirror/audio.js`）。音频不可用（disabled/errored）时自动降级纯画面。
- **帧率上限来自显示器**：可见帧率受屏幕刷新率限制（例如 4K@60 屏最高 60fps），与渲染管线无关。
- **只读之外的能力**：剪贴板、中文 IME、多指手势尚未接入。
- **构建请注意 chunk 隔离**：镜像页与主页共享模块被 rolldown 合并进主页入口 chunk 会导致镜像页执行主页的 `createApp().mount('#app')`，`vite.config.js` 里已用 `advancedChunks` 把共享代码拆成独立 `mirror-support` chunk，勿删。

## 3. 剩余待办& 排查记录

状态：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成。

### P1 输入与交互

- [ ] **剪贴板互通**
  - [ ] 本机 → 设备：`Cmd+V` 经 `controller.setClipboard` 下发（跳过 Cmd 组合键放行逻辑，仅拦截粘贴）
  - [ ] 设备 → 本机：订阅 `client.clipboard` 流，写入系统剪贴板
  - 验收：Android 输入框粘贴到本机复制的文本；设备复制后本机可粘贴
- [ ] **指针习惯补齐**（操作栏已在 2026-09-16 移除，鼠标侧手势成为高频操作的主要入口）
  - [ ] 右键 → 返回（`backOrScreenOn`）
  - [ ] 中键 → 主屏
  - 验收：仅用鼠标也能完成高频返回/回桌面
- [ ] **多指触控 / 捏合缩放**（当前 `pointerId` 固定为 0，仅单指）
  - 验收：地图/图片可双指缩放

### P2 会话与窗口

- [ ] **镜像窗口截图保存**：`decoder.snapshot()` → 主进程保存对话框/写文件
- [ ] **会话列表增强**：重开、截图、切换置顶等快捷动作（`ScrcpySessions.vue`）
- [ ] **窗口尺寸/位置记忆**：按应用或全局记住上次窗口大小
- [ ] **设备断线自动重连**：复用 `electron/adb.js` 的重连逻辑，会话级恢复

### P3 引擎收尾

- [x] **虚拟显示跟随窗口**（2026-09-16 完成，2026-09-17 改为默认行为）：恒定 `flexDisplay` 服务端选项 + 官方 `resizeDisplay`，窗口尺寸变化即重排虚拟显示；对话框不再暴露 `newDisplay`/`renderFit`，虚拟显示尺寸按窗口 × devicePixelRatio 计算（Retina 更清晰，1dp = 1 CSS px）

- [x] **跟随请求去重**（2026-09-19 完成）：启动阶段不再补发与 `newDisplay` 完全相同的 `resizeDisplay`，窗口拖动期间的多次变化合并为一次（`src/mirror/displayFollow.js` + `tests/mirror/displayFollow.test.js`）
- [x] **虚拟显示比例吸附（已回退）**（2026-09-19 试错）：曾把显示尺寸吸附到横 16:9 / 竖 9:16 的内接盒，当天回退。黑边的真正变量不是比例，而是 **Android 的 600dp 大屏门槛**：`smallestWidth ≥ 600dp` 时系统判定大屏并**忽略 app 的方向锁**，锁方向的 app 走 size-compat 被 letterbox 在帧内（双层黑）；`sw < 600dp` 时锁被尊重，`FLAG_ROTATES_WITH_CONTENT` 让显示跟着 app 转，app 填满帧。实测（Redmi 2509FPN0BC / Android 17 / 抖音）：`1920x1080/320`(sw540) 与 `3424x1926/640`(sw481) → 转竖填满；`3424x1926/320`(sw963) 与 `1920x1080/160`(sw1080) → 保持横并 letterbox。`flexDisplay` 对该行为无影响（A/B 过）
- [x] **大屏（pad）模式：镜像的唯一形态**（2026-09-19 落地）：窗口初始形状 = 设备屏幕宽高比（`mirrorWindowBounds`，长边封顶 1000 CSS px 并夹在桌面可用区域内；查不到分辨率按 9:19.5 兜底）。pad 状态下的 app 在竖形显示上排双列 feed、横形显示上排宽布局，两种都 `mBounds == mMaxBounds`（真机量过 `1200x2608/160` 与 `2560x1440/320`），所以窗口照手机比例开也不会有黑边。会话建立前由 `electron/mirror/padMode.js` 跑完这套配方，缺一步都不成立：
  1. `am compat enable OVERRIDE_ANY_ORIENTATION_TO_USER <pkg>`（Android 16 大屏方向 change，id `310816437`；这台 HyperOS 把 `dumpsys compat` 改名成了 `platform_compat`，change 名用 `dumpsys platform_compat -a` 列）。**这条只在物理屏生效** —— 单独打在 scrcpy 虚拟显示上无效（先打开关再冷启动 / 先冷启动再打开关 / `user_rotation=1` / 物理屏同时改大屏，四种顺序全部量到 `sw589dp w589dp port` 竖条）。
  2. `wm size 1920x1080` + `wm density 160` 把**物理屏**临时改成横形大屏（sw=1080dp）。
  3. `am force-stop` + `monkey -c LAUNCHER` 重启 app —— compat 是**进程启动时**读的，热着的进程不会重读。
  4. 轮询 `dumpsys window` 直到 app 在物理屏上 `mBounds == mMaxBounds` 且横向（= 它自己进了 pad）。
  5. 建宽虚拟显示 + `startApp` 把它搬过去 → `mBounds == mMaxBounds`（实测 `1920x1080/240` 下 `sw720dp w1280dp h720dp`），pad 布局铺满整帧。
  6. 搬完再 `wm size reset && wm density reset` 还原物理屏 —— **实测还原后虚拟显示上的 pad 不掉**，后续 `resizeDisplay` 跟随窗口（量到 resize 成 `1600x900` 仍 `mBounds == mMaxBounds`）也不掉。所以手机屏幕只在开会话那几秒是横形大屏。
  - 生命周期：渲染层在建会话前 `enter`、`startApp` 之后 `settle`（还原物理屏）、关会话时 `exit`（还原 compat）。主进程兜三层 —— 窗口关闭 / 会话异常退出 / 设备断开都补 `exit`，`settle` 另有 30s 超时自动还原，渲染层挂了也不会把手机留在大屏状态。
  - 代价（用户 2026-09-19 知情后选定）：**每次开镜像都会重启目标 app**，且手机本体屏幕会短暂横过来变大屏。会话中途不能提前关 compat（实测一关 app 窗口直接消失），所以只在会话结束还原。
  - 同时删除：`tablet` 平板模式（1.5x 上报）与「dpi 下限把 sw 钉在 600dp 以下」这两套旧的小屏/折中方案，`computeDisplayMetrics` 现在就是 `窗口 × devicePixelRatio` + `dpi = 160 × devicePixelRatio`，即 1dp = 1 CSS px。旧参数存盘里的 `tablet` 字段由 `normalizeScrcpyConfig` 静默丢弃。
  - 未验：没有 pad 布局的 app 走这套配方会怎样（大概是被强制横屏后拉伸排版）；真机反馈后再决定要不要按包豁免。
- [x] **镜像窗口绿色按钮 = 全屏**（2026-09-19 完成）：`electron/mirror/session.js` 显式 `fullscreenable: true`。Electron 44 上只要构造时显式传了 `fullscreen`（未勾「全屏启动」即 `false`），窗口就被标成不可全屏，macOS 绿色按钮退化成 zoom（最大化、保留菜单栏）；置顶与全屏启动两种组合下均已验证为可全屏
- [ ] **设备侧旋转的剩余观感**：虚拟显示带 `VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT`，方向由设备上的应用决定；应用自身在启动过程中换向（例如抖音）仍会让画面转一次。可选缓解：`--no-vd-system-decorations`（不渲染虚拟显示里的 launcher/系统装饰）、或把启动应用放到服务端侧，避免「先显示 launcher 再启动应用」这段换向窗口

- [x] **音频转发**（2026-09-16 完成）：scrcpy 4.0 Opus → WebCodecs `AudioDecoder` → AudioContext 排程播放，preskip 裁剪、落后丢帧
- [x] **渲染层直连**（2026-09-16 完成）：镜像窗口 `nodeIntegration` + 官方 Tango 库直连 adb server；去掉主进程 per-packet 转发（曾做 ws 桥方案后替换为官方 connector）
- [ ] **AV1 支持**：验证平台解码并移出回落名单
- [ ] **控制错误可见性**：控制失败目前仅 `console.warn`，可上报到会话 UI
- [ ] **服务端输出采集**：消费 `client.output`，把 scrcpy 报错并入异常退出提示
- [x] **移除旧 scrcpy 引擎**（2026-09-16 完成）：删除 `electron/adb.js` 的 `startScrcpy`/命令行/会话管理路径、`electron/scrcpyApp.js`、随包 `resources/scrcpy/scrcpy` 二进制（8.6MB）、相关 IPC/preload/API/UI；`.adr`/`anddrive://` 唤起改走自研镜像窗口

排查记录（2026-09-16 首次接通）：

1. 音频无声 —— `push()` 原先在 `configuration` 包前就有 `decoder` 空值守卫导致从未配置；`pts` 是 Tango 的 u64 BigInt，直接传给 `EncodedAudioChunk` 会抛 `Cannot convert a BigInt value to a number`。已修。
2. 镜像页页面 JS 报 `Cannot read properties of null (reading 'nextSibling')` —— rolldown 把首页入口 chunk modulepreload 给镜像页，连带执行主页 `createApp().mount('#app')`；用 `advancedChunks` 分组独立解决。

排查记录（2026-09-19 画面旋转）：

1. 现象：点某个应用（如抖音）镜像到电脑时，画面会连续旋转/翻正几下。
2. 服务端机制（scrcpy 4.0，`server/.../video/NewDisplayCapture.java`）：虚拟显示以 `--new-display` 的尺寸创建，之后每条 `resizeDisplay` 都走 `virtualDisplay.resize()`；显示属性变化即 `capture.reset()` 重启编码器。虚拟显示带 `VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT`，**旋转由设备上的应用决定**，每次配置变更应用都会重新决定方向。
3. 客户端问题：`direct-session.js` 原先在 `startApp` 之后无条件补发一次 `resizeDisplay`，尺寸与 `connect.js` 创建虚拟显示时用的 `newDisplay` 完全相同；`ResizeObserver` 首次回调又发一次。这两次重复请求都会让服务端再走一遍 resize → reset，应用随之重新取向，于是画面「旋转几下」。
4. 修复：`src/mirror/displayFollow.js` 记录「已下发尺寸」，相同尺寸直接丢弃；多次变化在 150ms 合并窗口内只发最后一次（服务端另有 300ms 去抖 `DisplayResizeDebouncer`）。`connect.js` 的 `startScrcpy` 现在返回实际用于创建虚拟显示的尺寸，供 `seed()` 初始化。
5. 验证：HUD 的 `chg`（视频尺寸变化次数）在启动后应保持 0；拖动窗口时增长一次且画面不反复翻正。

## 4. 验证与排查

- 图形验证：`pnpm dev` → 连接设备 → 应用右键「启动镜像」→ 勾选实验引擎。
- 协议验证：`pnpm mirror:spike <serial> h265 /tmp/mirror.h265 15`，用 `ffprobe` 检查裸码流。
- 镜像窗口 HUD（仅 dev 显示）：`gl`（WebGL 是否可用）、`renderer/type`（webgl/bitmap、hardware/software）、`shown/draw/skipDraw`、`q`（decodeQueueSize）、`skipDec/reset`、`win/vid/chg`（窗口尺寸 / 视频尺寸 / 视频尺寸变化次数）、`audio`（音频包数）、`ap/asq/ad`（音频播放/队列/解码）、`atime/astate`（音频时钟与上下文状态）。
- 需要镜像窗口 DevTools 时设 `ANDRIVE_MIRROR_DEVTOOLS=1`（默认不开，避免影响性能）。

| HUD 现象 | 结论 |
| --- | --- |
| `q` 长期 >0、`reset` 增长 | 解码跟不上：缩小镜像窗口 / 降 `maxFps` / 码率，或换 H.264 |
| `gl=N ... bitmap` | WebGL 被判定为软件渲染，回落 2D |
| `skipDraw` 增长、`shown` 约等于 `draw` | 同一 vsync 内合并多帧（降延迟的预期行为） |
| `audio>0` 但 `ad=0` | 音频解码未推进：配置包被守卫拦下或 pts BigInt 未转换（历史上出现过，现为已修复形态） |
| `astate=suspended` | 自动播放策略拦了 AudioContext：确认镜像窗口 `autoplayPolicy` 设置 |

## 5. 关键文件

```text
electron/mirror/
  options.js    ScrcpyConfig → scrcpy 4.0 选项、编码回落、运行时偏好（纯函数，双端共用）
  control.js    DOM 语义事件 → Tango writer 入参映射（序列化在 Tango）
  session.js    窗口/记录生命周期、断开清理、异常退出通知（不做帧转发）
src/mirror/
  main.js       镜像页入口
  connect.js    Tango 官方 库（adb-server-node-tcp / adb-scrcpy）的唯一接入口；module 约束见上
  direct-session.js  会话建立、流泵、scrcpy 退出处理
  displayFollow.js   虚拟显示跟随窗口的请求去重/合并（纯逻辑，有单测）
  session.js    App 访问层（bootstrap / sendControl / dispose）
  App.vue       解码、渲染、HUD
  audio.js      Opus → WebCodecs 解码 → AudioContext 排程播放
  useMirrorInput.js  指针/滚轮/键盘 → 控制消息
shared/keys.js  Android 键值别名（包装 Tango android 常量，双端共用）
shared/scrcpyConfig.js  参数归一化（双端共用）
mirror.html     镜像窗口页面（vite 多页面入口；advancedChunks 分组）
```
