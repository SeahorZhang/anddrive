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
| 参数映射 | `electron/mirror/options.js` | `ScrcpyConfig` → scrcpy 4.0 选项；编码回落、窗口/息屏偏好、恒定 `flexDisplay`（`--flex-display`，窗口 resize → 官方 `resizeDisplay` 控制消息）。虚拟显示初始尺寸与后续跟随尺寸都由渲染层按 `窗口 CSS × DISPLAY_PIXEL_SCALE` 计算（`shared/scrcpyConfig.js` 的 `computeDisplayMetrics`），dpi 同步乘，于是 **1dp = 1 CSS px**、画面比例恒等于窗口比例。镜像只有大屏一种形态，不再压 600dp dpi 下限、也没有平板 1.5x（两者都已删除），见 §P3「真横屏虚拟显示」|
| 显示跟随去重 | `src/mirror/displayFollow.js` | 只在尺寸**真的变化**时下发 `resizeDisplay`：初始尺寸已用于创建虚拟显示，重复下发会让服务端白走一次 `virtualDisplay.resize()` → capture reset，设备侧应用随之重新决定方向（表现为画面反复旋转）；**停手 `RESIZE_SETTLE_MS`（250ms）后才发最终尺寸**（debounce，不是 throttle）。见 §3 排查记录 |
| 会话生命周期 | `electron/mirror/session.js` | 窗口管理、会话记录、断开/退出清理；`src/mirror/session.js` / `direct-session.js` 与官方流的接线；横屏虚拟显示由随包 server 的 `VirtualDisplayConfig` 开关决定，见 §P3「真横屏虚拟显示」 |
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

- [x] **虚拟显示跟随窗口**（2026-09-16 完成，2026-09-17 改为默认行为）：恒定 `flexDisplay` 服务端选项 + 官方 `resizeDisplay`，窗口尺寸变化即重排虚拟显示；对话框不再暴露 `newDisplay`/`renderFit`，虚拟显示尺寸按窗口 × `DISPLAY_PIXEL_SCALE` 计算（1dp = 1 CSS px；倍率不再跟 devicePixelRatio，理由见下面「px 写死的控件」）

- [x] **跟随请求去重**（2026-09-19 完成）：启动阶段不再补发与 `newDisplay` 完全相同的 `resizeDisplay`，窗口拖动期间的多次变化合并为一次（`src/mirror/displayFollow.js` + `tests/mirror/displayFollow.test.js`）
- [x] **拖宽时画面反复重排 → 改成停手才发**（2026-09-19）：原来的 150ms 是 **throttle**（第一次变化起计时，期间每 150ms 仍发一条），拖一次宽度要发十几条。真机量过：每 150ms 发一步把 920 宽拖到 1880，服务端 300ms 去抖**并没有**合掉中间值，每一步都真的改了显示 → app 每一步重新决定布局（`≤1560x1800` 跟着填满，`1720x1800` 翻成固定比例竖条 + 左右黑边，`1880x1800` 又重排），就是「转好几次」。改成 **debounce**（每次变化都把定时器推后，`RESIZE_SETTLE_MS = 250`），一次拖拽只剩最后一次重排。
  - 剩下的那一次重排仍然看得见（画面跳一下/翻一次），用户否掉了「不越过方向」「不跟随窗口」「重编 server 抹 flag」三条（都会牺牲跟随或引入黑边），选了**遮罩**：`src/mirror/App.vue` 里 `covering` + `showCover/hideCover` —— 窗口比例与当前画面比例差超过 2%（`aspectDiffers`，容差防止抖动就盖）时盖上遮罩（`.mirror-cover`：不透明径向渐变 + 居中小胶囊「转圈 + 调整画面尺寸…」；毛玻璃被否掉 —— 模糊挡不住整体位移，透明度低于 ~95% 就看得见闪烁。出现 90ms、淡出 320ms，元素常驻只切 opacity 才有渐变消失）。**盖上/揭开的时机（2026-09-20 改过一次）**：先做过「一有尺寸变化就盖」，当时被否（`resizeDisplay` 还没发，盖住的是什么都没发生的一段时间）；改成在 `createDisplayFollower` 真正下发的那一刻由 `onReflowStart` 通知页面盖。真横屏落地后（拖一次只剩一次重排）用户又要求回到**手一拖就盖**，所以现在是：`createDisplayFollower` 每次收到尺寸请求都回调 `onIntent` → 页面盖并把总兜底线往前推（慢拖超过 3s 也不会中途露出），真正下发 `resizeDisplay` 与否不再影响盖的时机；停手合并后如果发现尺寸其实没变（拖出去又拖回来）回调 `onSkip` → `cancelCover` 立刻撤罩。揭开不用「第一次画面尺寸变化」，而是等尺寸**连续 420ms 不再变**（设备往往先翻方向再改尺寸，看到第一次就揭会露出旋转），另有 3s 总兜底。同比例的纯缩放不触发遮盖（`aspectDiffers` 容差 2%），解码器报回新画面尺寸（`sizeChanged`）后 180ms 揭开，另有 3s 兜底自动揭开（设备没回传也不能一直盖着）。
- [x] **虚拟显示比例吸附（已回退）**（2026-09-19 试错）：曾把显示尺寸吸附到横 16:9 / 竖 9:16 的内接盒，当天回退。黑边的真正变量不是比例，而是 **Android 的 600dp 大屏门槛**：`smallestWidth ≥ 600dp` 时系统判定大屏并**忽略 app 的方向锁**，锁方向的 app 走 size-compat 被 letterbox 在帧内（双层黑）；`sw < 600dp` 时锁被尊重，`FLAG_ROTATES_WITH_CONTENT` 让显示跟着 app 转，app 填满帧。实测（Redmi 2509FPN0BC / Android 17 / 抖音）：`1920x1080/320`(sw540) 与 `3424x1926/640`(sw481) → 转竖填满；`3424x1926/320`(sw963) 与 `1920x1080/160`(sw1080) → 保持横并 letterbox。`flexDisplay` 对该行为无影响（A/B 过）
- [x] **真横屏虚拟显示（大屏 / pad 的唯一形态）**（2026-09-20 落地）：随包的 `resources/scrcpy/scrcpy-server` 换成**我们自己编的 scrcpy 4.0**，它建虚拟显示时走隐藏的 `VirtualDisplayConfig` 路径并打开 `setIgnoreActivitySizeRestrictions(true)`，于是固定竖屏的 app 在横形逻辑尺寸的虚拟显示上**真的按横屏铺满**，不再被 size-compat 压成中间一条竖屏带。窗口初始形状仍 = 设备屏幕宽高比（`mirrorWindowBounds`，长边封顶 1000 CSS px，查不到分辨率按 9:19.5 兜底）。
  - 机制来源：对照 AndroMeld Fusion 的虚拟显示（`dumpsys window displays` → `DisplayWindowSettingsProvider SettingsEntry{... mIsHomeSupported=true, mShouldShowIme=0, mForceAppsUniversalResizable=true}`，我们的显示这一项是 `null`）。该字段由 `VirtualDisplayConfig.Builder#setIgnoreActivitySizeRestrictions` 写入（HyperOS/Android 16 里 dump 名作 `mForceAppsUniversalResizable`，服务端读作 `shouldIgnoreActivitySizeRestrictionsForDisplay`）。它的 `uniqueId` 形如 `virtual:com.android.shell:andromeld-fusion-<uuid>` 也来自 `VirtualDisplayConfig.Builder#setUniqueId`。
  - **单变量对照（同一台机、同一显示几何 `2462x1924/256`、抖音冷启动）**：开关开 → `sw1203dp w1539dp h1113dp 256dpi land`，`mBounds == mAppBounds == mMaxBounds == Rect(0,0-2462,1924)`；开关关（只走 config 路径）→ `sw985dp w985dp h1112dp port`，`mBounds=Rect(443,0-2019,1924)` 竖条。
  - **不动主屏**：全程没有 `wm size`/`wm density`、没有 compat 开关、没有 force-stop + 重启 app。开会话前后 `wm size` 都只有 `Physical size: 1200x2608`（无 Override），手机本体画面不变，之前「先在手机上打开 app 又消失」的闪动随配方一起消失。
  - 开关位置：server 侧 `debug.anddrive.vd.isr`（默认 `"1"` 生效，设 `0` 可临时关掉做对比）；系统没有该 @hide API 时 `NewDisplayCapture` 自动退回公开 `createVirtualDisplay(name,w,h,dpi,surface,flags)`，老设备不受影响。
  - 重编方式（改动在 `NewDisplayCapture.startNew` 与 `wrappers/DisplayManager.createNewVirtualDisplay(..., ignoreActivitySizeRestrictions, homeSupported)`）：
    `cd /Users/xh/code/scrcpy-4.0-patched/server && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=~/Library/Android/sdk ANDROID_PLATFORM=36 ANDROID_BUILD_TOOLS=36.1.0 BUILD_DIR=/tmp/vd-build ./build_without_gradle.sh`，产物 `/tmp/vd-build/scrcpy-server` 覆盖到 `resources/scrcpy/scrcpy-server`。替换前已用同一份 client 链路验证视频（h265）+ 音频（Opus，6s 内 245 个音频包）+ `new-display` + `startApp` 全部正常。
  - 同时删除：`electron/mirror/padMode.js`（compat + 物理屏改写 + 重启轮询那套配方）、`mirror:padMode` IPC、`LARGE_SCREEN_COMPAT` 常量、`adb.js` 里只为配方服务的 `setLargeScreenCompat` / `overrideDisplayGeometry` / `resetDisplayGeometry` / `getAppWindowGeometry`。
  - 已删的历史方案：`tablet` 平板模式（1.5x 上报）与「dpi 下限把 sw 钉在 600dp 以下」的小屏方案；`computeDisplayMetrics` 就是 `窗口 × DISPLAY_PIXEL_SCALE` + `dpi = 160 × DISPLAY_PIXEL_SCALE`，即 1dp = 1 CSS px。旧参数存盘里的 `tablet` 字段由 `normalizeScrcpyConfig` 静默丢弃。
  - **px 写死的控件 → `DISPLAY_PIXEL_SCALE` 是个对数旋钮（当前 2）**：抖音有一批控件按 px 写死，顶部那排 tab 最明显 —— 真机量过 dpi 480 下它的字高只有 ~16 物理像素（14sp 本该 42），且 `settings put system font_scale 1.3` 对它**完全无效**（前后两帧一模一样，抖音不吃系统字体缩放）。唯一能动它的是「同样 dp 少给像素」：倍率减半、dp 不变（布局完全一样），那排字相对画面大一倍；对照实验是同一块 588dp 显示的 `1766x2412` 与 `882x1206` 两帧。**但倍率 1 会把整帧放大 2 倍铺到 Retina 背衬上**，用户实测「不光字不清晰，整个画面都不清晰」→ 定回 2（清晰度优先），字随之回到小。两个诉求物理上顶着，只能选落点（1.5 是中间档）。
    还剩一条**未验**的两全路子：那排字也可能是按**物理屏 density**（恒 480）算的而不是真写死 —— 若是，开会话时临时抬 `wm density` 就能撑大它同时保住 2 倍像素。这条要手机处于解锁状态才能测（设备有锁屏密码，adb 的 swipe 解不开）。
  - 未验：只有竖屏排版、没有宽布局的 app 在横形显示上会怎样（大概是被拉成横屏后排版变形）；真机反馈后再决定要不要按包豁免。
  - 已回退的历史结论（2026-09-19 记录，2026-09-20 推翻）：当时判断「Android 16 只认物理屏为大屏，所以 compat 只在物理屏生效、虚拟显示拿不到横屏」。那是对**没有** `ignoreActivitySizeRestrictions` 的显示做的四种顺序测量得出的，结论只适用于官方 scrcpy 的创建方式。
- [x] **同一设备 + 同一应用只开一个镜像窗口**（2026-09-20 完成）：一个会话 = 一块虚拟显示，同一应用开两个窗口时后建的那块会把应用搬走（真机量过：`startApp` 之后应用窗口从 138 挪到 139，**138 上只剩 MIUI 的 `SecondaryDisplayLauncher`**），先开的窗口变成一块没人用的启动器镜像 —— 就是「两个窗口抢同一条画面」。现在 `startMirrorSession` 先用 `findAppSession`（`electron/mirror/appSession.js`，纯逻辑 + 单测）按「设备 + 包名」查已有会话，命中就 `focusMirrorSession` 把它唤到前台并返回 `reused: true`，不再建第二个窗口；窗口记录还在但窗口已销毁时 `focus` 抛错，就照常新建。
  - 另一条路（参照 app 的「直接把同一块显示看走」）：**采集**别人的虚拟显示是可行的（AndroMeld 就能直接显示我们这块显示上的画面），做不到的只有 **resize 与销毁** —— `VirtualDisplay` 与创建它的进程绑死，只有属主办得到。所以多窗口共览一块显示仍然需要一个常驻持有者，这一档暂不做。
- [x] **无缝接回被别处拿走的应用**（2026-09-20 完成）：应用可能挂在别的显示上 —— 被另一个投屏软件搬走，或本来就在手机主屏上用着。这种时候 `startApp` 只把它留在原处（真机量过 `am start --display <id>` 对**已存在的 task 不改显示**），本窗口就只剩启动器画面。现在的做法是**搬任务、不重启**：`adb shell am display move-stack <taskId> <displayId>`（`electron/adb.js` 的 `moveAppTaskToDisplay`），taskId/当前显示从 `getAppTask` 读（`dumpsys window windows` 里应用窗口的 `mDisplayId=.. taskId=..`），本会话的显示 id 从 server stdout 的 `New display: WxH/D (id=N)` 解析（`direct-session.js` 的 `current.displayId`，stdout 是异步到的所以 `ensureAppHere` 会等它并重试 4×400ms）。
  - 真机验证（抖音被 AndroMeld 的显示 118 占着时开我们的镜像）：pid 30912 → **30912 不变**、taskId 22409 不变，窗口从 118 挪到我们的 147，`mBounds=Rect(0,0-812,1764)` 铺满 —— 进程与页面状态都留着，不是重新启动。
  - 手动入口：**只在画面被抢走时**出现在画面正中间（`.mirror-reclaim`：应用图标 + 「接回画面」，45% 黑底；图标取 `getCachedApps` 缓存里的 `iconUrl`，取不到退化成首字母方块）。检测靠 `watchAppStolen` 每 2.5s 查一次应用还在不在本会话这块显示上（`document.hidden` 时跳过），状态翻转才回调页面；**只亮入口、不自动搬**，自动搬回去等于两边来回抢。接回结果走底部一次性提示（已接回画面 / 画面已经在这个窗口 / 失败原因）。
- [x] ~~镜像窗口「重新启动」按钮~~（2026-09-20 当天加了又删）：`force-stop` + 冷启那颗按用户要求**去掉**了 —— 它和「接回」是两件事，并排放着会误点成重新加载。要救挂死的应用目前只能关窗重开。
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
