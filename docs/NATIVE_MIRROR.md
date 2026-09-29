# 自研镜像引擎（实验）

> 除 scrcpy 原生窗口外，AndDrive 内置一个自研镜像客户端（现在它是**唯一**形态）。
> 本文档记录其现状、架构与**剩余待办**，以及真机取证记录。
> 相关原理与项目约定见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，待办与缺陷见 [`TODO.md`](TODO.md)。

## 1. 它是什么

复用随包的 `scrcpy-server`，**整个客户端用 Tango（`@yume-chan`）官方库在渲染进程内直连**：
adb 走官方 `@yume-chan/adb-server-node-tcp`（镜像窗口启用 `nodeIntegration`），
scrcpy 会话用官方 `@yume-chan/adb-scrcpy` / `@yume-chan/scrcpy` 建立，视频/音频流
不再跨进程，由 WebCodecs 解码、WebGL canvas 渲染。
控制协议完全由 Tango 的 `ScrcpyControlMessageWriter` 序列化（应用只做 DOM 事件 → writer 入参的映射）。

自研引擎是启动镜像的**唯一**形态（原 scrcpy 引擎与随包 8.6MB 二进制已于 2026-09-16 删除）。
参数里那个 `engine` 字段（以及"引擎可切换"这件事的最后一丝痕迹）**已于 2026-09-28 彻底删除** —— 老存盘文件里残留的
`engine` 键由 `normalizeScrcpyConfig` 静默丢弃，不需要迁移。读到这句话时别以为还有回退开关。

主进程只承担：创建镜像窗口、下发启动参数（渲染层 invoke 拉取）、
维护会话记录（渲染层 ready/exit 上报）与断开/退出时关窗销毁。

## 2. 现状（已完成）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 协议与连接 | `src/mirror/connect.js` | Tango 官方 `AdbServerNodeJsClient` + `AdbScrcpyClient`；push server、`AdbScrcpyOptions4_0`、scid 由官方库直接处理 |
| 编码能力 | `shared/scrcpyConfig.js` + `src/utils/codecCaps.js` + `src/composables/useCodecCaps.js` | 设备侧扫 `media_codecs*.xml`（`electron/adb.js` 的 `getDeviceVideoCodecs`，按序列号缓存、断开时清），本机侧 `VideoDecoder.isConfigSupported`；两头的能力表喂给 `resolveVideoCodec` 落地 `auto`，设置页与启动对话框用它标记下拉项 |
| 参数映射 | `electron/mirror/options.js` | `ScrcpyConfig` → scrcpy 4.1 选项；不干预设备屏幕（原「屏幕策略」三选已于 2026-09-29 删除：`keepActive` 不再下发，`setDisplayPower(false)` 那条控制消息也删了）、恒定 `flexDisplay`（`--flex-display`，窗口 resize → 官方 `resizeDisplay` 控制消息）。虚拟显示初始尺寸与后续跟随尺寸都由渲染层按 `窗口 CSS × 画质档位倍率` 计算（`shared/scrcpyConfig.js` 的 `computeDisplayMetrics`，档位表 `DISPLAY_QUALITY_TIERS`：compat 1.5 / native 2 / sharp 3，会话建立时定死），dpi 同步乘，于是 **1dp = 1 CSS px**、画面比例恒等于窗口比例。镜像只有大屏一种形态，不再压 600dp dpi 下限、也没有平板 1.5x（两者都已删除），见 §P3「真横屏虚拟显示」。**这条等式只在同一个会话内成立**：`resizeDisplay` 只带宽高、不带 dpi，而 dpi 在建显示时定死，所以档位取自开会话时那份 config 并整场不变，中途换档不会改变已开的窗口（详见 `shared/scrcpyConfig.js:56-59` 的注释与 [`TODO.md`](TODO.md) §3）|
| 显示跟随去重 | `src/mirror/displayFollow.js` | 只在尺寸**真的变化**时下发 `resizeDisplay`：初始尺寸已用于创建虚拟显示，重复下发会让服务端白走一次 `virtualDisplay.resize()` → capture reset，设备侧应用随之重新决定方向（表现为画面反复旋转）；**停手 `RESIZE_SETTLE_MS`（250ms）后才发最终尺寸**（debounce，不是 throttle）。见 §3 排查记录 |
| 息屏协同保活 | `electron/mirror/miProjection.js` | HyperOS 在息屏时会停止合成那块虚拟显示（画面定住）。做法照小米互联：开会话往 `Settings.Secure` 写 `synergy_mode=1`（等价于它的 `beginSynergy()`），关会话写 0。**每个 MIUI/HyperOS 会话都生效**，且置位必须赶在息屏之前落地。机制与取证见 §3 排查记录 2026-09-29 |
| 会话生命周期 | `electron/mirror/session.js` | 窗口管理、会话记录、断开/退出清理；`src/mirror/session.js` / `direct-session.js` 与官方流的接线；横屏虚拟显示由随包 server 的 `VirtualDisplayConfig` 开关决定，见 §P3「真横屏虚拟显示」 |
| 输入控制 | `electron/mirror/control.js`、`src/mirror/useMirrorInput.js` | 单指触控、滚轮、键盘（特殊键 + 文本注入）；序列化全在 Tango（`injectTouch/...`），Android 键值/metaState 用官方 `AndroidKeyCode` / `AndroidKeyEventMeta` / `AndroidMotionEventAction` 常量。**系统动作键、旋转、通知栏、息屏亮屏这类 `kind:'action'` 消息已于 2026-09-28 按产品决策整体删除**（设备屏幕现在完全不干预，`setDisplayPower` 那条直调也已删除）|
| 解码渲染 | `src/mirror/App.vue` | WebCodecs 解码；`AutoCanvasRenderer` 优先 WebGL，按显示尺寸出图；HUD 诊断 |
| 音频转发 | `src/mirror/audio.js` | scrcpy 服务端 Opus → WebCodecs `AudioDecoder` → AudioContext 排程播放；音频不可用时自动降级纯画面 |
| 会话管理 UI | `src/composables/useScrcpySessions.js`、`src/components/ScrcpySessions.vue` | 与 scrcpy 会话合并展示，支持聚焦/关闭/全部关闭（2s 轮询主进程会话记录，见 [`TODO.md`](TODO.md) §5.1） |
| 无界面调试 | `scripts/mirror-spike.mjs` | `pnpm mirror:spike <serial> [h264\|h265] [raw-out] [秒数]` |

### 2.1 关键约束

- **协议层依赖 Tango beta**：scrcpy 4.0 / **4.1**（`AdbScrcpyOptions4_1`，VP8/VP9 与 `getEncoders`）都在 `3.0.0-beta.2` 里，版本已在 `package.json` 锁定，升级需回归。
- **全用官方库、同一模块副本**：渲染层所有 `@yume-chan/*` 包必须经 preload 注入的
  `window.require` 获取（`sandbox:false` + `nodeIntegration`）。Vite 静态打包镜像侧的
  `@yume-chan/*` 会产生第二份模块实例，stream 内部类（`PushReadableStream`、
  `MaybeConsumable`）跨拷贝时写流会挂死——此坑已验证，改代码时务必保持
  `src/mirror/connect.js` 不静态 import 原生包。
- **编码**：设置里默认 `auto` —— 由「设备能编 + 本机 WebCodecs 能解」两头挑（H.265 优先）。清单 = 随包 server 的 `VideoCodec.java`，
  4.1 起含 **VP8 / VP9**（`c2.android.vp8.encoder` 真机出过帧）；**AV1 / VP8 / VP9 都不进自动档** —— AV1 没验过，VP8/VP9 设备上多是软件编码器，自动挑过去就是拿延迟换码率。
  设备侧能力 = 扫 `media_codecs*.xml` 里 encoder 行的 mime（`parseEncoderMimes`，多 SKU 取并集，**可能多报**），
  本机侧 = `VideoDecoder.isConfigSupported` 探测。已知格式全在 `VIDEO_CODEC_CATALOG` 一张表里（10 项，
  `protocol: true` = 随包 server 的 `VideoCodec` 枚举里有位置）；**下拉只列「协议认得 ∩ 设备能编 ∩ 本机能解」**，
  设备多出来但带不动的（APV / H.263 / Dolby Vision / MV-HEVC…）不进下拉，也**不在 UI 里逐条列**
  （2026-09-29 用户原话：「没必要这么多说明，不会有人看的」，副标题只剩一句「投屏协议」）。
  这套筛选是纯函数 `planCodecList`（有单测），组件只渲染。
  某一头整表没探测到（null）按未知放行，不因为探测失败把能用的藏掉；存盘里的值在当前设备不可用时
  仍列出来、标灰并写原因，不让下拉对着空选项。
  `auto` 只活在设置里：`buildMirrorOptions` 收到没解析过的 `auto` 直接抛错，不留静默兜底。
- **音频仅 Opus**：scrcpy 服务端的音频链路只支持 `opus`（`ScrcpyAudioCodec.Opus`），WebCodecs 直接解码；配置包是 `OpusHead`，preskip 在播放侧裁掉（`src/mirror/audio.js`）。音频不可用（disabled/errored）时自动降级纯画面。
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
  - ⚠️ 2026-09-28 起**不要再走 `kind:'action'` 那条路**（整套已按产品决策删除，见 `electron/mirror/control.js` 顶部）。返回已有键值（`KEY_CODES.back`，`Esc` 在用）；中键→主屏需要时直接给 Tango `controller.injectKeyCode` 传 `AndroidKeyCode.AndroidHome`，别去恢复动作键那层
- [ ] **多指触控 / 捏合缩放**（当前 `pointerId` 固定为 0，仅单指）
  - 验收：地图/图片可双指缩放

### P2 会话与窗口

- [ ] **镜像窗口截图保存**：`decoder.snapshot()` → 主进程保存对话框/写文件
- [ ] **会话列表增强**：重开、截图、切换置顶等快捷动作（`ScrcpySessions.vue`）
- [ ] **窗口尺寸/位置记忆**：按应用或全局记住上次窗口大小
- [ ] **设备断线自动重连**：复用 `electron/adb.js` 的重连逻辑，会话级恢复

### P3 引擎收尾

- [x] **虚拟显示跟随窗口**（2026-09-16 完成，2026-09-17 改为默认行为）：恒定 `flexDisplay` 服务端选项 + 官方 `resizeDisplay`，窗口尺寸变化即重排虚拟显示；对话框不再暴露 `newDisplay`/`renderFit`，虚拟显示尺寸按窗口 × 倍率计算（1dp = 1 CSS px；当时是常量 `DISPLAY_PIXEL_SCALE`，2026-09-23 起改为画质档位 `DISPLAY_QUALITY_TIERS`；倍率不再跟 devicePixelRatio，理由见下面「px 写死的控件」）

- [x] **跟随请求去重**（2026-09-19 完成）：启动阶段不再补发与 `newDisplay` 完全相同的 `resizeDisplay`，窗口拖动期间的多次变化合并为一次（`src/mirror/displayFollow.js` + `tests/mirror/displayFollow.test.js`）
- [x] **拖宽时画面反复重排 → 改成停手才发**（2026-09-19）：原来的 150ms 是 **throttle**（第一次变化起计时，期间每 150ms 仍发一条），拖一次宽度要发十几条。真机量过：每 150ms 发一步把 920 宽拖到 1880，服务端 300ms 去抖**并没有**合掉中间值，每一步都真的改了显示 → app 每一步重新决定布局（`≤1560x1800` 跟着填满，`1720x1800` 翻成固定比例竖条 + 左右黑边，`1880x1800` 又重排），就是「转好几次」。改成 **debounce**（每次变化都把定时器推后，`RESIZE_SETTLE_MS = 250`），一次拖拽只剩最后一次重排。
  - 剩下的那一次重排仍然看得见（画面跳一下/翻一次），用户否掉了「不越过方向」「不跟随窗口」「重编 server 抹 flag」三条（都会牺牲跟随或引入黑边），选了**遮罩**：`src/mirror/App.vue` 里 `covering` + `showCover/hideCover` —— 窗口比例与当前画面比例差超过 2%（`aspectDiffers`，容差防止抖动就盖）时盖上遮罩（`.mirror-cover`：不透明径向渐变 + 居中小胶囊「转圈 + 调整画面尺寸…」；毛玻璃被否掉 —— 模糊挡不住整体位移，透明度低于 ~95% 就看得见闪烁。出现 90ms、淡出 320ms，元素常驻只切 opacity 才有渐变消失）。**盖上/揭开的时机（2026-09-20 改过一次）**：先做过「一有尺寸变化就盖」，当时被否（`resizeDisplay` 还没发，盖住的是什么都没发生的一段时间）；改成在 `createDisplayFollower` 真正下发的那一刻由 `onReflowStart` 通知页面盖。真横屏落地后（拖一次只剩一次重排）用户又要求回到**手一拖就盖**，所以现在是：`createDisplayFollower` 每次收到尺寸请求都回调 `onIntent` → 页面盖并把总兜底线往前推（慢拖超过 3s 也不会中途露出），真正下发 `resizeDisplay` 与否不再影响盖的时机；停手合并后如果发现尺寸其实没变（拖出去又拖回来）回调 `onSkip` → `cancelCover` 立刻撤罩。揭开不用「第一次画面尺寸变化」，而是等尺寸**连续 420ms 不再变**（设备往往先翻方向再改尺寸，看到第一次就揭会露出旋转），另有 3s 总兜底。同比例的纯缩放不触发遮盖（`aspectDiffers` 容差 2%），解码器报回新画面尺寸（`sizeChanged`）后 180ms 揭开，另有 3s 兜底自动揭开（设备没回传也不能一直盖着）。
- [x] **虚拟显示比例吸附（已回退）**（2026-09-19 试错）：曾把显示尺寸吸附到横 16:9 / 竖 9:16 的内接盒，当天回退。黑边的真正变量不是比例，而是 **Android 的 600dp 大屏门槛**：`smallestWidth ≥ 600dp` 时系统判定大屏并**忽略 app 的方向锁**，锁方向的 app 走 size-compat 被 letterbox 在帧内（双层黑）；`sw < 600dp` 时锁被尊重，`FLAG_ROTATES_WITH_CONTENT` 让显示跟着 app 转，app 填满帧。实测（Redmi 2509FPN0BC / Android 17 / 抖音）：`1920x1080/320`(sw540) 与 `3424x1926/640`(sw481) → 转竖填满；`3424x1926/320`(sw963) 与 `1920x1080/160`(sw1080) → 保持横并 letterbox。`flexDisplay` 对该行为无影响（A/B 过）
- [x] **真横屏虚拟显示（大屏 / pad 的唯一形态）**（2026-09-20 落地）：随包的 `resources/scrcpy/scrcpy-server` 换成**我们自己编的 scrcpy 4.0**，它建虚拟显示时走隐藏的 `VirtualDisplayConfig` 路径并打开 `setIgnoreActivitySizeRestrictions(true)`，于是固定竖屏的 app 在横形逻辑尺寸的虚拟显示上**真的按横屏铺满**，不再被 size-compat 压成中间一条竖屏带。窗口初始尺寸**固定 850x600**（`mirrorWindowBounds`，2026-09-29 用户改口：不再按设备宽高比算；之前那套「长边封顶 1000 CSS px、留 80 边距、查不到分辨率按 9:19.5 兜底」已作废，也因此开会话时不再查设备分辨率）。
  - 机制来源：对照 AndroMeld Fusion 的虚拟显示（`dumpsys window displays` → `DisplayWindowSettingsProvider SettingsEntry{... mIsHomeSupported=true, mShouldShowIme=0, mForceAppsUniversalResizable=true}`，我们的显示这一项是 `null`）。该字段由 `VirtualDisplayConfig.Builder#setIgnoreActivitySizeRestrictions` 写入（HyperOS/Android 16 里 dump 名作 `mForceAppsUniversalResizable`，服务端读作 `shouldIgnoreActivitySizeRestrictionsForDisplay`）。它的 `uniqueId` 形如 `virtual:com.android.shell:andromeld-fusion-<uuid>` 也来自 `VirtualDisplayConfig.Builder#setUniqueId`。
  - **单变量对照（同一台机、同一显示几何 `2462x1924/256`、抖音冷启动）**：开关开 → `sw1203dp w1539dp h1113dp 256dpi land`，`mBounds == mAppBounds == mMaxBounds == Rect(0,0-2462,1924)`；开关关（只走 config 路径）→ `sw985dp w985dp h1112dp port`，`mBounds=Rect(443,0-2019,1924)` 竖条。
  - **不动主屏**：全程没有 `wm size`/`wm density`、没有 compat 开关、没有 force-stop + 重启 app。开会话前后 `wm size` 都只有 `Physical size: 1200x2608`（无 Override），手机本体画面不变，之前「先在手机上打开 app 又消失」的闪动随配方一起消失。
  - 开关位置：server 侧 `debug.anddrive.vd.isr`（默认 `"1"` 生效，设 `0` 可临时关掉做对比）；系统没有该 @hide API 时 `NewDisplayCapture` 自动退回公开 `createVirtualDisplay(name,w,h,dpi,surface,flags)`，老设备不受影响。
  - 重编方式（改动在 `NewDisplayCapture.startNew` 与 `wrappers/DisplayManager.createNewVirtualDisplay(..., ignoreActivitySizeRestrictions, homeSupported)`）：
    `cd /Users/xh/code/scrcpy-4.1-patched/server && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=~/Library/Android/sdk ANDROID_PLATFORM=36 ANDROID_BUILD_TOOLS=36.1.0 BUILD_DIR=/tmp/vd-build ./build_without_gradle.sh`，产物 `/tmp/vd-build/scrcpy-server` 覆盖到 `resources/scrcpy/scrcpy-server`。替换前已用同一份 client 链路验证视频（h265）+ 音频（Opus，6s 内 245 个音频包）+ `new-display` + `startApp` 全部正常。
  - **升级到新版本 scrcpy 的做法（2026-09-29 从 4.0 → 4.1 走过一遍，可复用）**：我们的补丁只碰**两个文件** ——
    `video/NewDisplayCapture.java`（三个 `debug.anddrive.vd.*` prop 钩子 + flags 日志 + 无 VirtualDisplayConfig 时的回退）与
    `wrappers/DisplayManager.java`（反射 `VirtualDisplayConfig.Builder` 的那条 `createNewVirtualDisplay(..., ignoreActivitySizeRestrictions, homeSupported)` + `tryOptional`）。
    步骤：下载**上游同版本**与**旧版本**源码 → `diff -u --label a/... --label b/...` 从旧 patched 树抽出补丁 → 在新版本树里 `patch -p1`（4.1 两处上下文没变，直接过）→
    `BUILD_DIR` 要先 `mkdir`（脚本不会自己建）→ 编出的 server 版本烤成 `SCRCPY_VERSION_NAME`，**客户端必须同步换 `AdbScrcpyOptions4_x`**，否则版本对不上。
    验证：server stdout 里要看到 `anddrive vd flags=0x… ignoreSizeRestrictions=true`，这行在就说明补丁没丢。
  - 同时删除：`electron/mirror/padMode.js`（compat + 物理屏改写 + 重启轮询那套配方）、`mirror:padMode` IPC、`LARGE_SCREEN_COMPAT` 常量、`adb.js` 里只为配方服务的 `setLargeScreenCompat` / `overrideDisplayGeometry` / `resetDisplayGeometry` / `getAppWindowGeometry`。
  - 已删的历史方案：`tablet` 平板模式（1.5x 上报）与「dpi 下限把 sw 钉在 600dp 以下」的小屏方案；`computeDisplayMetrics` 就是 `窗口 × DISPLAY_PIXEL_SCALE` + `dpi = 160 × DISPLAY_PIXEL_SCALE`，即 1dp = 1 CSS px。旧参数存盘里的 `tablet` 字段由 `normalizeScrcpyConfig` 静默丢弃。
  - **px 写死的控件 → 倍率现在做成「画质档位」`DISPLAY_QUALITY_TIERS`（compat 1.5 / native 2 / sharp 3，默认 sharp = 老行为）**：抖音有一批控件按 px 写死，顶部那排 tab 最明显 —— 真机量过 dpi 480 下它的字高只有 ~16 物理像素（14sp 本该 42），且 `settings put system font_scale 1.3` 对它**完全无效**（前后两帧一模一样，抖音不吃系统字体缩放）。唯一能动它的是「同样 dp 少给像素」：倍率减半、dp 不变（布局完全一样），那排字相对画面大一倍；对照实验是同一块 588dp 显示的 `1766x2412` 与 `882x1206` 两帧。**但倍率 1 会把整帧放大 2 倍铺到 Retina 背衬上**，用户实测「不光字不清晰，整个画面都不清晰」→ 定回 2（清晰度优先），字随之回到小。两个诉求物理上顶着，只能选落点（1.5 是中间档）。2026-09-20 真横屏之后用户反馈「抖音上边文字有点大」→ 抬到 **2.5**（那排字小约 20%，dp 布局不变；超过 2 属于过采样，码流按平方涨，觉得发软就回 2）。
    还剩一条**未验**的两全路子：那排字也可能是按**物理屏 density**（恒 480）算的而不是真写死 —— 若是，开会话时临时抬 `wm density` 就能撑大它同时保住 2 倍像素。这条要手机处于解锁状态才能测（设备有锁屏密码，adb 的 swipe 解不开）。
  - 未验：只有竖屏排版、没有宽布局的 app 在横形显示上会怎样（大概是被拉成横屏后排版变形）；真机反馈后再决定要不要按包豁免。
  - 已回退的历史结论（2026-09-19 记录，2026-09-20 推翻）：当时判断「Android 16 只认物理屏为大屏，所以 compat 只在物理屏生效、虚拟显示拿不到横屏」。那是对**没有** `ignoreActivitySizeRestrictions` 的显示做的四种顺序测量得出的，结论只适用于官方 scrcpy 的创建方式。
- [x] **同一设备 + 同一应用只开一个镜像窗口**（2026-09-20 完成）：一个会话 = 一块虚拟显示，同一应用开两个窗口时后建的那块会把应用搬走（真机量过：`startApp` 之后应用窗口从 138 挪到 139，**138 上只剩 MIUI 的 `SecondaryDisplayLauncher`**），先开的窗口变成一块没人用的启动器镜像 —— 就是「两个窗口抢同一条画面」。现在 `startMirrorSession` 先用 `findAppSession`（`electron/mirror/appSession.js`，纯逻辑 + 单测）按「设备 + 包名」查已有会话，命中就 `focusMirrorSession` 把它唤到前台并返回 `reused: true`，不再建第二个窗口；窗口记录还在但窗口已销毁时 `focus` 抛错，就照常新建。
  - 另一条路（参照 app 的「直接把同一块显示看走」）：**采集**别人的虚拟显示是可行的（AndroMeld 就能直接显示我们这块显示上的画面），做不到的只有 **resize 与销毁** —— `VirtualDisplay` 与创建它的进程绑死，只有属主办得到。所以多窗口共览一块显示仍然需要一个常驻持有者，这一档暂不做。
- [x] **无缝接回被别处拿走的应用**（2026-09-20 完成）：应用可能挂在别的显示上 —— 被另一个投屏软件搬走，或本来就在手机主屏上用着。这种时候 `startApp` 只把它留在原处（真机量过 `am start --display <id>` 对**已存在的 task 不改显示**），本窗口就只剩启动器画面。现在的做法是**搬任务、不重启**：`adb shell am display move-stack <taskId> <displayId>`（`electron/adb.js` 的 `moveAppTaskToDisplay`），taskId/当前显示从 `getAppTask` 读（`dumpsys window windows` 里应用窗口的 `mDisplayId=.. taskId=..`），本会话的显示 id 从 server stdout 的 `New display: WxH/D (id=N)` 解析（`direct-session.js` 的 `current.displayId`，stdout 是异步到的所以 `ensureAppHere` 会等它并重试 4×400ms）。
  - 真机验证（抖音被 AndroMeld 的显示 118 占着时开我们的镜像）：pid 30912 → **30912 不变**、taskId 22409 不变，窗口从 118 挪到我们的 147，`mBounds=Rect(0,0-812,1764)` 铺满 —— 进程与页面状态都留着，不是重新启动。
  - 手动入口：**只在画面被抢走时**出现在画面正中间（`.mirror-reclaim`：应用图标 + 「接回画面」，45% 黑底；图标取自启动参数 `pendingInit.iconUrl`（开会话时由 `startMirrorSession` 的 request 带进来，`.adr` 唤起则接力快捷方式里那份），没有就退化成首字母方块 —— 镜像页**不再读整台设备的图标缓存**）。检测靠 `watchAppStolen` 每 2.5s 查一次应用还在不在本会话这块显示上（`document.hidden` 时跳过），状态翻转才回调页面；**只亮入口、不自动搬**，自动搬回去等于两边来回抢。接回结果走底部一次性提示（已接回画面 / 画面已经在这个窗口 / 失败原因）。
- [x] ~~镜像窗口「重新启动」按钮~~（2026-09-20 当天加了又删）：`force-stop` + 冷启那颗按用户要求**去掉**了 —— 它和「接回」是两件事，并排放着会误点成重新加载。要救挂死的应用目前只能关窗重开。
- [ ] **剪贴板同步（2026-09-21 做过一版，按用户要求整条撤掉，先不做）**：链路上能用的部分都已验证 —— `SET_CLIPBOARD{sequence,paste}` 客户端写入 + ACK、`client.clipboard` 流（服务端 `clipboardAutosync` 注册的 `addPrimaryClipChangedListener`）。**没验证成功的是"到底哪一头被挡"**：服务端写完立刻同进程回读拿到 `null`，但这一条判据分不清「读被挡」与「shell 的 `setPrimaryClip` 根本没落地」，不足以下"ROM 挡剪贴板"的结论（我当时据此说 ROM，被用户驳回，记录在此免得重犯）。参照 app 的实现供参考：它**不靠 shell 读**，而是拉一个透明无动画的 `ReadClipboardActivity` **借前台焦点**读，再通过广播里塞进去的 IBinder 直接 `transact` 回传给 shell agent（helper 也回赠自己的 Binder 建立双向通道；日志 tag 还叫 `AndDriveReadClipboard`）。真要做，走这条路，别改 appop（`READ_CLIPBOARD` 本来就是 allow）。

- [x] **⌘Q 在镜像窗口上只关这个窗口**（2026-09-21 完成）：以前没装应用菜单，用的是 Electron 默认菜单，Quit 就是 `app.quit()` —— 焦点在镜像窗口按 ⌘Q 会把整个程序带走。现在 `electron/menu.js` 装了自定义菜单，「退出」项自己判断焦点窗口：是镜像会话的窗口（`isMirrorWindow`）就 `win.close()`，否则才真退出；另留了「退出 AndDrive（全部窗口）」= **⌥⌘Q** 作为硬退出。`installAppMenu()` 在 `app.whenReady()` 里、建窗口之前调用（晚于窗口就会被默认菜单抢先）。注意 macOS 语义：镜像窗口关完后若一个窗口都不剩，程序仍留在 Dock（`window-all-closed` 不退出，点图标走 `activate` 重开主窗口）。
- [x] **镜像窗口绿色按钮 = 全屏**（2026-09-19 完成）：`electron/mirror/session.js` 显式 `fullscreenable: true`。Electron 44 上只要构造时显式传了 `fullscreen`（未勾「全屏启动」即 `false`），窗口就被标成不可全屏，macOS 绿色按钮退化成 zoom（最大化、保留菜单栏）；置顶与全屏启动两种组合下均已验证为可全屏
- [ ] **设备侧旋转的剩余观感**：虚拟显示带 `VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT`，方向由设备上的应用决定；应用自身在启动过程中换向（例如抖音）仍会让画面转一次。可选缓解：`--no-vd-system-decorations`（不渲染虚拟显示里的 launcher/系统装饰）、或把启动应用放到服务端侧，避免「先显示 launcher 再启动应用」这段换向窗口

- [x] **音频转发**（2026-09-16 完成；2026-09-21 修两处）：scrcpy 服务端 Opus → WebCodecs `AudioDecoder` → AudioContext 排程播放，preskip 裁剪、落后丢帧。
  - **音频开关以前是死的**：`buildMirrorOptions` 把 `audio: true` 写死、完全不读 `config.audio`，所以设置页那个开关没有任何作用（实测存盘 `audio:true` 也掩盖了这点）。现在按设置下发，关掉的会话不建音频采集。
  - **投屏时手机静音是刻意的**：服务端 `AudioPlaybackCapture(keepPlayingOnDevice)` 为 false（scrcpy 默认，即不传 `audio_dup`）时给 `AudioMix` 设 `ROUTE_FLAG_LOOP_BACK` —— 只回环、**不在本机渲染**，所以声音只在电脑上出。用户 2026-09-21 明确要求「投屏时手机不要发出声音」，因此我们不开 `audioDup`。要知道的副作用：会话结束、AudioPolicy 撤销后手机恢复渲染，正在播的内容会当场出声（这正是「电脑上结束投屏，手机立马响起声音」的由来，不是 bug）；要两边同时出声才需要 `audioDup: true`（`ROUTE_FLAG_LOOP_BACK_RENDER`）。真机验证过两种都能跑：`c2.android.opus.encoder`、5 秒 253 个 Opus 包。
  - 默认值仍是**关**（`DEFAULT_SCRCPY_CONFIG.audio = false`，早先实际行为等于常开）；要声音去设置页打开「音频转发」。
- [x] **渲染层直连**（2026-09-16 完成）：镜像窗口 `nodeIntegration` + 官方 Tango 库直连 adb server；去掉主进程 per-packet 转发（曾做 ws 桥方案后替换为官方 connector）
- [ ] **AV1 进自动档**：真机验过设备编码 + 本机硬解之后，把它加进 `AUTO_ORDER`（现在只能手动强选）
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

排查记录（2026-09-22 窗口拖大后画面被切 / 超出窗口）——**2026-09-28 结案：用户已找到原因，不再追查；根因未记入本仓库**：



1. 现象（用户描述，我全程没亲眼见到）：把抖音的镜像窗口往大拖，画面「超出屏幕 / 展示不完整」。**这句话至少有两种读法**：画面在窗口内被裁掉一圈，或窗口自己跑到 Mac 屏幕外看不见 —— 两种根因完全不同。下面这条记录只证明了「比例被裁」这个缺陷存在，**它不是用户的那个症状**。

2. 取证（可复用）：真机上起一个 flex display 会话，按档发 `resizeDisplay`，比对「请求尺寸」与 server 回传的 session 尺寸（`dumpsys display` 里 `virtual:com.android.shell,2000,scrcpy,<scid>` 的 logicalFrame 与之一致）。这台机器的 h265 上限是**短边 4320、长边 8192**：5600x5600 → 5600x4320、6800x4400 → 6800x4320、4320x9000 → 4320x8192。倍率 3 下窗口任一边超过 ~1440 CSS px 就会越界。注：`dumpsys media.codec` 在这台 ROM 上**没有服务**，查不到 caps，只能这样实测。

3. 顺带发现的一条真实缺陷：上游 `NewDisplayCapture` 对 flex display 用 `Size.constrain(constraints, false)` —— **逐维裁剪**，越界时只砍超的那一维，于是虚拟显示形状与窗口形状脱钩（5600x5600 变 1.296 比例）。这在正常窗口尺寸下不会触发（要某一维 >1440 CSS px），所以大概不是用户看到的那个。

4. 试过并已回退：把上述三处改成按比例收缩 `constrain(constraints, true)`，重建替换 `resources/scrcpy/scrcpy-server`。几何上确实生效（同一批请求 5600x5600 → 4320x4320、4320x9000 → 3932x8192，比例全保住；音频照常），**但用户实测症状照旧，所以整个改动已回退**（server 回到 85b7fb1 之前那份、fork 源码同步改回 `false`）。回退时顺便验了一件有用的小事：从回退后的 fork 源码重建，产物哈希与仓库里那份**逐字节相同**（`2df957b2…`，98893 字节），说明 server 构建是可复现的、源码树与随包二进制对得上。

5. 下一步该查什么（**2026-09-28 起作废**：用户已找到原因，两种读法不必再区分，根因未入库）：原先列的是——先弄清症状到底是哪一种；若是窗口跑到屏幕外/贴边 → 看 Electron 侧窗口边界（`electron/mirror/session.js` 的初始 `mirrorWindowBounds` 只约束**初始**尺寸，用户手动拖拽没有 workArea 上限）；若是画面在窗口内被裁 → 看 contain-fit 用的尺寸来源（`src/mirror/App.vue` `syncCanvasBox` 取的是解码器帧尺寸，与 `resizeDisplay` 之后的真实显示尺寸之间是否有一次没同步）。



排查记录（2026-09-22 大窗口画面卡 → 2026-09-23 干净复测定案）：

1. 现象：镜像窗口拖大后播放发卡。
2. 第一版结论（"11.5MP → 入站 33.8fps，降到 6MP 预算 → 67.9fps"）**作废**，两个测量错误叠加：
   - 手机上同时跑着**两个 `app_process` 采集会话**（用户自己那个 2784x2154 的镜像窗口 + 探针），
     并发抢编码器与 Wi-Fi。`ps -A -o PID,NAME | grep app_process` 数出 2 才暴露。
   - scrcpy **只在画面变化时出帧**：没有受控运动源时「每秒入站包数」量的是内容动静，不是设备能力。
     更早就还踩过第三个坑 —— `input swipe` 不带 `-d <displayId>` 会打到手机主屏，镜像画面根本没动。
3. 按 §4.0 重测（唯一会话 + 打开系统设置列表 + 来回匀速滑动 + 按秒统计入站包），三档实测：
   `1200x2400`(2.9MP) / `1600x3200`(5.1MP) / `2400x4800`(11.5MP) **稳态都是 60fps**，码率分别是
   ~5 / ~5.2 / ~27Mbps（最后一档吃满并越过设定的 24M 上限）。同尺寸把码率上限从 24M 压到 8M，
   帧率仍是 60（实测吞吐 21.0 → 13.6Mbps）。
4. **所以"像素多 → 掉帧"不成立，"卡"更可能出在 Wi-Fi 带宽被大突发打满**。落地改动：
   - 删掉建在坏数据上的 `MAX_DISPLAY_PIXELS` 面积预算，改成**画质档位**（compat 1.5 / native 2 /
     sharp 3，默认 sharp 保持老观感），设置面板可直接换档；`computeDisplayMetrics` 按档位算倍率。
   - 遮罩收尾改成**等关键帧**（`createReflowGate`：下发过 resize 之后要凑齐 configuration + 关键帧
     这一对，时间到了但没等到就再延 150ms，总时长仍被 3s 上限卡住）。
5. 未解的代价与下一步：scrcpy 的 `resizeDisplay` 不带 dpi，dpi 在建显示时定死 → **档位只在开会话时
   生效**（中途换档会造成 1dp ≠ 1 CSS px），所以 `displayFor()` 固定读会话建立时那份 config。
   AndroMeld 的 resize 命令带 dpi（三个 int w/h/dpi），我们要跟就得扩自己的协议 —— 那才能真正做到
   "拖窗口任意大也不掉清晰度/不漂移"。

### 2026-09-27~28 结案：抖音直播「上下裁」= 抖音按「设备类别」选版式，镜像侧无解（本文档相关代码已全部移除，仓库不留单 app 适配）

**结论先行**：裁切发生在抖音 App 内部（播放器 cover 稳态），与显示几何、虚拟性、ISR、镜像链路全部无关；
它在设备级判定里选「phone 分支」就永远 cover。非 root 手机无任何可行触发器，唯一出路是**换信源**
（平板 AVD / 真平板 / 折叠机，均已实测：同一条 AndDrive 链路直播版式天然正常）。

取证链（全部单变量，判据 = `dumpsys SurfaceFlinger` 里 visible 那层 live-player 的 `toDisplayTransform`，
`ty=0,tx≠0`=FIT / `ty=-(缩放高-显示高)/2`=CROP；截图走 `screencap -d <SF 显示 id>`）：

1. **平板 AVD 对照（Medium_Tablet / Pixel Tablet / Android 15）**：内置屏与 **scrcpy `--new-display` 建的虚拟显示**
   （sw700dp/800dp 横形，与手机上出裁切的几何完全相同）上直播都是 FIT 双列（视频竖列 + 弹幕列 + 信息列）。
   附带：AVD 上 `setIgnoreActivitySizeRestrictions` 不存在（NoSuchMethod，随包 server 静默回退公开 API）
   仍全屏 land → ISR 也不是门。
2. **root（KernelSU）复刻**：`resetprop` 整套指纹换 Pixel Tablet + `pm clear` 抖音 → 手机虚拟显示上出平板版式。
   单变量隔离矩阵：还原 model 仍平板（model 无关）；还原 `ro.build.characteristics` 掉回裁切（必要）；
   全还原只留 characteristics=tablet 仍平板（充分）。**改 prop 必须配 `pm clear`**（判定结果缓存在应用数据）。
3. **APK 逆向（jadx 拆 40.7.0，classes54/classes48）**：判定是两个「按品牌分发」的识别器——
   - `PadIdentifyUtils`：小米/Redmi = `ro.build.characteristics == "tablet" && isMiui()`；vivo = `FtDeviceInfo.getDeviceType()`；
     OPPO = `oplus.hardware.type.tablet` feature；华为 = `SystemPropertiesEx`；一加 = characteristics 列表；联想 = 4 个 prop；
     其他品牌 = characteristics &&（`screenLayout≥large` 或 **xdpi 对角线 ≥ 7.0″**）。结果缓存 Keva（`pad_identify`）。
   - `FoldIdentifyUtils`：小米折叠 = `persist.sys.muiltdisplay_type == 2`（一个 prop）；华为/荣耀 = posture PM feature；
     vivo = `FtDeviceInfo=="foldable"`；三星/OPPO 私有；**无通用兜底分支** → 折叠机走 `DuxWindowAdaptManager`
     的 `"fold_screen"` 形态进双列版式，全程不读 characteristics（用户「折叠机不依赖它」的判断被代码证实）。
   - 另有服务端 AB：`android_pad_model_white_list` / `PadModelBlackList`。
4. **非 root 判死**：`ro.*` 与 `persist.sys.*` 的 SELinux 标签（`system_prop`）adb shell（uid 2000）写不动
   （模拟器 user 镜像实测被拒）。手机上试过的替代触发器全部落空：显示 dpi/比例/对角线（含 1:1 方形）、
   真 freeform 多窗（`--windowingMode 5` + `cmd activity task resize` 横浮窗仍 CROP）、`cmd uimode car`、
   物理屏 `wm density`、「屏幕镜像：大屏扩展播放中」（那是投屏遥控面板的起播前瞬态，视频一起播就回 cover）。
5. **平板 AVD 当信源的工程注意**（模拟器编码器与真机不同）：
   - **h265：建显示 3000x1800 没问题，但 `resizeDisplay` 完全不生效**（任意尺寸静默失败）→ 模拟器信源会话
     要么固定显示尺寸不跟随，要么走 h264。
   - h264：resize 生效但**高度被钳到 ≤1024**（2000x1200→2000x1024，比例丢）→ 显示尺寸要按设备上限**等比**预钳。
   - 快照易被强杀打坏（`goldfish_pipe`/`goldfish_address_space` 加载失败）→ `-no-snapshot-load` 冷启动可救。
   - WiFi 虚拟热点（AndroidWifi）会死（scan 空）→ `adb reboot` 救不回，需重启模拟器进程。
6. ~~**已知未落地的修复**~~ **已落地（2026-09-28）**：deep-link 冷启动开会话时初始虚拟显示 = 512x512/480 ——
   `startScrcpy` 读 `document.documentElement.clientWidth/Height` 拿到布局完成前的占位值。现在显示尺寸的公式只在
   `src/mirror/direct-session.js` 的 `displayFor(css)` 一处（`connect.js` 改为接收算好的 `display`），建显示用的
   CSS 由 `mirrorInitGet` 返回的 `initialCss`（主进程 `win.getContentBounds()`）给出，读不到才回落 DOM。

排查记录（2026-09-28 画面「卡住」三类根因 → 2026-09-29 **B2 已结案**）：

**判据与归因（三类，互不相同，别再混为一谈）**

| 类 | 签名 | 现状 |
| --- | --- | --- |
| **A 客户端断链** | `packets` 涨、`framesRendered` 停、`q ≤ 2`、无错误 | **未修**（我们这一侧的流/解码停摆，9-23 复现过签名） |
| **B1 系统收回** | 息屏瞬间 activity 窗口被搬回 display 0（**进程还活着**），虚拟显示上只剩 `SecondaryDisplayLauncher` | **未修**，只有手动「接回画面」入口（见 §P3）。MIUI/HyperOS 行为，**按 app 有别**（抖音收、计算器不收）；`monkey` 落点不固定，所以拉回要"拉起 + `am display move-stack`"两连 |
| **B2 停合成** | 窗口没被收、应用还在画（`gfxinfo` 涨）、客户端全健康，但虚拟显示合成静止；`cmd power wakeup` 立刻恢复 | **已修（9-29）**，机制与做法见下 |

**B2 的真机制（9-29 拆 `/system_ext/framework/miui-services.jar` + `/product/priv-app/MirrorOS4.apk`）**：
普通息屏时 PowerManagerService 给 SurfaceFlinger 发 `GOING_TO_SLEEP`，SF 就此不再驱动那块非交互显示 ——
于是画面静止，而客户端一切计数都健康。小米互联服务不受影响，是因为它在**会话建立时**调
`MirrorManager.beginSynergy()`，而那个方法只是往 `Settings.Secure` 写 `synergy_mode=1`
（HyperOS 的 `PowerManagerServiceImpl` 给它注册了 ContentObserver）。设备到 bedtime 时看见投屏登记为真，
就不走 sleep/doze，改走 `hangUpNoUpdateLocked(true)`：`mWakefulness` 进 `Hangup`（面板灭、keyguard 在，
但那一组永不进 Asleep/Doze），并给 SF 发 `DISPLAY_START_GOING_TO_HANGUP` → 合成继续。

> 所以这扇门是「**电源策略认不认这次会话是投屏**」，与 wakelock 无关 —— 这正是当年那七条 wakelock / doze
> 白名单救法全灭的原因，别再往那一层试。旧的「统一理论」（面板熄灭后只有活跃视频会话才继续驱动）**作废**：
> 抖音当时不卡与它是不是视频无关。

**我们的做法**（`electron/mirror/miProjection.js`）：每个 MIUI/HyperOS 会话都生效（不管屏幕是谁关的），
开会话写 `synergy_mode=1`、关会话写 0（关窗口、断开设备、⌘Q 三条路都走同一个还原）。
置位要赶在设备睡下去之前 —— 顺序是这套机制的全部要点，睡着后再补没人接。
设备已经睡下去了再补写是没人接的。真机验证（9-29）：超时灭屏、按电源键锁屏、锁屏状态下才起会话，
**三种时序都不卡**。

**一条要澄清的事实（9-29 顺手读到，别重复造）**：随包那份自编 server 在 Android 13+ 建虚拟显示时**已经**带上
`TRUSTED | OWN_DISPLAY_GROUP | ALWAYS_UNLOCKED | TOUCH_FEEDBACK_DISABLED`（`NewDisplayCapture.java` 里
`Build.VERSION.SDK_INT >= API_33` 那一段，14+ 再加 `OWN_FOCUS`），也就是「不依赖 MIUI 电源策略」的那半
**早就在我们的显示上**。因此：**「不卡了」到底该记给 `synergy_mode` 还是这块本来就独立的显示，没做过单变量对照，
不要当成已证**。要钉死就把 `vdSystemDecorations`/那组 flags 与置键分别关掉再测一轮。

**头部状态栏（9-29）**：`buildMirrorOptions` 里固定 `vdSystemDecorations = false`（scrcpy
`--no-vd-system-decorations`），镜像里不显示手机那条状态栏，整块显示留给应用。要知道的副作用：那块显示上
没有状态栏、也没有 launcher 兜底 —— 探针里应用没落上那块显示时拍出来是**纯黑**（不是坏了）。

**已经穷尽并判死的救法（结论仍有效，只是当时找错了层）**
- 「亮 1 秒再息屏」实测不成立（点按无效、哈希锁死）；单次 `cmd power wakeup` 后 **约 10s 必再睡回去**（强制息屏超时，`keepActive` 挡不住）。
- 隐形防 doze 的七条全灭：`PARTIAL`/每显示 wakelock、`stayon` + 假 AC（被电源键穿透）、`system_power_button_disabled`（被 HyperOS 无视）、`deviceidle disable`（只关 deep）、root 禁 PowerKeeper（照冻）、虚拟显示 power group（本来就 Awake，合成照冻）。
- **「息屏弹醒」那套（含 90s 冷却的最小版）因此不再需要，不要重做**；持续心跳同样已被否掉两次。
- 取证手法（两条假判据各踩过一次）：`cmd window user-rotation -d <id>` 每次都会**重建虚拟显示**（SF id 变）= 自己把冻结治好；`cmd uimode night` 对计算器不是运动源。可靠的判据 = `am start -W --display <id> -n <另一个应用>` 切应用，并且**每张截图前重取 SF id、断言它没变**。

**顺带一条与裁切问题相关的**：A 类与"卡住"无关的那次误判提醒 —— `input swipe` 不带 `-d <displayId>` 会打到手机主屏，
镜像画面根本没动（见 §4.0）。

**仓库现状**：本主题历史上产生过的单 app 适配代码（`padMode.js` 配方、`kickDisplaySize`、`relayout.js` 手动重排、
`frameProbe.js` 探针、`tablet` 模式、按包豁免等）**已全部删除**，镜像链路里不存在任何针对特定包名的分支；
仅注释与测试 fixture 中保留抖音作为历史取证示例。

## 4. 验证与排查

- 图形验证：`pnpm dev` → 连接设备 → 应用列表右键「启动镜像」（自研引擎是唯一形态，**没有引擎开关**）。
- 协议验证：`pnpm mirror:spike <serial> h265 /tmp/mirror.h265 15`，用 `ffprobe` 检查裸码流。
- 镜像窗口 HUD（仅 dev 显示，**在画面右侧的独立边栏里、不遮挡镜像内容**，字段名中文）：「WebGL」（是否可用）、「渲染方式」（webgl/bitmap、hardware/software 两个原值）、「已显示 / 已绘制 / 跳过绘制」、「解码队列」（decodeQueueSize）、「跳过解码 / 解码器重置」、「画面区 / 视频 / 尺寸变化」（画面区尺寸 / 视频尺寸 / 视频尺寸变化次数）、「视频包 / 接收字节」、音频那组「收到包 / 已播放 / 播放队列 / 已解码 / 时钟 / 状态」。
- 需要镜像窗口 DevTools 时设 `ANDRIVE_MIRROR_DEVTOOLS=1`（默认不开，避免影响性能）。

| HUD 现象 | 结论 |
| --- | --- |
| 「解码队列」长期 >0、「解码器重置」增长 | 解码跟不上：缩小镜像窗口 / 降 `maxFps` / 码率，或换 H.264 |
| 「WebGL 不可用」… `bitmap` | WebGL 被判定为软件渲染，回落 2D |
| 「跳过绘制」增长、「已显示」约等于「已绘制」 | 同一 vsync 内合并多帧（降延迟的预期行为） |
| 「收到包」>0 但「已解码」=0 | 音频解码未推进。**先怀疑我们自己的回调**：`audio` 计数是在把包交给播放器**之前**加的，所以回调里任何一次抛错都会让"包一直在收、解码永远为 0"（2026-09-28 就有一个正式版必踩的实例：一个 dev-only 闭包在生产是 `null`，抛错被 `pumpLoop` 的 `catch { break }` 吞掉 → 音频流直接不再读取）。查 `renderer` 控制台的未处理 rejection，别只对着 `AudioDecoder` /「状态」找 |
| 「状态」= `suspended` | 自动播放策略拦了 AudioContext：确认镜像窗口 `autoplayPolicy` 设置 |

### 4.0 帧率怎么量才不会自欺（2026-09-22 踩过才写下的）

- **先确认只有一个采集会话**：`adb shell ps -A -o PID,NAME | grep -c app_process` 必须是 1。并发会话会互相抢
  手机编码器与 Wi-Fi 带宽，任何 fps 数字都不可比 —— 我就是这么把一组 A/B 结论做废的。
- **必须有受控运动源**：scrcpy 只在画面变化时出帧，静止画面下「每秒入站包数」≈ 内容动静而不是设备能力。
  用固定节奏的滑动驱动：`adb shell "while true; do input swipe <cx> <y0> <cx> <y1> 200; done"`，
  坐标按显示尺寸取百分比，这样**不同分辨率下视觉滚动速度一致**，fps 才可比。
- 顺手记两个旁证：`dumpsys display` 里 `DisplayDeviceInfo{"scrcpy"… renderFrameRate …}`（显示自己的天花板），
  以及实测码率 bytes×8/秒 —— 「设了 24M 上限」不等于「跑满 24M」，静止内容只用 6-8Mbps。

### 4.1 快捷方式双击没反应 / 打开了旧版本

`.adr` 归谁处理由 LaunchServices 决定，构建机上很容易乱：**只声明后缀**时系统按扩展名现造
一个 `dyn.xxxxx` 动态类型，每个注册过该后缀的副本都平等地是候选处理者，谁最后被扫到谁赢。
本机实测曾有 47 个 AndDrive 副本（release/beta 下每个构建一个）都声称能开 `.adr`。

- 现在打包版在 `electron-builder.json` 的 `mac.extendInfo` 里声明正式 UTI
  `com.anddrive.mirror-shortcut` + `LSHandlerRank: Owner`（dev launcher 的 Info.plist 同步），
  不再依赖 `fileAssociations`（它只能生成后缀 + `Default` 等级，`mimeType` 在 mac 上被丢弃）。
  已用真构建验证：生成的 `Info.plist` 含 `UTExportedTypeDeclarations`，注册后 dump 里能看到
  `type id: com.anddrive.mirror-shortcut / tags: .adr / conforms to: public.data`，且 claim 记录为 `rank: Owner`。
- 清历史注册：`pnpm run shortcut:fix`（先加 `--dry-run` 看计划）。默认保留**最新的那个已安装**
  副本（release/ 下的构建产物只兜底），`--keep <app 路径>` 手动指定，`--all` 连 dev launcher 一起清。
  本机实测 47 → 3（正式版 + 两个 dev launcher）。
- 取证：`lsregister -dump | grep -B12 "bindings:                   .adr"`
  （`lsregister` 全名 `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister`）。
  正式版启动时还会顺手注销 dev launcher（含早期落在 `anddrive_next` userData 下的那份）。

## 5. 关键文件

```text
electron/mirror/
  options.js    ScrcpyConfig → scrcpy 4.0 选项、编码解析（auto 落地）、运行时偏好（纯函数，双端共用）
  control.js    DOM 语义事件 → Tango writer 入参映射（序列化在 Tango）
  session.js    窗口/记录生命周期、断开清理、异常退出通知（不做帧转发）
  miProjection.js  HyperOS「投屏登记」：会话期间置 synergy_mode，让息屏后 SF 继续合成（纯逻辑 + 单测）
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
