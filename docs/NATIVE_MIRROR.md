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
| 会话形态 | `electron/mirror/session.js` + `electron/mirror/options.js` | **两条判据决定采不采主屏**：`packageName` 为空（顶栏「镜像手机」），或设备 API 级别 ≤ 33（`mirrorsMainDisplay`，2026-10-09 加）—— 两种都**连 `new_display` 键都不发**，上游 `Server.java:144-149` 据此走 `ScreenCapture` 采主屏，随之没有可 resize 的显示、没有接回对象，用的也是官方那份 server。带着包名时 `startApp` 照发：没有新建显示时上游用 `display_id` 的缺省值 0 = 手机主屏，于是 13 及以下点应用 = **在手机上打开这个 app、我们镜像这块屏**。判据在主进程定成 `pendingInit.deviceMirror` 下发，渲染层不重复判断 |
| 编码能力 | `shared/scrcpyConfig.js` + `src/utils/codecCaps.js` + `src/composables/useCodecCaps.js` | 设备侧扫 `media_codecs*.xml`（`electron/adb.js` 的 `getDeviceVideoCodecs`，按序列号缓存、断开时清），本机侧 `VideoDecoder.isConfigSupported`；两头的能力表喂给 `resolveVideoCodec` 落地 `auto`，设置页与启动对话框用它标记下拉项 |
| 参数映射 | `electron/mirror/options.js` | `ScrcpyConfig` → scrcpy 选项（形状是 Tango 的 `ScrcpyOptions4_1.Init`；随包 5.0.1 server 的选项集与 4.1 逐字相同）；不干预设备屏幕（原「屏幕策略」三选已于 2026-09-29 删除）。**2026-10-07 起分两种模式，都带 `flex_display`（跟随窗口）**：默认（上游原生产物）`new_display` = 窗口画面区的**物理像素**（CSS × DPR）+ `scaleDisplayDpi` 按主屏长边等比算出的密度 —— 1 显示像素 = 1 屏幕物理像素（按 px 写死的控件不再被整帧压小），长边 dp 数与主屏一致（版式仍由设备决定）。**密度必须自己算**：上游只在非 flex 那条路做 `scaleDpi`，实测 flex 缺密度时 Android 退成基准 **160**（`756x1640/density 160` ⇒ 长边 1640dp = 被当超大屏），带上算出来的就是 `308`；设备密度读 `wm density` 的 Physical。窗口形状在建之前照设备画面比例 fit（`mirrorWindowBounds(screenSize, workArea)`）。拿不到设备信息时 `new_display` 退空串且**不开 flex**（flex 缺尺寸撞 `prepare()` 断言）。大屏模式（补丁产物）按 `窗口 CSS × 画质档位倍率` + 同倍密度，1dp = 1 CSS px；**这条等式只在同一个大屏会话内成立**（`resizeDisplay` 只带宽高、不带 dpi，dpi 在建显示时定死，所以档位整场不变；跟随后长边 dp 数会随窗口漂移 —— 两种模式都一样）。详见 `shared/scrcpyConfig.js` 的档位表注释与 [`TODO.md`](TODO.md) §3 |
| 显示跟随去重 | `src/mirror/displayFollow.js` | 只在尺寸**真的变化**时下发 `resizeDisplay`：初始尺寸已用于创建虚拟显示，重复下发会让服务端白走一次 `virtualDisplay.resize()` → capture reset，设备侧应用随之重新决定方向（表现为画面反复旋转）；**停手 `RESIZE_SETTLE_MS`（250ms）后才发最终尺寸**（debounce，不是 throttle）。见 §3 排查记录 |
| 息屏协同保活 | `electron/mirror/miProjection.js` | HyperOS 在息屏时会停止合成那块虚拟显示（画面定住）。做法照小米互联：开会话往 `Settings.Secure` 写 `synergy_mode=1`（等价于它的 `beginSynergy()`），关会话写 0。**每个 MIUI/HyperOS 会话都生效**，且置位必须赶在息屏之前落地。机制与取证见 §3 排查记录 2026-09-29 |
| 插电不休眠（keepAwake） | `electron/mirror/keepAwake.js` | **只 Android 13 及以下那档**：它采的就是手机那块屏，面板灭了不再产生新帧，而那个版本进不了 HyperOS 的 `Hangup`。做法 = 开会话把 `Settings.Global.stay_on_while_plugged_in` 写成 7（AC\|USB\|无线，等价 `svc power stayon true`），**先读原值、最后一个会话关掉时原样写回**；读不到原值就不动（这是用户的电源偏好，不是我们的东西）。同设备多会话按引用计数共用一次改写。竞品的对应实现是 helper 持 `WAKE_LOCK`（文案「保持设备唤醒」），我们这条零安装、零常驻服务。真机量过（Mi 10/A13）：写 7 → `mStayOn=true`，15s 超时到点后 50s 仍 `Awake`；只写 USB 位不生效（该机报的是 `AC powered`）。⚠️ **2026-10-11 修了这条还原的一个漏口**：scrcpy server 意外退出 / 设备断开时渲染层报的 `mirror:state` `exit` 原来只 `sessions.delete`，把还原函数连同记录一起丢了（详见「会话生命周期」那一行）—— 真机就观察到 `stay_on_while_plugged_in` 停在 7。**残留的用户可见症状（2026-10-11 用户报「退出镜像后手机亮度调到最低而且不灭」）**：`mStayOn=true` 时**超时那条路走不到 `goToSleep`**（`isItBedTimeYetLocked()` = `!isBeingKeptAwakeLocked()`，而后者含 `mStayOn`），于是显示策略停在**息屏前的 `policy=DIM`** 那一档不动 —— `dumpsys display` 实测 `mPowerRequest=policy=DIM`、`mBrightness=0.001709819`（**正好等于 `mScreenBrightnessDimConfig`**），同时 `mWakefulness=Awake`、`mWakeLockSummary=0x0`、`mUserActivityTimeoutOverrideFromWindowManager=-1`（排除了 wakelock 与某个 app 的覆盖）。**看起来像"亮度被调低了"，其实是"永远停在变暗档、灭不下去"**，写回 `stay_on_while_plugged_in=0` 后 `mStayOn` 立刻转 false、策略转 `OFF`、正常睡下（同一台机实测）。⚠️ 所以以后看到「亮度最低 + 不灭」先查这一格，别去翻亮度代码（全仓库没有任何写设备亮度的地方）。`electron/main.js` 的 `before-quit` 注释里记过同一个症状（`app.exit(0)` 跳过还原），那条路已经修好，这次补的是 `exit` 那条 |
| 关会话回桌面 | `electron/mirror/session.js` 的 `goHome` 调用 | **只「带着包名 + Android 13 及以下」那一档**（`session.returnsHome`）：那个 app 是我们 `startApp` 到手机屏幕上的，关掉 Mac 这边的窗口就该把它放回桌面（用户 2026-10-09 点名）。虚拟显示那档不动手机（app 在我们那块显示上，会话结束显示就销毁），整机镜像也不动（没有「我们打开的 app」）。命令用 `am start -a MAIN -c HOME`，**不用 `input keyevent KEYCODE_HOME`**：实测 MIUI 14 上焦点在 `NotificationShade` 时按键不生效，而 `am start` 不占 `INJECT_EVENTS`；失败静默（设备断开时必然失败，别拖住关窗） |
| 休眠提示与唤醒 | `src/mirror/sleepWatch.js` + `App.vue` | 轮询设备两条电源读数（`mWakefulness` + `dumpsys SurfaceFlinger` 的 `powerMode`），`Asleep`/`Dozing` 时窗口盖「已休眠」+「继续使用」（竞品同名的两格），点了发 `input keyevent 224` 点亮屏幕。**不自动弹醒**（手按电源键是用户的决定），`Hangup` 也不算休眠（灭屏仍合成），一次读失败当「不知道」不弹。轮询把**两条读数一起**报出来（`{ wakefulness, screen }`，任一变了就报、读失败那一拍只是跳过不断链），页面里「已休眠」= `FROZEN_STATES.has(wakefulness)`、长条那颗「关屏 / 恢复亮屏」= 面板读数不是 `ON`（没有面板读数时退回睡没睡），**页面不另记自己的状态**；第一次读也报（开窗那一刻手机已睡着时也要弹横幅）。⚠️ 那颗按钮**非看面板读数不可**：`setDisplayPower(OFF)` 只关面板、`mWakefulness` 全程 `Awake`，只看睡没睡就「再点一次点不亮」（用户 10-10）。慢档 1500ms + `kick()` 后快档 300ms（持续 5s 自动回落），点按钮 / 长条显形时 kick ⇒ 设备真变了 300ms 内就撤横幅（用户 10-10「不灵敏」）。⚠️ **按钮成功后不要乐观改读数**（命令被接受 ≠ 设备醒了，还会把轮询基线带歪）—— `wakefulness` 只有轮询一个写入点（用户 10-10「点亮屏幕已休眠按钮就消失了，但其实手机无法操作」）。**2026-10-11 补上 `Hangup` 那半个洞**（用户：「手机已经是关闭屏幕，打开镜像后悬浮栏上的关闭屏幕按钮并没有打开」）：`Hangup` 面板物理灭着，但 SurfaceFlinger **照旧报 `powerMode=On`**（合成还在跑）⇒ 原来只按「面板读数不是 `ON`」判屏灭就会把它当亮屏，那颗按钮永远翻不到「恢复亮屏」。真机（Mi 10 / HyperOS V816）实测：走**超时灭屏**（bedtime → `updateWakefulnessLocked`）后 `mWakefulness=Hangup` + `powerMode=On` 稳定保持；而**按电源键**（`goToSleep`）进的是 `Asleep` + `powerMode=Off`，且 `keepAwake` 写的 `stay_on_while_plugged_in=7` 让 `mStayOn=true` 时 bedtime 压根不来 —— 这两条正是前几轮「复现不出 `Hangup`」的原因。判据因此拆成两个集合：`FROZEN_STATES`（弹不弹「已休眠」）仍只有 `Asleep`/`Dozing`，新加的 `PANEL_OFF_STATES` = 冻结态 + `Hangup`，管「算不算屏灭」（`panelIsOff` 用它）。⚠️ 同时「恢复亮屏」在 `Hangup` 下**必须走真唤醒**：实测 `setDisplayPower(Normal)` 下发后 8 秒仍是 `Hangup`（它只改 SurfaceFlinger、唤不动电源管理），只有 `input keyevent 224` 一秒内回 `Awake` ⇒ 新加 `needsRealWake(state)`（判据 = `wakefulness !== 'Awake'`）分流；设备醒着时才走 `setDisplayPower`（那条不占 `INJECT_EVENTS`，比真唤醒稳，别改） |
| 会话生命周期 | `electron/mirror/session.js` | 窗口管理、会话记录、断开/退出清理；`src/mirror/direct-session.js` 与官方流的接线（bootstrap/会话/接回都在这一份里）；横屏虚拟显示由随包 server 的 `VirtualDisplayConfig` 开关决定，见 §P3「真横屏虚拟显示」。**收摊只有一个入口 `stopMirrorSession(id)`**（还原 `miProjectionRestore` / `keepAwakeRestore`、`releaseMacKeyboard`、关窗、`goHome`），关窗 / 断开设备 / ⌘Q / **server 意外退出**四条路都走它。⚠️ **2026-10-11 修**：`mirror:state` 的 `exit` 分支原来只 `sessions.delete(session.id)`，还原函数跟着记录一起被丢掉，之后窗口 `closed` 再调 `stopMirrorSession` 时 `sessions.get` 已经拿不到 session（`if (!session) return false`）⇒ 设备的 `synergy_mode` / `stay_on_while_plugged_in` 与 Mac 键盘归属**永远留在我们改过的值上**（真机证据：`stay_on_while_plugged_in` 停在 7）。现在改成 `void stopMirrorSession(session.id)`；与 `onDeviceTeardown` 撞上时谁先谁后都安全（后到的拿不到记录、自然空转），回归测试在 `tests/electron/mirrorSession.test.js` 的「server 意外退出」那一组 |
| 输入控制 | `electron/mirror/control.js`、`src/mirror/useMirrorInput.js` | 单指触控、滚轮、键盘（特殊键 + 文本注入）；序列化全在 Tango（`injectTouch/...`），Android 键值/metaState 用官方 `AndroidKeyCode` / `AndroidKeyEventMeta` / `AndroidMotionEventAction` 常量。`kind:'action'` 那套消息通道 2026-09-28 整体删除、**没有恢复**；但 2026-10-10 用户点名把 **返回 / Home / 多任务**（`kind:'key'` → `injectKeyCode`）和 **关屏使用**（`kind:'screen'` → `setDisplayPower`，`AndroidScreenPowerMode` 只有 `Off=0` / `Normal=2`，走控制 socket、**不占 `INJECT_EVENTS`**）放回右侧长条。音量 / 旋转 / 通知栏仍然没有入口，**自动**的息屏干预也没有|
| 解码渲染 | `src/mirror/App.vue` | WebCodecs 解码；`AutoCanvasRenderer` 优先 WebGL，按显示尺寸出图；HUD 诊断 |
| 窗口外观（右侧悬浮长条） | `electron/mirror/options.js` 的 `MIRROR_FRAME` / `MIRROR_RAIL` + `App.vue` 的 `.mirror-rail` + `src/mirror/chromeReveal.js` | **窗口本体透明**（`transparent:true` + `backgroundColor:#00000000`）：收起时看见的是**那块圆角屏幕 + 贴它外沿的一圈常驻黑色边框**（画在 `.mirror-frame` 的 `border` 上，不跟 hover 动）=「就是个手机样子」；⚠️ 镜像页共用 `src/styles/index.css`，那里 `#app` 有 `--color-canvas` 底色，会把透明窗口铺成一块浅色板（10-10 那两轮「一直有个框框」的真因），已在 `App.vue` 里 `:global(body #app){background-color:transparent}` 抹掉（⚠️ **必须带 `body`**：`main.js` 先 import 组件、后 import 全局样式，同特异度时后注入的赢）—— 以后"该透明却有颜色"先查 `#app`。鼠标**进到窗口右边那一格（86px）或顶带最上面那 12px** 才**原地淡入**（L 形两条臂，10-12 加的上臂；判据 `chromeZone`；⚠️ **10-13 起这层灰整块归一个元素 `.mirror-chrome`**：上臂 + 右臂 + 手机三个圆角外侧那三块同属一层、共用一条 `opacity`，见 §6.2「第四稿」）（只有 opacity，进来 180ms ease-out / 出去 260ms ease-in —— 用户 10-10：「不要从右侧往左展示，直接过渡展示出来就行」⇒ 没有任何位移/缩放；「消失的时候感觉不太协调」⇒ 出去慢一档），**离开那一格 1 秒后才收回**（判据：`chromeZone` 的进出两条线 + 迟滞，旧的格子 `pointerleave` + `isOutsideRect` 已废；进带 `poke()`、出带延 `RAIL_HIDE_DELAY_MS` 收，期间再进来撤掉计时）。**格子 86（占布局）**：窗口态面板**铺满那一格**（`width: 格宽`、无边距），底色透明、无阴影 ⇒ 它就是右边那条 chrome 臂本身（10-12「操作栏和边框写在一起」）；圆角 26 + 底色 `#fbfbfb` + 浅阴影那套白胶囊**只剩两档全屏**（那里没有灰臂，浮在亮底/画面上）。浅底深字图标不变。触发挂在 `.mirror-rail` **那一格**的 `pointermove` 上（面板收起时格子是命中层、显形时面板的 move 冒泡上来仍归它 ⇒ 不用按坐标筛，也吃不到手机上的点按）。**长条占窗口宽度**：`mirrorScreenInsets()` 右边 = `bezel + MIRROR_RAIL.width`、**上边 = `bezel + MIRROR_TITLEBAR.height`（28 → 32）**、左/下只有 `bezel`（**不对称是故意的**：右边那条是长条、上边那条是三颗与 app 名的地盘），那一格永远占着布局、显隐只动它自己那层面板 ⇒ 画面那块矩形不随 hover 动（否则 14+ 的跟随窗口会话每次 hover 都发一条 `resizeDisplay` 让手机重排）。**红绿灯只能整组平移**（间距/大小/横竖都动不了，实测整组约 58px 宽 ⇒ 格子宽下限就是它 + 两侧居中留白（现 86，`lightInset = 14`）），落点 `mirrorTrafficLightPosition()` 由主进程按当前窗口宽算，跟着长条一起开关（`mirror:windowButtons`）。⚠️ **它们没有淡出可跟** ⇒ 藏要延 `fadeOutMs`（260ms）等面板淡完，否则条还在半透明三颗就没了。⚠️ **每次 `setWindowButtonVisibility(true)` 之后必须再设一次位** —— 那一下会把三颗打回 AppKit 默认的左上角，构造参数的 `trafficLightPosition` 当场失效（10-10 探针实测，用户报的「彩虹按钮并没有靠右」就是它）。长条上现在排：**从上到下：红绿灯那一截（`lightTop` / `keysTop` 是他在真窗上调的手感值，现 18 / 50，`.mirror-rail__lights` 带一条下沿分隔线 ⇒ 读起来是「标题栏 + 按键区」两段）→ 「关屏使用」那一格 → dev 的 `tools` → 最底部才是返回 / Home / 多任务**（导航键 10-10 从顶部挪到底部，靠 `.mirror-rail__keys { margin-top: auto }`，不写绝对定位）。按键说明用 **reka-ui Tooltip**（`delay-duration=0` ⇒ 一移上就出、`side="left"` ⇒ 在按键左侧展开，样式照用户参照图 = **白底胶囊**（`TIP_CLASS`，`rounded-full bg-white text-black/75` + 软阴影 + `whitespace-nowrap` ⇒ 文案一行）；挂了它就把 `title` 去掉（否则双弹）；气泡里不放图标（Iconify 在 reka content 里渲染不出），条里也不留文字行（占位标签那版他说「没刚刚好看」已撤），三个导航键走**已有**的 `kind:'key'` → Tango `injectKeyCode`（`AndroidHome=3` / `AndroidAppSwitch=187`，**不起 adb 进程**；MIUI 上这条吃「USB 调试（安全设置）」那道闸，没开就是点了没反应）。**以后加的功能键排在长条以下**（竞品 `mirror.nav.{back,home,recents}`、`mirror.menu.add_control`「添加按键」）。拖窗口靠常驻的 `.mirror-dragstrip`（顶部 24px）—— ⚠️ 它现在**压在画面顶部**，代价是手机画面最顶那一条点不到。**⚠️ **全屏（绿色按钮 / 设置「全屏启动」）是另一种排法**（2026-10-10 用户拿 AndroMeld 的截图点单「抄过来」，同一晚再追三条「三颗别隐藏 / 右侧一直显示 / 背景别黑要亮」）：主进程把 `enter-full-screen` / `leave-full-screen` 推成 `mirror:fullscreen`（初值页面自己读 `pendingInit.prefs.fullscreen`），页面挂 `.is-fullscreen` ⇒ ① 长条那格**不挖窗口宽度、也不叠在画面上**，改成与画面**并排两格**（`minmax(0,1fr) auto`，贴右上角、按内容高 —— 10-11 先做过同格叠放，横屏时那块黑框一直顶到右沿把按钮压在画面上，已改；代价是画面中线比屏幕正中左移半条 = 43px）；② 黑框**按视频自己的比例收成手机那一块**（`aspect-ratio: var(--screen-ratio)`，比例由 `syncCanvasBox` 喂 —— ⚠️ 取 `meta.width/height` 不行，那是建会话那一刻的快照，实测那时上游尺寸还是 0）；③ 铺一块**亮底 `#d1e4e4`**（竞品那张图四周那圈浅薄荷，多点采样同一个值；⚠️ 全屏那一屏背后不是桌面，透明窗口在那儿就是一块黑）；④ 长条**常驻**（`opacity:1` + `pointer-events:auto`，特异度盖过 `.is-shown` ⇒ 不用动 `chromeReveal`），拖窗条与红绿灯那一截一起撤（真全屏里那三颗归系统，那一截=一块空白，10-11 他点名要去掉），顶边留白改面板 `padding-top`。⚠️ **那三颗红绿灯随系统，我们一个字节不动**：真全屏里它们被系统收进「移到顶边才浮出」，10-11 实测四条救法（`setWindowButtonVisibility(true)`、落定后再调、`setWindowButtonPosition(null)`、建窗口时压根不藏）像素扫描命中数全 0；试过 `fullscreenable:false` + `maximize()` 的 zoom 撑满（三颗确实常驻，代价是菜单栏与 Dock 仍占一条），用户 10-11 一句「**我要的是全屏，不是放大按钮**」回退，也明确拒绝自绘三颗。1920x1080 实测：画面矩形 `x=716 w=487`（中线 959.5 ≈ 屏幕正中）、上下各留 12px、面板 `74x263` 贴右上角；退出全屏回到上面那套常态排法。历史：2026-10-09/10 先做的是「hover 往外扩那一圈浅色窗口底」（参照 AndroMeld / 小米互联），10-10 晚用户整块删掉换成这条长条（先浮在画面右边缘），同一晚再来一句「任何 UI 都不要在手机里出现，都移到外边」⇒ 挪到手机右边外面、开始占窗口宽度。**2026-10-11 加了一颗「一直显示」（常驻）**（用户：「侧边悬浮按钮栏加一个始终显示悬浮的按钮」）：状态机（`chromeReveal.js`）加 `setPinned` —— 常驻期间 `leave` **不再排到期时间**（鼠标移到哪条都在），常驻那一刻顺带把条显出来（不必先 hover，那颗按钮该独立于 hover 生效），并撤掉已经在排队的那次收回；**取消常驻只解除"不许收"这一条、不自己排计时** —— 点那颗按钮时指针必然在条上，条不该在指针底下消失；指针真在条外的路径（键盘聚焦那颗按钮按回车）由 `App.vue` 的 `toggleRailPinned` 补一次 `leave()`（用 `matches(':hover')` 判，那是唯一能同步问到"指针在不在这个元素上"的办法）。按钮排在**关屏下面第二格**（关屏是 10-10 用户点名要放最上的，不挪），图标 `lucide:pin` + `is-active` 画状态（与关屏同一条规矩：不反着标）。⚠️ **不持久化** —— 窗口级一次性开关（与 `railShown` 同类），要跨会话记住得进 `prefs`，那连着 `shared/scrcpyConfig.js` 与设置界面，用户没要。**同日还把开关按键的选中态改明显了**（用户：「悬浮窗按钮选中状态不明显」）：原来只是把灰底从 5% 压到 14%，在 `#fbfbfb` 面板上几乎分不出来 ⇒ 改成**填实主色 + 白图标**（深浅对调），并补 `:hover`（`--rail-accent-press`）/ `:active`（`brightness(0.9)`）两档，照主窗口 `BaseButton` 那颗主按钮的规矩；三颗开关（关屏 / 常驻 / Mac 键盘）共用 `.mirror-rail__key.is-active`，一起变清楚。⚠️ 那三条**必须排在 `:hover` / `:active` 后面**（特异性都是两个选择器，靠源码顺序决胜）。⚠️⚠️ 色值**写死在长条自己声明的 `--rail-accent`**（`.mirror-rail__panel` 上，与 `--rail-side-gap` 同一处），**不能写 `var(--color-accent)`** —— 镜像页是**独立的一份 CSS 产物**，Tailwind v4 的 `@theme` 只发**真正被用到**的令牌，而镜像页一个 Tailwind 工具类都没有 ⇒ 产物里根本没有那段 `:root`，`var()` 取不到值 = `background` 无效 = 透明，配 `color: #fff` 就是**白图标贴白面板**（从"不明显"变成"看不见"，而且构建/lint/单测全绿、只有眼睛能发现）。用之前先 `grep -o -- '--color-[a-z0-9-]*:' dist/assets/mirror-*.css` 验一眼 |
| 音频转发 | `src/mirror/audio.js` | scrcpy 服务端 Opus → WebCodecs `AudioDecoder` → AudioContext 排程播放；音频不可用时自动降级纯画面 |
| 会话管理 UI | `src/composables/useScrcpySessions.js`、`src/components/ScrcpySessions.vue` | 与 scrcpy 会话合并展示，支持聚焦/关闭/全部关闭（2s 轮询主进程会话记录，见 [`TODO.md`](TODO.md) §5.1） |
| 无界面调试 | `scripts/mirror-spike.mjs` | `pnpm mirror:spike <serial> [h264\|h265] [raw-out] [秒数]` |

### 2.1 关键约束

- **协议层依赖 Tango beta**：`AdbScrcpyOptions4_1`（VP8/VP9 与 `getEncoders`）在 `3.0.0-beta.3` 里，版本已在 `package.json` 锁定，升级需回归。
  ⚠️ **Tango 目前没有 5.x 的选项类**（`AdbScrcpyOptionsLatest` 就是 `AdbScrcpyOptions4_1`），但**不需要**：scrcpy 5.0 与 5.0.1 的 server 侧 `Options.java` 与 4.1 一字未改，
  它只在 `Options.parse` 的**第一个参数**上比对客户端声明的版本号。所以随包 5.0.1 server 的做法是继续用 `AdbScrcpyOptions4_1`，
  第二个构造参数显式传 `{ version: SCRCPY_SERVER_VERSION }`（`shared/scrcpyConfig.js` 的常量，唯一出处；漏改 = server 当场退出 = 白屏）。
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
- **音频仅 Opus**：scrcpy 服务端的音频链路只支持 `opus`（`ScrcpyAudioCodec.Opus`），WebCodecs 直接解码；配置包是 `OpusHead`，`src/mirror/audio.js` 只从它取 channels/sampleRate 建 AudioContext —— **pre-skip 不在我们这边裁**：WebCodecs 的 Opus 注册把 OpusHead 的 pre-skip 定义成解码器的 `[[priming samples to discard]]`，Chromium 已实现（2026-10-07 实测：48kHz 编一段第 0 帧为冲激的 PCM 再解回，4800 帧进 / 4800 帧出、冲激仍在第 0 帧，OpusHead 里 preskip=312），自己再裁一遍等于丢两遍。音频不可用（disabled/errored）时自动降级纯画面。
- **音频与画面在同一条会话里**：`buildMirrorOptions` 的 `audio` 就是设置页「声音输出」那一项（默认开 = 声音转到电脑、投屏期间手机静音）。设备静音是 scrcpy **建会话时**给音频路由定死的（默认 `audio_source=output` → `AudioDirectCapture` 走 `REMOTE_SUBMIX`，采到回环就不再渲染到设备；`audio_dup` 是 `playback` 源那一支的事，对直采源是空操作），而控制协议里**没有任何音频路由消息**（随包 5.0.1 server 的 `Controller.java` 那一串 `TYPE_*` 里没有）⇒ **运行时改不了这一档**，要改只能整条会话重来。2026-10-11 试过「另起一条只做音频的会话」绕开这一点，实测代价与结论见 §3「音频转发」那条。
- **上游确实没有可复用的等价能力**（别再来问一遍）：`audio_source` / `audio_dup` 只在 `Options.parse()` 读一次，之后 `Server.java` 不再读参数；音频 socket 在 `DesktopConnection` 里只建一条，`Streamer` 的编码号是一次性写入；控制消息全表（`ControlMessage.java:10-32`，23 种）没有一项与音频有关，5.0.1 也没有 `change_settings` 那套东西。
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
  - ⚠️ 2026-09-28 起**不要再走 `kind:'action'` 那条路**（整套已按产品决策删除，见 `electron/mirror/control.js` 顶部）。返回 / Home / 多任务 10-10 已经在长条上（`App.vue` 的 `RAIL_KEYS` → `KEY_CODES.{back,home,recents}` → `kind:'key'`），要加同类键照这条走，**别去恢复 `kind:'action'` 那层**
- [ ] **多指触控 / 捏合缩放**（当前 `pointerId` 固定为 0，仅单指）
  - 验收：地图/图片可双指缩放

### P2 会话与窗口

- [x] **悬浮栏那颗「桌面模式」**（2026-10-11 完成，用户口径：「安卓 14 往上加一个桌面模式，也就是现在点击 app 创建虚拟屏幕出来的镜像模式；如果是直接手机镜像打开 app，则在悬浮栏加一个桌面模式打开按钮」）
  - **桌面模式 = 现在「点应用 → 独立虚拟屏」那套**，没有新形态（用户当天在选项里选的就是这一条）。所以首页那侧**一行没动**：「安卓 14 往上」的入口就是点应用本身（14+ 点应用本来就建虚拟显示）。本轮新增的只有**从整机镜像进去的那一个入口**。
  - 落点：右侧长条上多一格（`App.vue` 的 `RAIL_KEYS` 之上、关屏那格下面，图标 `lucide:app-window` —— 与主窗口会话列表里「单应用会话」同一颗）。点下去 = **把手机主屏上正在用的那个应用抽到一块新的虚拟屏窗口里**（用户选的「另开一个窗口」，当前整机镜像窗口不动）。
  - 机制复用首页那条路，**没有新的 scrcpy 用法**：主进程 `getForegroundApp` 现问设备前台应用 → `startMirrorSession({ packageName })` 建虚拟显示 → 渲染层 `startApp` 之后由 `ensureAppHere` 用 `am display move-stack` 把 task 搬过去（不重启应用，见「无缝接回」那条）。已在播的应用由 `findAppSession` 复用，返回里带 `reused`。
  - **按钮出不出的判据在主进程定一次**（`pendingInit.desktopModeAvailable` = `deviceMirror && supportsDesktopMode(sdk)`，`mirror/options.js`），渲染层不自己判版本 —— 同 `deviceMirror` 那条规矩。两个条件缺一不可：① 只有**采主屏**的会话需要这个入口（虚拟显示那条路本身就是桌面模式）；② 只有 Android 14+（`DESKTOP_MODE_MIN_SDK = 34`，13 及以下建出来的显示拿不到焦点）。⚠️ `supportsDesktopMode` **读不到版本时回 false**，与 `mirrorsMainDisplay` 读不到时「照旧建虚拟显示」正好相反：那边是维持老行为，这边是多给一个入口，宁可少给（用户的原话就是「14 往上」）。
  - 设备侧读前台应用：`getForegroundApp(serial)`（`electron/adb.js`）并发发两条 shell —— `dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity|ResumedActivity'`（设备侧就 grep 掉，整份 dumpsys 是几百 KB，同 `getAppTask`）与 `cmd package resolve-activity --brief … HOME`。**停在桌面时回 null**（前台就是 launcher 自己）：那会儿没有「正在用的应用」可搬，而把 launcher 的 task 搬走会把手机主屏一起搞乱 —— 这时窗口里给一句「手机上现在没有打开的应用」。launcher 包名按 HOME intent 现问，**不写死任何 ROM 的包名**（仓库不留机型/应用特判）；问不到就跳过那道守卫。
  - 名称与图标取**本机那份应用缓存**（`getCachedApps`，不碰设备）：新窗口的「接回画面」横幅要用它们，为一格图标去问设备等于白花一轮 IO。
  - 判据：`tests/electron/mirrorOptions.test.js`（34/33 边界、读不到版本回 false）+ `tests/electron/adbForegroundApp.test.js`（三种 dumpsys 行形态、多用户 `u10`、停在桌面回 null、HOME 问不到时不做守卫、两条命令并发）+ `tests/electron/mirrorSession.test.js`（四种组合下 `desktopModeAvailable`、点开新窗口且 `deviceMirror=false`、停在桌面不开窗、复用已有会话、沿用当前窗口参数）。
  - 未验：真机上点一次（本条是纯逻辑 + 单测交付，没有真机截图）。已知的形态边界：长条竖排在窗口被拖到最矮（`minHeight: 280`）时会溢出面板圆角 —— **这是本轮之前就有的**（原来 4 格已经比 280 高），多一格只是让它更早发生；窗口按手机比例锁着，常态高度远大于此。
- [ ] **镜像窗口截图保存**：`decoder.snapshot()` → 主进程保存对话框/写文件
- [ ] **会话列表增强**：重开、截图、切换置顶等快捷动作（`ScrcpySessions.vue`）
- [ ] **窗口尺寸/位置记忆**：按应用或全局记住上次窗口大小
- ~~**设备断线自动重连**~~（**已决定不做**，2026-10-11）：心跳发现掉线后不再主动 `adb connect`、不再弹「正在尝试恢复与 xxx 的连接」，只提示一句并回到添加设备页；设备回到 adb 列表时由发现循环的自动接管接上。`reconnectDevice` 只剩一个调用方 = `.adr` / 深链唤起镜像时设备不在

### P3 引擎收尾

- [x] **虚拟显示跟随窗口**（2026-09-16 完成，2026-09-17 改为默认行为）：恒定 `flexDisplay` 服务端选项 + 官方 `resizeDisplay`，窗口尺寸变化即重排虚拟显示；对话框不再暴露 `newDisplay`/`renderFit`，虚拟显示尺寸按窗口 × 倍率计算（1dp = 1 CSS px；当时是常量 `DISPLAY_PIXEL_SCALE`，2026-09-23 起改为画质档位 `DISPLAY_QUALITY_TIERS`；倍率不再跟 devicePixelRatio，理由见下面「px 写死的控件」）

- [x] **跟随请求去重**（2026-09-19 完成）：启动阶段不再补发与 `newDisplay` 完全相同的 `resizeDisplay`，窗口拖动期间的多次变化合并为一次（`src/mirror/displayFollow.js` + `tests/mirror/displayFollow.test.js`）
- [x] **整机镜像（顶栏「镜像手机」）**（2026-10-09 完成）：以前每个镜像窗口都必须绑一个应用（`startMirrorSession` 硬校验包名、渲染层固定 `startApp` + 接回），**没有「看整台手机」这一档**。做法只有一处开关：**`packageName` 为空 ⇒ `deviceMirror`**，`buildMirrorOptions` 于是**连 `new_display` 键都不发** —— 上游 `Server.java:144-149` 按「这个键在不在」分叉（在 → `NewDisplayCapture` 建新显示；不在 → `ScreenCapture` 采主屏）。
  - ⚠️ **`new_display=`（空串）不等于不发键**，这是最容易踩的地方：空串是「新建一块**主屏尺寸与密度**的虚拟显示」这个**值**的语义（`Options.parseNewDisplay` 四种输入之一），画面里仍然是那块新显示（上面只有 `SecondaryDisplayLauncher`，应用还在主屏上）。实测两条分得很开：不发键 → server stdout `Display: using SurfaceControl API`、**没有** `New display: WxH/D (id=N)`；发空串 → 有 `New display` 与 id（5.0.1 官方产物 + Mi 10 各跑一遍，30 包 / 8s 出流，`controller` 照常可用）。
  - 连带不适用的三件事，都按 `deviceMirror` 跳过：`flex_display` 与「跟随窗口」（服务端 `requestResize` 对非 flex 显示直接抛错，而主屏不是我们能 resize 的东西）→ 窗口改大小只是本地缩放；`startApp` 与「接回画面」轮询（没有「这块显示上的应用」概念）；补丁产物（它的效果全在建显示上）→ `scrcpyServerPath({ largeScreenDisplay: false })` 显式要官方那份。
  - 入口：顶栏动作区「镜像手机」（`PageHeader.vue` 的 `actions`，与断开/设置并排）；设备切换下拉里当前设备那行有「发到桌面」，建的是**不带 `package` 参数**的 `anddrive://mirror?address=…`（`shortcutCore` 现在把「没有 package」读作整机镜像），双击即开这台设备的整机镜像。
  - 会话身份不变：键仍是「设备 + 包名」，整机 = 「设备 + 空」，所以**一台设备只有一个整机镜像窗口**，再点唤到前台；label 退「手机镜像」。窗口形状仍照 `wm size` 的设备画面比例在建之前 fit（`mirrorWindowBounds`），只是这之后不再跟随。
- [x] **顶部那条 chrome（三颗彩虹键 + 「app - 设备名」）+ 右边长条 = 一层 L 形涂装，鼠标贴上边或右边才浮出**（2026-10-12 连着改三稿）：
  - 第一稿（照竞品做常驻不透明浅灰窗）当天被否：「竞品是鼠标移动到边框上才那个样子，没移上去就是个手机样子」⇒ **窗口本体仍然透明**（10-09 那条定稿没被推翻），那层浅灰（`#dcdfe3`）是**涂装**，`is-chrome` 就是长条那个 `railShown`。
  - 第二稿（一整块浅灰窗底 + 12px 圆角）也被否：「**左下角不要有边框，只有上边和右边有**」⇒ 涂装拆成**两条臂**：`.is-chrome:not(.is-fullscreen) .mirror-titlebar` 与 `.is-chrome:not(.is-fullscreen) .mirror-rail` 各涂 `#dcdfe3`（`.mirror-window` 自己一条底色都没有 ⇒ 平时左/下两边就是透明，只剩那圈常驻黑框 = 手机）。两条臂都是 `transition: background-color`（跟着 `--rail-fade-in/out` 那两个数），与面板的淡入淡出同步。**第三稿（同一晚）把两条臂的 `border-radius` 全删了**（用户：「左上右上右下的圆角颜色和边框颜色一样，不要现在丑丑的黑色」）—— 臂的终点就是窗口的角，**窗口那圈圆角归 macOS 系统**（透明窗口照旧被裁成圆角），我们只要把灰铺到窗口边，圆角就是对的；自己再写一圈 CSS 半径 = 在系统那圈**里面**又挖一圈，两圈不重合 ⇒ 中间露出一条桌面 = 他说的黑缺口（实测 CSS 半径在时角上 `(58,58,60)`）。⚠️⚠️ **中途试过 `roundedCorners: false` 想把灰铺到尖角，代价是 macOS 那三颗彩虹键整组不画了**（他当场报「mac的三个彩虹按钮没了」）—— 窗角与标准按钮是同一套窗口外形，去掉圆角把按钮一起带走。已经**回退**，`createMirrorWindow` 里现在只留一段注释说明别再试；回归墓碑改成钉「`roundedCorners` 这个键压根没传」（`tests/electron/mirrorSession.test.js`「本体透明…」，把 `roundedCorners: false` 加回去当场红）。回退后实测：角上 `(1,1)`/`(3,3)` 是桌面、`(6,6)` 起就是 `#dcdfe3` ⇒ **圆角由系统给、灰由我们铺**，三颗彩虹键也在（截图核对）。
  - 同一条「**右侧操作栏和边框写在一起，不要分成 2 个叠在一起**」⇒ 窗口态面板不再浮一颗白胶囊：`.mirror-window:not(.is-fullscreen) .mirror-rail__panel { width: 格宽; margin-right: 0; background: transparent; box-shadow: none }`，键直接坐在那条灰臂上。**两档全屏没有灰臂 ⇒ 白胶囊照旧**（那条覆盖用 `:not(.is-fullscreen)` 挡住，特异度三个类，比 `.is-shown` 高，所以只覆盖外观、不碰 `opacity`）。
  - 「**上边高度窄一点**」：`MIRROR_TITLEBAR.height` 从照抄竞品的 41 → **28**（三颗约 14 高，上下各 7 = `mirrorTrafficLightPosition() = {x:12, y:7}`）。它进 `mirrorScreenInsets().top = bezel + 28 = 32`，10-12 一起改的三条窗口几何断言都按这个数重算（`tests/electron/mirrorOptions.test.js` 竖屏 `456x820` / 画面 `362x784`、横屏 `1360x620`；`mirrorSession.test.js` 建窗 `455x820`）。
  - **第三稿之后又追一条：「3个角还是没有颜色呀」**（10-12）—— 我上一轮把三个窗角补成灰的，他说的其实是**手机那圈黑框的圆角与两条臂之间透出来的三块楔形**（黑框外沿半径 `--frame-radius` = 40 + 4 = 44，圆外、窗口矩形内那几块本来就是透的，实测楔形里取色 = 桌面色 `(55,55,56)`）。补法：`.is-chrome:not(.is-fullscreen) .mirror-main` 上**三层 `radial-gradient`，一层管一个角** —— 圆心落在该角方形的**内角**上、半径 = `--frame-radius`，圆内透明（黑框自己画）、圆外灰 ⇒ 一圈贴着黑框外沿的凹圆角；位置 `left top` / `right var(--rail-w) top` / `right var(--rail-w) bottom`（**左下角那一块不补**，那里没有臂，补了就是手机左下凭空一块灰）。
    ⚠️ **为什么不写在 `.mirror-frame` 上**：`border-radius` 会把**元素自己的背景一起裁掉**，楔形正好在裁剪线外面，画在框上永远补不到 —— `.mirror-main` 没有圆角，才补得着。
    ⚠️ 这三块跟着 `.is-chrome` 开关，而 `background-image` 不可过渡 ⇒ 它们比两条臂的淡入「啪」地早到一点（44px 见方三小块，先不为它单独加一层元素做 opacity）。
    真机复测（同一个窗口，光标走上顶带）：三块楔形 `(219,222,226)` = 臂本身的颜色、左下楔仍 `(30,31,32)` 透桌面、黑框上沿/左沿仍 `(19,19,21)`（没盖住边框）、chrome 收起那态楔形回到 `(60,60,62)` 桌面。
  - **第四稿（2026-10-13）：整层涂装收成「一个 div」**。用户原话：「上边和右边的边框以及左上角右上角右下角的圆角不协调，**不是一个图层**」→ 补一句「左上角右上角右下角和上边右边**改成一个 div**」。**他说的是 DOM 结构，不是观感**（我先把那张截图逐像素量了一遍：两条臂与三块楔形同为 `#dcdfe3`、楔形的圆弧与黑框外沿完全重合、没有缝也没有色差 —— 但那不解决问题：结构上它确实由**三个元素**在画同一层涂装，连淡入都分成两套，两条臂走 `background-color`（可过渡）、三块角走 `background-image`（不可过渡，"啪"地早到早走）。**下次遇到这类"不协调/不是一个图层"，先读 DOM 与样式，别先量像素**）。
    做法：新增一个 `.mirror-chrome`（模板里 `.mirror-body` 的第一个子元素，`position: absolute; inset: 0`），**整块填 `#dcdfe3`**；`.mirror-titlebar` 与 `.mirror-main` 各抬到 `position: relative; z-index: 1` ⇒ 手机画在它上面，**手机轮廓自己把中间那块"挖"掉**，剩下的正好是上臂（28px）+ 右臂（86px）+ 黑框三个圆角**外侧**那三块（黑框是 `--frame-radius` 的圆角矩形，其包围盒在圆角外还剩三块 —— 就是第三稿要用三层 `radial-gradient` 去补的楔形）。⇒ 形状不用算，一个 div + 一条 `opacity` 全有了，三块角与两条臂**天然同一层、同一个淡入**。
    - 左下角那块（「左下角不要有边框」）用 `clip-path: polygon(...)` 切一个 `--frame-radius` 见方的方口挖掉：方口比那块楔形略大，多出来的部分落在**黑框里面**、被手机盖住 ⇒ 不必真按圆弧裁也看不出接缝（裁圆弧反而要动态算路径）。
    - 顺手删掉的三条旧规则（`.is-chrome:not(.is-fullscreen)` 下的 `.mirror-titlebar` 底色 / `.mirror-rail` 底色 / `.mirror-main` 的三层 `radial-gradient`）与两条已无意义的 `transition: background-color`（`.mirror-rail` / `.mirror-titlebar` 基态）—— 底色现在只有 `.mirror-chrome` 一个出处。
    - ⚠️ **回归时先看这条**：涂装只有 `.mirror-chrome` 一处画灰；`.mirror-titlebar` / `.mirror-rail` 的底色必须保持 `transparent`（`.mirror-rail__panel` 的白色胶囊只剩两档全屏，那条 `:not(.is-fullscreen)` 覆盖照旧）。
    - 离屏核对（**构建产物** `dist/mirror.html` + 静态服务器 + 浏览器，视口取真窗口那套 `483×882`，`.mirror-frame` 实测 `[0,28,397,854]`，`is-chrome` 两态逐点取色）：显形态 —— 上臂 `(240,14)`、右臂按键之间 `(440,400)`、黑框三个圆角外那三块 `(6,34)` / `(391,34)` / `(391,876)` 全是 `(220,223,227)`；**左下角那块 `(6,876)` = `(255,255,255)`**（`clip-path` 挖掉了）；左沿 `(2,400)` 与下沿 `(200,880)` 仍是黑框 `(11,11,13)`（没被涂装盖住）；画面 `(200,400)` = `(0,0,0)`。收起态除画面外全透。⚠️ 浏览器里**没有 macOS 那圈窗口圆角**，所以三个窗角在离屏截图里是方的 —— 那圈圆角仍归系统，真机照旧（这条别拿离屏截图去质疑）。
  - ⚠️ **顶条最上面 12px 不当拖拽区，专门留给 hover 触发**（`MIRROR_TITLEBAR.revealHeight`，DOM 是 `.mirror-titlebar__reveal` 那一格 `no-drag`）。真机探针定位到的根因：`-webkit-app-region: drag` 那一片 **Chromium 一个指针事件都不往 DOM 发** —— 从画面中间一步一步往上移，`clientY ≥ 30` 一路都有 `pointermove`，踏进 drag 区那一步起 `pointermove` / `pointerover` **全空**（只剩一条 `relatedTarget=null` 的 `pointerout`），所以「整条都是拖拽区」= 上臂永远收不到信号、chrome 出不来。让出 12px 之后：贴上边显形（截图实测顶带 `(220,222,226)`）、剩下 16px 照样拖得动窗口（CGEvent 拖窗口角实测 `movedBy=[120,90]`）。
  - ⚠️ 同一条 `relatedTarget=null` 的 `pointerout` 有**两种**来源，`onScreenPointerOut` 按 y 分开：**`clientY ≤ 顶条高`** = 指针踏进 drag 区（当他"还在这条 chrome 上"，`poke()`，否则鼠标停在标题栏里 1 秒后条自己收了 —— 实测停在 `clientY=20` 两秒后 chrome 仍然在），其余 = 指针真离开窗口 ⇒ 照旧补一次收线。**drag 区只有顶部那一条**，所以这条判据是准的；以后给别的元素加 `drag` 要回来改它。
  - 代价（说清）：从窗口**外面一步飞进那 12px**（不经过任何 DOM 元素）Chromium 依然不发事件 ⇒ 那一下不显形，要往下/往左挪一点或走右边那条臂进来。连续移动鼠标必然经过带内，实测走得到的路径都显形。
  - 真机两态核对（Mi 10 整机镜像，`screencapture -x -R` + 逐点取色）：平时顶带/右带都是桌面色（涂装没画）、左 1px 与底 1px 两态都是 `(19,19,21)` 那圈黑框（**左下确实没有边框**）；贴边两态（贴右、贴上）顶带与右带都 `rgb(220,223,227)`，`reveal` 那一格自己永远透明（`rgba(0,0,0,0)`，只是命中层）。**两态画面矩形都是同一个 `[4,32,358,776]`**（= 没有误发 `resizeDisplay` 的证据）。
  - 三颗彩虹键：`trafficLightPosition` 是与窗口宽无关的常量（⇒ `resize` 里什么都不用做，10-10 那套跟窗口宽跑的坑没了），但**显隐跟着 chrome 走**（`mirror:windowButtons`：建窗口先藏，贴边放出来并补一次设位）。标题文字 = `app 名 - 设备名`（式子在主进程 `session.windowTitle`，设备名走 `deviceDisplayName()`，读不到就只留 app 名），原生窗口标题与屏上那行同一个串。

- [x] **镜像窗口的拖拽比例：采主屏那档按手机比例锁**（2026-10-11，用户：「不可以随意更改，只能按手机比例拖拽宽度和高度」；同一天追一条把桌面模式放开，见下面那条子条）：用上游的 `BrowserWindow.setAspectRatio(比例, 不参与比例的余量)`（= AppKit 的 `contentAspectRatio`，拖哪条边系统自己锁，**不是**我们在 `resize` 里回弹）。两个参数各有一个出处：比例 = `mirrorAspectRatio(screenSize)`（与 `mirrorWindowBounds` 同一份 `wm size`），余量 = `mirrorContentExtraSize(hudExtra)`（= `mirrorScreenInsets()` 的横 94 / 纵 8，加上 dev 边栏撑宽那一截）。**锁的是画面那块矩形**，直接把窗口等比会把长条那 86px 算进比例，画面就不是设备比例了。`mirror:windowHud` 每次改完量要按新余量重设一次（否则撑开边栏后再拖一下边，那 240px 被系统收回去）。读不到 `wm size` ⇒ 比例 0 = **不锁**，不自己编一个。
  - **10-11 追一条：这条锁只给采主屏那档**（用户：「桌面模式宽度高度可以自定义拖拽」）。`session.js` 里 `ratio = deviceMirror ? mirrorAspectRatio(screenSize) : 0`（0 = 上游那档取消锁）：**桌面模式那档是我们自己建的 flex 显示**，画面区一变就走 `resizeDisplay`，拖成什么形状设备就重排出什么形状 —— 锁住反而做不成"桌面窗口"。真鼠标拖窗口角实测：桌面模式 拖成 703x658 ⇒ 画面 `609x650`(0.937)、**视频也变成 1218x1300**(0.937)，零黑边；再拖成 361x893 ⇒ 0.302 / 视频 534x1770 跟着 0.302。整机镜像同一动作 ⇒ 窗口被比例公式拉回，画面与视频都还是 0.46（锁照旧）。判据与分流见 `tests/electron/mirrorSession.test.js`「镜像窗口的拖拽比例：采主屏锁、桌面模式放开」。
  - 实测（Mi 10 `fb637d72`，1080x2340）：拖右下角 `466x814 → 502x892`，`(宽−94)/(高−8)` 两档都是 `0.4615`；带锁进 macOS 真全屏 `1600x1000` 正常、退出回原尺寸（上游文档那条「程序化 `setSize` 不受比例约束」也一并验了 —— 边栏撑宽与测试还原都走得动）。
  - 判据：`tests/electron/mirrorOptions.test.js`（余量 = 内缩横竖总量、只加在宽上、负值/非法当 0；比例取设备读数、读不到回 0）+ `tests/electron/mirrorSession.test.js`（建窗口就锁一次、读不到分辨率不锁、边栏开合把那一截算进余量）。改坏 `mirrorContentExtraSize` 的长条那一项、或去掉 hud 里那次重设，两边各红一条（都红过一遍才留下的断言）。
  - 代价：**手机转到横屏时窗口不跟着换形状**，画面在锁住的比例里 letterbox（以前能手动拖成横的）。
- [x] **全屏那一屏的黑框改成往外画**（2026-10-11，用户：「全屏的时候手机镜像画面有点黑边」）：`.is-fullscreen .mirror-frame` 那一档原来是 `border: var(--bezel)` + `aspect-ratio: var(--screen-ratio)` —— `aspect-ratio` 管的是**含边框那个盒**（全局 `box-sizing: border-box`），边框吃掉的 4px 让里面真正放画面的内容盒比视频窄一圈，contain 之后上下各露 ~5px 黑（1600x1000 实测内容盒 `442x968`=0.4566，视频 `1080x2340`=0.4615）。改成 `border: none` + `box-shadow: 0 0 0 var(--bezel) #0b0b0d`（往外画、不吃布局；圆角只写内圈 `--radius`，阴影外扩一档自动等于 `radius + bezel`，与窗口态同心）。复测内框 `450x976`=0.4611，残差不到 1px，上下边缘截图确认画面直接顶到黑框。**窗口态一行没动**（那边内容盒由主进程按 `mirrorScreenInsets()` 定死 = 画面矩形，本来就没有这问题；复测中心行/列除 4px 黑框外没有第二段黑）。取证手法见记忆 `mirror-device-probing`（AX 设 `AXFullScreen` + `screencapture` 数黑段）。
- [x] **全屏横屏不再出黑边、长条不再被画面压住**（2026-10-11，用户：「全屏横屏画面出现了黑边。而且不要覆盖掉右侧操作按钮」）：两个症状同一个根因 —— `.is-fullscreen` 那一档原来是「画面与长条**同格叠放**」+ 画面 `height:100%; width:auto; max-width:100%`。竖屏恰好没事；**横屏**（视频 2340x1080 = 2.1667，比屏幕还横）`max-width` 把宽掐死、高却仍按 100% ⇒ **盒子比例不等于视频比例**，画布在里面 contain 就上下留黑（同一套规则 A/B 量出来：盒 `1576x876`=1.7991 vs 视频 2.1667 ⇒ 黑边总高 149px）；同时那块盒一直顶到窗口右沿 ⇒ 长条浮在画面上（实测 `frameRight 1588 > panelLeft 1508`，竖屏时 `969 < 1508` 所以只有横屏暴露）。
  - 改法：那一档的 `.mirror-main` 换 **两格**（`minmax(0,1fr) auto`，长条占自己那一格，不再叠在画面上），画面尺寸**两个方向一起判** —— `width: min(calc(100cqw - var(--rail-w) - var(--fs-pad)), calc(100cqh * var(--screen-ratio-n)))` + `aspect-ratio: var(--screen-ratio)`：竖屏落到「按高铺满」、横屏落到「按宽铺满」，两种都让盒子**正好等于视频比例** ⇒ 画布铺满、零黑边。要额外喂一份数值比例 `--screen-ratio-n`（同一个 `syncCanvasBox` 喂）是因为 `calc()` 里乘不了 `1080 / 2340` 那种表达式。`100cq*` 用容器单位而不是 `vw/vh`：它天然跟着这一格走，dev 边栏撑宽、窗口改大小都不用另算。
  - 复测（**真页 CSS + 真 DOM**：浏览器里开 `mirror.html`，把 `.mirror-window` 撑成 1600x900 与 522x755 两档、`is-fullscreen` + 两档比例）：横屏盒 `1478x682`=2.1667、黑边 `0x0`、画面右沿距面板 12px；竖屏盒 0.4615 = 视频、距面板 43px；两档都不重叠。
  - 代价（按「不要覆盖按钮」这条换来的，写清楚）：① 画面不再铺到窗口右沿 ⇒ 横屏那块比原来小约 6%（1576→1478）；② 画面中线从屏幕正中**左移半条长条 = 43px**（右边那一格归长条）。③ `container-type: size` 会给 `.mirror-main` 带上 layout containment（成为绝对定位祖先 + 新层叠上下文）—— 已核：页内那几处 `position:absolute`（收字字段/胶囊）本来就以 `.mirror-screen` 为定位祖先，dev 边栏是 `.mirror-main` 的**兄弟**节点，都不受影响。**窗口态一行没动。**
- [x] **桌面模式那一屏全屏 = 纯视频铺满整屏**（2026-10-11，用户：「桌面模式的全屏改一下，我想只把视频全屏，其他什么东西都不要有，镜像比例跟显示器一样」）：判据 `edgeToEdge = fullscreen && virtualDisplay`（`virtualDisplay` = 启动参数里的 `deviceMirror === false`，也就是**这块显示是我们建的 flex 显示**）。排法在 CSS 的 `.mirror-window.is-edge-to-edge` 那一组：单格、`padding:0`、画面 `100%x100%` + `aspect-ratio:auto` + 无 `box-shadow` 无圆角 ⇒ 黑框/亮底/内缩全撤，底色换回黑。⚠️ **「比例跟显示器一样」不是拉伸**：画面区铺满之后 `contentCss()` 就是整屏，现有那条 ResizeObserver → `displayFollower` → `resizeDisplay` 会把虚拟显示**重排成显示器的形状**（退出全屏同一条路排回手机形状）；拉伸与裁切两条都不走（用户 10-10 明确否过）。采主屏那档（整机镜像、13 及以下点应用）**保持原样**（形状归手机，改不了），他 10-11 也是这么点的。
- 长条与顶带的触发**现在只有一条路**（窗口态与满屏共用）：`window` 上的 `pointermove` + `pointerout`，判据是 `chromeReveal.js` 的 `chromeZone({clientX, clientY}, 窗口宽, 窗口高, enter, exit)` —— **L 形两条臂**（用户 10-12「鼠标移动到右侧和上边都要展示边框」）：`fromRight = 宽 − clientX ≤ enter.x(86)` **或** `fromTop = clientY ≤ enter.y(12)` 就 `enter`，两条臂**都**越出各自的 `exit`（各 +120）才 `leave`，其余 `hold`（迟滞）。单测在 `tests/mirror/chromeReveal.test.js`（把 `||` 改成只看横坐标、或把 `leave` 的 `&&` 改成 `||`，各红 3 条 / 1 条 —— 都红过才留下的断言）。`pointerout` 且 `relatedTarget` 为空要**先按 y 分清是"踏进顶部 drag 区"还是"真离开窗口"**，理由与实测见上面那条 chrome 定稿。⚠️ 为什么把旧的三条都废了：① 挂在**长条那一格**的 `pointermove` 上 —— 满屏那一档格子浮在画面上会吃掉右缘 86px 的点按；② 按**格子矩形**判移出（`onRailLeave` + `isOutsideRect`，两者已删）—— 格子只到面板那么高（实测 86x361），而人是**从任意高度**贴右边缘过来的，顺边缘往下挪一点就被判"移出"当场收 = 用户 10-11 追的「移过去显示后立马消失」；③ 只有一条线没有迟滞 —— 鼠标停在按钮上或左移一点去看 tooltip（portal 到 body，事件不经过这棵树）就收一半再弹回 = 「一闪一闪、移几次才出」。另外满屏那一档 `.mirror-rail{pointer-events:none}`（只有显形的面板接点击），**两档全屏都不碰红绿灯**（真全屏那三颗归系统，10-11 实测钉不住）。

  - ⚠️ **真凶不是状态机，是层叠顺序**（10-11 追了两轮才抓到）：`.mirror-screen` 带 `position: relative`（收字字段要它当定位祖先），定位元素在同一层叠上下文里排在**静态兄弟之后** ⇒ 作为静态兄弟的 `.mirror-rail` 整个被视频盖住：DOM 查出来 `opacity:1`、矩形也对（1840,0,74x361），**屏幕上什么都没有**。他看到的「移过去显示一下又没了」是那颗 **tooltip**（reka 的 portal 挂在 body，层级在视频之上，所以只有它闪出来又收回去）。修法一行：`.is-edge-to-edge .mirror-rail{position:relative}`⇒ 两个都是 `z-index:auto` 的定位元素，按 DOM 顺序后面的压在视频上，**不写一个 z-index**。窗口态不受影响（那 86px 本来就在画面外）。
- [x] **满屏那一档的长条可以上下拖**（2026-10-11，用户：「加个可以拖拽功能」）：**只给纵向、只给满屏那一档**。横向永远钉在窗口右边缘那一格 —— 窗口态那格在**画面外面**（10-10 定稿「任何 UI 都不要出现在手机里」），满屏态拖横向就等于把条摆到手机画面中间盖内容；窗口态则根本没有可拖区间（面板与手机同高、整格占满，实测 814 = 窗口高，`clampRailTop` 只会回 0）⇒ **把手在窗口态不画**（`display:none`，只 `.is-edge-to-edge` 画），免得留个抓不动的假把手。落点用 `translate: 0 var(--rail-top)`（不吃布局 ⇒ 画面那块矩形一寸不动，实测拖完 canvas 仍是 `[0,0,1600,1000]`，**不会白发一条 `resizeDisplay` 让手机重排**）；夹取抽成 `src/mirror/railDock.js` 的 `clampRailTop(desired, panelHeight, viewportHeight, pad=12)`（面板比窗口高 / 高读不到 = 钉回 0，脏值当 0；单测 5 条，去掉 max 夹取会当场红 3 条）。位置只活在窗口生命周期内（与 `railShown`/`railPinned` 同一类，不进 `prefs`）。拖完从右边缘任意高度进来都还在你拖到的那一格（触发只按横坐标判）。
- ⚠️ 拖拽 handler 的顺序坑（真鼠标试出来的一次）：`setPointerCapture` 对某些来源的事件会抛（指针 id 不在活跃指针表里），原来写成"先 preventDefault + 捕获、再记拖拽现场"，一抛就把这次拖拽整个吞了 ⇒ 表现是"按住把手拖不动"、而 DOM 一切正常。⇒ **先把现场记进 `railDrag`，再 try/catch 捕获**。这类"看起来没反应"的分支只有真光标 + 截图能抓到。
  - 取证手法（这次的教训，值得复用）：**DOM 状态会骗人，必须看像素**。① 合成 `PointerEvent` 复现不了命中层相关的问题（它不改 hit-test）⇒ 用 JXA 调 `CGWarpMouseCursorPosition`/`CGEventPost` 移**真光标**；② 判"显形"不能只读 `getComputedStyle().opacity` ⇒ `screencapture -x` 截屏后按区域数亮白像素（本次：光标不在条上 0.000、进条 0.415、2.4s 后仍 0.416）；③ 调试端口要在 `electron/main.js` 临时加 env-gated `appendSwitch("remote-debugging-port")`，**验完删并把 dev 还原成不带端口**。
- [x] **Android 13 及以下点应用不再建虚拟显示**（2026-10-09 完成，用户口径：「不要用虚拟屏幕打开 app，直接手机打开这个 app 然后镜像手机」）：分流只加在主进程那一处判据上 —— `deviceMirror = 包名为空 || mirrorsMainDisplay(sdk)`（`electron/mirror/options.js`，上限常量 `MAIN_DISPLAY_MIRROR_MAX_SDK = 33`；`ro.build.version.sdk` 由新的 `getDeviceSdk` 读，与 `wm size`/`wm density` 并列发，不多等一个来回；**读不到版本回 false**，形态不靠猜）。
  - 为什么 33 是那条线：14 起 scrcpy 建虚拟显示才会自动补 `OWN_FOCUS`（`NewDisplayCapture` 里 `SDK_INT >= API_34` 那段），13 及以下那块显示拿不到焦点。
  - **不新写「在手机上打开 app」的实现**：`startApp` 那条控制消息本来就用得上 —— 上游 `Controller.getStartAppDisplayId()` 在 `display_id` 有值时直接用它，而 `Options.java` 里 `display_id` 的缺省值就是 **0（主屏）**（只有 `new_display` 那条路才把它置成 `DISPLAY_ID_NONE` 再等虚拟显示的 id）。所以渲染层的门槛从 `!deviceMirror` 改成 **`packageName` 有没有**：接回与跟随仍按 `deviceMirror` 跳过，`startApp` 在采主屏时照发、落点就是手机那块屏。
  - 连带效果（都是采主屏那一档本来就有的）：状态栏会出现在画面里（`vd_system_decorations` 不发）、窗口改大小只本地缩放、走官方那份 server。会话身份没动：13 及以下点不同 app 仍是不同窗口，看的是同一条主屏画面。
  - 单测：`tests/electron/mirrorOptions.test.js` 的 `mirrorsMainDisplay`（33/34 边界、null/`'33'`/0 都回 false）+ `tests/electron/mirrorSession.test.js` 的「Android 13 及以下点应用 = 采主屏」（含 `serverPath` 要的是官方那份）。阈值当 34 写过一次，两边各红一条；把 `Number.isInteger` 那层去掉也红过三条。
- [x] **拖宽时画面反复重排 → 改成停手才发**（2026-09-19）：原来的 150ms 是 **throttle**（第一次变化起计时，期间每 150ms 仍发一条），拖一次宽度要发十几条。真机量过：每 150ms 发一步把 920 宽拖到 1880，服务端 300ms 去抖**并没有**合掉中间值，每一步都真的改了显示 → app 每一步重新决定布局（`≤1560x1800` 跟着填满，`1720x1800` 翻成固定比例竖条 + 左右黑边，`1880x1800` 又重排），就是「转好几次」。改成 **debounce**（每次变化都把定时器推后，`RESIZE_SETTLE_MS = 250`），一次拖拽只剩最后一次重排。
  - 剩下的那一次重排仍然看得见（画面跳一下/翻一次），用户否掉了「不越过方向」「不跟随窗口」「重编 server 抹 flag」三条（都会牺牲跟随或引入黑边），选了**遮罩**：`src/mirror/App.vue` 里 `covering` + `showCover/hideCover` —— 窗口比例与当前画面比例差超过 2%（`aspectDiffers`，容差防止抖动就盖）时盖上遮罩（`.mirror-cover`：不透明径向渐变 + 居中小胶囊「转圈 + 调整画面尺寸…」；毛玻璃被否掉 —— 模糊挡不住整体位移，透明度低于 ~95% 就看得见闪烁。出现 90ms、淡出 320ms，元素常驻只切 opacity 才有渐变消失）。**盖上/揭开的时机（2026-09-20 改过一次）**：先做过「一有尺寸变化就盖」，当时被否（`resizeDisplay` 还没发，盖住的是什么都没发生的一段时间）；改成在 `createDisplayFollower` 真正下发的那一刻由 `onReflowStart` 通知页面盖。真横屏落地后（拖一次只剩一次重排）用户又要求回到**手一拖就盖**，所以现在是：`createDisplayFollower` 每次收到尺寸请求都回调 `onIntent` → 页面盖并把总兜底线往前推（慢拖超过 3s 也不会中途露出），真正下发 `resizeDisplay` 与否不再影响盖的时机；停手合并后如果发现尺寸其实没变（拖出去又拖回来）回调 `onSkip` → `cancelCover` 立刻撤罩。揭开不用「第一次画面尺寸变化」，而是等尺寸**连续 420ms 不再变**（设备往往先翻方向再改尺寸，看到第一次就揭会露出旋转），另有 3s 总兜底。同比例的纯缩放不触发遮盖（`aspectDiffers` 容差 2%），解码器报回新画面尺寸（`sizeChanged`）后 180ms 揭开，另有 3s 兜底自动揭开（设备没回传也不能一直盖着）。
- [x] **虚拟显示比例吸附（已回退）**（2026-09-19 试错）：曾把显示尺寸吸附到横 16:9 / 竖 9:16 的内接盒，当天回退。黑边的真正变量不是比例，而是 **Android 的 600dp 大屏门槛**：`smallestWidth ≥ 600dp` 时系统判定大屏并**忽略 app 的方向锁**，锁方向的 app 走 size-compat 被 letterbox 在帧内（双层黑）；`sw < 600dp` 时锁被尊重，`FLAG_ROTATES_WITH_CONTENT` 让显示跟着 app 转，app 填满帧。实测（Redmi 2509FPN0BC / Android 17 / 抖音）：`1920x1080/320`(sw540) 与 `3424x1926/640`(sw481) → 转竖填满；`3424x1926/320`(sw963) 与 `1920x1080/160`(sw1080) → 保持横并 letterbox。`flexDisplay` 对该行为无影响（A/B 过）
- [x] **真横屏虚拟显示（大屏 / pad 的唯一形态）**（2026-09-20 落地）：随包的 `resources/scrcpy/scrcpy-server` 换成**我们自己编的 scrcpy 4.0**，它建虚拟显示时走隐藏的 `VirtualDisplayConfig` 路径并打开 `setIgnoreActivitySizeRestrictions(true)`，于是固定竖屏的 app 在横形逻辑尺寸的虚拟显示上**真的按横屏铺满**，不再被 size-compat 压成中间一条竖屏带。窗口初始尺寸**固定 850x600**（`mirrorWindowBounds`，2026-09-29 用户改口：不再按设备宽高比算；之前那套「长边封顶 1000 CSS px、留 80 边距、查不到分辨率按 9:19.5 兜底」已作废，也因此开会话时不再查设备分辨率）。**2026-10-07 再改口**：默认模式的显示尺寸既然由我们给（= 窗口画面区的物理像素），窗口形状就得**在建之前**照设备画面比例 fit 可用区（`mirrorWindowBounds(screenSize, workArea)`，`screenSize` 走 `getPhysicalScreenSize` 读 `wm size` 的 Physical）；试过「先开 850x600、第一帧到了再收一次」那一版，会跳一次可见的错误形状（横窗开出一块横显示，竖屏 app 当场换版式），当天就被替掉。850x600 只剩「读不到设备分辨率时」的形状，且那种情况下渲染层同时不给显示尺寸（`new_display` 退空串 = 上游默认）。
  - 机制来源：对照 AndroMeld Fusion 的虚拟显示（`dumpsys window displays` → `DisplayWindowSettingsProvider SettingsEntry{... mIsHomeSupported=true, mShouldShowIme=0, mForceAppsUniversalResizable=true}`，我们的显示这一项是 `null`）。该字段由 `VirtualDisplayConfig.Builder#setIgnoreActivitySizeRestrictions` 写入（HyperOS/Android 16 里 dump 名作 `mForceAppsUniversalResizable`，服务端读作 `shouldIgnoreActivitySizeRestrictionsForDisplay`）。它的 `uniqueId` 形如 `virtual:com.android.shell:andromeld-fusion-<uuid>` 也来自 `VirtualDisplayConfig.Builder#setUniqueId`。
  - **单变量对照（同一台机、同一显示几何 `2462x1924/256`、抖音冷启动）**：开关开 → `sw1203dp w1539dp h1113dp 256dpi land`，`mBounds == mAppBounds == mMaxBounds == Rect(0,0-2462,1924)`；开关关（只走 config 路径）→ `sw985dp w985dp h1112dp port`，`mBounds=Rect(443,0-2019,1924)` 竖条。
  - **不动主屏**：全程没有 `wm size`/`wm density`、没有 compat 开关、没有 force-stop + 重启 app。开会话前后 `wm size` 都只有 `Physical size: 1200x2608`（无 Override），手机本体画面不变，之前「先在手机上打开 app 又消失」的闪动随配方一起消失。
  - 开关位置：server 侧 `debug.anddrive.vd.isr`（默认 `"1"` 生效，设 `0` 可临时关掉做对比）；系统没有该 @hide API 时 `NewDisplayCapture` 自动退回公开 `createVirtualDisplay(name,w,h,dpi,surface,flags)`，老设备不受影响。
  - **2026-10-07 变更**：这份自编产物不再是默认。随包默认换成**上游 5.0 官方产物**（`resources/scrcpy/scrcpy-server`，dex 里 0 个 `anddrive` 字符串），补丁那份挪到 `resources/scrcpy/patched/scrcpy-server`，由设置页「大屏模式」开关选；补丁源码也已从 `~/code/scrcpy-5.0-patched` 撤出（留档在 `anddrive-patch/`）。上面这组横屏铺满的效果因此**只在开关打开时存在**，判据仍是 `dumpsys window displays` 里那块显示的 `mForceAppsUniversalResizable`；默认路径建显示不传尺寸，直接就是主屏尺寸与密度。
  - 重编方式（改动在 `NewDisplayCapture.startNew` 与 `wrappers/DisplayManager.createNewVirtualDisplay(..., ignoreActivitySizeRestrictions, homeSupported)`）：
    `cd /Users/xh/code/scrcpy-5.0.1-patched/server && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=~/Library/Android/sdk ANDROID_PLATFORM=36 ANDROID_BUILD_TOOLS=36.1.0 BUILD_DIR=/tmp/vd-build ./build_without_gradle.sh`，产物 `scrcpy-server` 覆盖到 `resources/scrcpy/scrcpy-server`。替换前已用同一份 client 链路验证视频（h265）+ 音频（Opus，6s 内 245 个音频包）+ `new-display` + `startApp` 全部正常。
  - **升级到新版本 scrcpy 的做法（2026-09-29 从 4.0 → 4.1、2026-10-07 从 4.1 → 5.0 各走过一遍）**：我们的补丁只碰**两个文件** ——
    `video/NewDisplayCapture.java`（三个 `debug.anddrive.vd.*` prop 钩子 + flags 日志 + 无 VirtualDisplayConfig 时的回退）与
    `wrappers/DisplayManager.java`（反射 `VirtualDisplayConfig.Builder` 的那条 `createNewVirtualDisplay(..., ignoreActivitySizeRestrictions, homeSupported)` + `tryOptional`）。
    步骤：下载**上游同版本**与**旧版本**源码 → `diff -u --label a/... --label b/...` 从旧 patched 树抽出补丁 → 在新版本树里 `patch -p1` →
    `BUILD_DIR` 要先 `mkdir`（脚本不会自己建）→ 编出的 server 版本烤成 `SCRCPY_VERSION_NAME`，**客户端必须把 `SCRCPY_SERVER_VERSION` 改成同一份**（`src/mirror/connect.js` 与 `scripts/mirror-spike.mjs` 都读它，`pnpm verify-resources` 会拿产物里的版本对账）。
    验证：server stdout 里要看到 `anddrive vd flags=0x… ignoreSizeRestrictions=true`，这行在就说明补丁没丢。
  - **2026-10-07 那次（4.1 → 5.0）的两条便宜**：① 上游那**两个文件在 5.0 里一字未改** → 补丁不用重做、不用 `patch`，直接从旧 patched 树 `cp` 过去即可；
    ② 5.0 的全部改动都在 **C 客户端**（`--hwdec` 硬解、EGL/interop、FFmpeg 9.0.2、SDL），我们走 WebCodecs 本来就硬解，**拿不到任何收益**；
    server 侧只有 `AudioPlaybackCapture`（把可捕获的 `AudioAttributes.USAGE_*` 从 1 种扩到 13 种）与 `CameraCapture.stop()` 不再抛 ——
    前者只在 `audio_source=playback` 时实例化，我们用的是默认 `output`（`AudioCapture`），**所以这条也碰不到我们**。
    → 结论：随包 server 该跟着上游走，但**别把「升 scrcpy」当成能拿来承诺体验的项**；真要 `audio_source` 那一档的收益，Tango 从 2.6 起就暴露了 `audioSource: "playback"` 与 `audioDup`（`@yume-chan/scrcpy@3.0.0-beta.3/esm/2_6/impl/compute-option-values.js`：`audioDup` 会把源强制改成 `playback`），传参这条路是通的 —— 卡点在语义不在客户端。
  - **2026-10-09（5.0 → 5.0.1）**：照上面那两条便宜**又一次成立** —— `diff -rq` 整棵 `server/`，5.0.1 相对 5.0 只改了 `build.gradle` 与 `build_without_gradle.sh` 里的版本号（`versionCode 50000→50001`、`versionName 5.0→5.0.1`），**Java 源码一字未动** → 补丁直接 `cp` 无需重做；5.0.1 的全部改动仍在 C 客户端（`hwdec`/EGL/interop/`scrcpy.c`），我们走 WebCodecs，**没有任何体验收益**。做法：官方产物 `scrcpy-server-v5.0.1`（release 资产，dex 里烤的版本实测 `5.0.1`、`anddrive` 字符串 0 次）覆盖 `resources/scrcpy/scrcpy-server`；新树 `~/code/scrcpy-5.0.1-patched`（上游 5.0.1 + `anddrive-patch/` 两份 .java）用同款命令重编覆盖 `resources/scrcpy/patched/scrcpy-server`，产物 dex 里 `The server version (5.0.1)`、`anddrive vd flags=0x` 与三个 `debug.anddrive.vd.*` 字符串都在（这是补丁没丢的判据，运行时对应 server stdout 那行日志）；`SCRCPY_SERVER_VERSION` 改 `5.0.1`，`pnpm verify-resources` 两份都对账通过。
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
- [x] **镜像窗口绿色按钮 = 全屏**（2026-09-19 完成；2026-10-11 为救红绿灯试过 zoom 撑满，已回退成真全屏；同一天红绿灯整体恢复默认、不再有任何定制，见 `ARCHITECTURE.md` §4）：`electron/mirror/session.js` 显式 `fullscreenable: true`。Electron 44 上只要构造时显式传了 `fullscreen`（未勾「全屏启动」即 `false`），窗口就被标成不可全屏，macOS 绿色按钮退化成 zoom（最大化、保留菜单栏）；置顶与全屏启动两种组合下均已验证为可全屏
- [ ] **设备侧旋转的剩余观感**：虚拟显示带 `VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT`，方向由设备上的应用决定；应用自身在启动过程中换向（例如抖音）仍会让画面转一次。可选缓解：`--no-vd-system-decorations`（不渲染虚拟显示里的 launcher/系统装饰）、或把启动应用放到服务端侧，避免「先显示 launcher 再启动应用」这段换向窗口

- [x] **音频转发**（2026-09-16 完成；2026-09-21 修两处；2026-10-07 删掉自造的 pre-skip 裁剪）：scrcpy 服务端 Opus → WebCodecs `AudioDecoder`（pre-skip 由解码器负责，见 §2.1）→ AudioContext 排程播放，落后丢帧。
  - **音频开关以前是死的**：`buildMirrorOptions` 把 `audio: true` 写死、完全不读 `config.audio`，所以设置页那个开关没有任何作用（实测存盘 `audio:true` 也掩盖了这点）。现在按设置下发，关掉的会话不建音频采集。
  - **投屏时手机静音是刻意的**：服务端 `AudioPlaybackCapture(keepPlayingOnDevice)` 为 false（scrcpy 默认，即不传 `audio_dup`）时给 `AudioMix` 设 `ROUTE_FLAG_LOOP_BACK` —— 只回环、**不在本机渲染**，所以声音只在电脑上出。用户 2026-09-21 明确要求「投屏时手机不要发出声音」，因此我们不开 `audioDup`。要知道的副作用：会话结束、AudioPolicy 撤销后手机恢复渲染，正在播的内容会当场出声（这正是「电脑上结束投屏，手机立马响起声音」的由来，不是 bug）；要两边同时出声才需要 `audioDup: true`（`ROUTE_FLAG_LOOP_BACK_RENDER`）。真机验证过两种都能跑：`c2.android.opus.encoder`、5 秒 253 个 Opus 包。
  - 默认值 2026-10-08 翻成**开**（`DEFAULT_SCRCPY_CONFIG.audio = true`，归一化只认显式 `false`）—— 定的就是「都不加 `--audio-dup`」那一档：声音转到电脑、手机静音；不想要就在设置页选「手机」。
  - **2026-10-11 做过「声音在电脑 / 在手机」的运行时切换，当天删掉**（用户点单：「投屏右侧悬浮控制再加一个功能，选择音频是在手机还是电脑」；实测下来不值 → 「不要抄了，把切换相关的代码删掉，就保留默认」）。当时的实现：音频拆成一条 `video:false / audio:true / control:false` 的独立会话，起它 = 声音到电脑（设备被回环走、本机不出声），停它 = 声音回手机，画面会话一行不动、不重连。
    - 真机验证（Mi 10 / Android 13 / 随包 5.0.1 server）：单跑 4s 出 200 个 Opus 包、与视频会话**并存 4/4 成功**、开→停循环 3 轮每轮 ~100 包；设备侧判据 `dumpsys media.audio_flinger`：跑着有 `type 3 (RECORD)` + `Audio source: 8 (AUDIO_SOURCE_REMOTE_SUBMIX)`，关掉约 1 秒消失。**但一次「切到电脑」实测 1.8–3.5s 才出第一个音频包**（推 jar 1245ms + 起 server ~290ms + 音频元数据 ~280ms + 编码器首包 ~1.2s），还偶发 `disabled` 要重试 ⇒ 整块删。
    - 留档的两条硬约束（再往这条路上想之前先看这两条）：① **每条会话都要自己推一次 jar**（`Server.java:249` 建会话就 `CleanUp.unlinkSelf()` 删掉 `/data/local/tmp` 那份，第二条不重推就 `ClassNotFoundException`），一次 1.25s；② 音频-only 会话必须 `sendDeviceMeta: false` —— 上游把 64 字节设备名写在**第一个 socket** 上，没有视频时那就是音频 socket，客户端会把设备名头 4 字节当编码号（真机报 `Unknown audio codec metadata value: 1298735153` = `0x4D692031` = "Mi 1"）。
    - 「静音」那一档（`capture on` + 本地 `gain 0`，与「电脑」一样会让设备静音）用户 2026-10-11 明确**先不做** —— 别当成需求捡回来。
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

### G1 切片：Mac 键盘输入法（2026-10-11 开工，`[~]` 进行中）


用户点单「把竞品的键盘功能抄过来」，并选定 **b2 形状**（输入法自己当客户端连 `adb forward` 的本地 socket，**不新增设备端常驻进程**；协议形状仍照竞品的能力位信封）。待办口径在 `TODO.md` §6.2 G1。

**为什么非要做输入法**（三条实测，别再往上游找现成出口）：

- `controller.injectText("中文abc123测试")` 在 Mi 10 上**只落地 `abc123`**，中文整段被吞 —— 而且**与设备上装的是哪个输入法无关**（两组单变量：竞品输入法激活、搜狗输入法激活，结果逐字相同）。上游那条消息里根本没有 `escape_non_ascii` 那个字段（`@yume-chan/scrcpy` 的 `ScrcpyInjectTextControlMessage` = `type u8 + text string(u32)`），非 ASCII 走不通是设计如此。
- `adb shell input text '中文abc'` 在 MIUI 14 直接 `NullPointerException @ InputShellCommand.sendText`；`cmd clipboard set-text` 回 `No shell command implementation`。⇒ 平台 shell 那条也不行。
- **但 `setClipboard` + `KEYCODE_PASTE(279)` 能整串送中文**（实测搜索框落地 `剪贴板中文abc123测试`，全程只走 scrcpy 控制消息）。这一条是 Slice 5 文本剪贴板同步的地基，**不是**键盘输入的替代方案（它每次覆盖手机剪贴板，与同步功能互斥）。

**竞品的实现地图**（照抄形状的来源，全部取自它的包体与设备日志）：胶囊是**手机上它自己的输入法**画的（`com.catchingnow.andfiles.helper/.MirrorInputMethodService`，APK 资源 `mirror_ime_status_title`="AndroMeld" 且所有语言都不翻译、`mirror_ime_action_close`="关闭输入法"、`mirror_ime_subtype`="屏幕镜像"），Mac 端只做 `ime set` + 记原输入法 + 还原；⚠️ **它记原输入法的存根实测是 `/data/local/tmp/anddrive-mirror-ime-state-user-0.json`**（JSON：`originalInputMethodId` + `activeSessionTokens` / `enabledSessionTokens` / `pendingRestoreOriginalInputMethod` / `pendingDisableMirrorInputMethod` / `lastUpdatedAtMs`，10-11 晚在设备上直接读到），早先记的 `anddrive-mirror-ime-original.txt` 在设备上**不存在**，以实测的 `.json` 为准；Mac 侧文本走 `NSTextInputClient`（`setMarkedText` 收候选、`insertText:` 才提交）。它设备侧日志暴露的状态形状 = `sessions=[<uuid>{display=0,user=0,alive=true,text=true,clipboard=true}]` + `hasBridge/dispatch/selected` ⇒ 我们的信封按这几个字段定。⚠️ 它用 binder 的前提是设备上本来就有常驻 `MirrorServerMain`（兼 WebRTC 信令），我们没有那个前提 ⇒ 走 b2。

**切换与夺回（10-11 实测，Slice 2 的地基）**：

- `ime enable` + `ime set` 都合法，但 **`ime set` 那句 `selected for user #0` 不可信** —— 实测它报成功后 `settings get secure default_input_method` 仍是别人的。
- **直写 `settings put secure default_input_method <我们的>` 有效且守得住**：连着 4 次写入、每次 1.2s 后回读都是我们的；静置 6s、以及重新聚焦搜索框之后都还是我们的 —— **同场 AndroMeld 正在镜像这台手机**（它的输入法此前会秒级夺回）。⇒ 自动切换不需要用户点头，写这一条就够；但要配「写完回读校验 + 被抢走时重断言 / 或给反馈」，别只看命令返回值。
- ⚠️ 两个镜像 app 同时跑夺回循环会**互相乒乓**。所以我们这边要有「让出（parked）」语义：用户按胶囊上的 ×、或在系统里手动切走，就**不再夺回**（竞品的 × 也正是这个意思，它日志里那句 `X is now a transient device-side yield`）。

**Slice 1 已验收**（2026-10-11）：helper **1.6 / versionCode 7**（`resources/helper-app.apk` 已随构建回填），装 Mi 10 后 `ime list -a -s` 有我们那条，切过去后 `dumpsys input_method` 报 `mCurId=com.anddrive.helper/.MirrorInputMethodService mBoundToMethod=true`，手机右下角画出我们的胶囊（键盘图标 + `AndDrive` + ×，形状照竞品），按 × → `mInputShown=false` 胶囊消失。**测完已把用户手机还原回他原来的输入法**。构建配方（本机 PATH 里没有 java）：`JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=~/Library/Android/sdk bash scripts/build-helper.sh`。

**Slice 2 已验收**（2026-10-11，同一晚）：归属状态机在 `electron/mirror/macKeyboard.js`（**不 import adb**，设备读写全由 `session.js` 注入），入口是长条上新加的那颗 `lucide:keyboard`（在「关屏使用」下面、`tools` 上面），IPC 走 `mirror:macKeyboard`（`on` / `off` / `state`），状态回推走 `mirror:macKeyboardState`。

- **归属是设备级的**：一台手机一份管理器（`macKeyboards` 按 serial 存），同一设备的第二个窗口复用同一份、不重复夺回；**最后一个镜像窗口关掉时自动还原**（`stopMirrorSession` → `releaseMacKeyboard`）。
- 用户原输入法记两份：Mac 内存 + 设备侧 `/data/local/tmp/anddrive-mac-keyboard-original.txt`（Mac 被强杀后下次开启从设备那份捡回原值；捡不到就报 `unavailable` 并**不开** —— 不能把用户键盘永久留在我们手里）。设备回读的值要拼进 `echo > 文件`，所以过一道 `isSafeImeId` 卡死字符集。
- 三条反馈文案照竞品 `mirror.ime.feedback.*`（`switched_away` / `unavailable`），走既有的 `showNotice`。
- 真机端到端（Mi 10，同场 AndroMeld 仍在镜像）：点开关 → 变成我们的、stash 是原值；**手动 `settings put` 抢走 → 3.5s 内我们的循环自己抢回来**；再点一次 → 还原成开启前那一格、stash 清空。
- ⚠️ 修掉一个自己造的 bug：**停手（防乒乓上限）之后再点「开」是空转** —— `enable()` 在 `running` 时直接 return，额度再也不装满，用户表现为"被抢走之后怎么点都回不来"。现在 `enable()` 在已运行时重置 `attempts` 并立刻对账一次（判据在 `tests/electron/macKeyboard.test.js`）。上限本身留着：两家无限互写不是解决问题。
- ⚠️ 页面把「用户想要的」与「实际归属」分成两个 ref（`macKeyboardWanted` / `macKeyboard`）：合成一个之后，被抢走（`switched_away`）时再点一次会变成"重试"而不是"关掉这一格"，用户点两下都关不掉。
- **× 的「让出（parked）」已接**（见下面 Slice 3）。

**Slice 3 已验收**（2026-10-11）：通道 = 设备侧输入法监听**抽象** socket（`android.net.LocalServerSocket("anddrive-mac-keyboard")`），桌面侧 `adb.createSocket('localabstract:anddrive-mac-keyboard')` 连过去 —— 与 scrcpy 自己那条 `localabstract:scrcpy_<scid>` 同机制，**不需要 `forward`、两端都不开 TCP 端口**（这就是 b2；竞品用 binder 是因为它设备上本来就有常驻 `MirrorServerMain`）。线格式一行一条 JSON：Mac→设备 `hello{token}` / `commit{text}` / `ping`；设备→Mac `hello{proto,caps}` / `yield` / `pong`。三个文件：`helper-app/.../MirrorBridge.java`、`src/mirror/macBridge.js`、`src/mirror/macTextSink.js`。

- ⚠️ **抽象 socket 在设备上任何 app 都连得上**（没有文件权限位、Java 侧拿不到对端 uid）⇒ 连上第一句必须对上 token，值走 `Settings.Global.anddrive_mac_keyboard_token`（桌面端每次开启换一个；输入法读它不需要权限）。真机验过：假 token 连上即被断，输入框一个字没进。
- ⚠️ **半开连接是真实存在的**：设备侧早就关了，桌面侧 `read()` 永不返回、`writer` 还在 ⇒ `commit` 与 `yield` 一起静默消失（10-11 第一次"× 没反应"就是这个）。解法 = 保活：每 4s 一条 `ping`，任何来自设备的话都刷新 `lastPongAt`，超过 9s 没回话就主动 `socket.close()` 让重连循环重来。
- ⚠️ **桥必须是进程内单例**：输入法服务会被系统反复重建，每建一个实例就各起一条监听线程的话，先起来那个占着 socket 并持有连接、后起来那个 `bind` 失败且 `out` 永远是 null —— `notifyYield` 读新实例、ping/pong 跑在旧实例上，× 就"发了但没人收到"。现在 `MirrorBridge.get(context)` 单例 + `setSink/clearSink`（服务实例只换落点，**`onDestroy` 不关桥**，关了会把 Mac 正在用的连接一起掐掉）。日志里带实例 id，一眼看得出是不是又冒出第二个。
- 归属状态多了一格 `parked`（用户在手机上按了 ×）。⚠️ **× 必须把用户的原输入法真的写回去**：第一版只做「不再抢、不再送字、归属不动」，当场被打回 —— 我们这条输入法**没有键**，占着归属不还原就等于手机上打不出任何字（用户原话「关不掉 mac 打字了，调不出来手机输入法」；竞品的 × 也是还原，它日志里那句 `restoreOriginalInputMethodIfNeeded`）。现在 `park()` = 写回原值 + 清 stash + 撤夺回定时器；桌面那颗再点一下 = 重新接管（`enable()` 的 running 分支会补回 stash 与定时器），不是「关掉」。真机验过：接管（stash=搜狗）→ 按 × → `default_input_method` 回搜狗、stash 清空 → 再点搜索框，搜狗键盘正常弹出 ✓。
- 真机端到端（Mi 10，helper 1.7/8）：`client authorized` → `notifyYield, connected=true` → 主进程 `[mackbd] parked` → 页面 tooltip 变「已在手机上关闭 Mac 键盘输入」；parked 期间手动把输入法改成百度的，6s 后**没被抢回** ✓；点一下恢复（那颗重新变亮）；再点一下关掉 → `default_input_method` 还原成用户原来那条、token 与 stash 都清空 ✓。
- ⚠️ 排查这类"跨三层的状态没动"的问题，别猜：一次把三层都插临时日志（渲染层没有控制台出口就 `appendFileSync('/tmp/...')`，见记忆 `mirror-device-probing`），一轮就定位到是哪一段断的。本轮三处日志各命中一个根因（半开 / 多实例 / 下面那条）。
- ⚠️ 顺带一个低级但阴间的 bug：主进程推的负载从「字符串」改成「对象」时，`watchMacKeyboardState` 里那句 `String(state ?? "off")` 没跟着改 ⇒ 页面收到 `"[object Object]"`，一律读成 `off`，表现成"× 按了没反应、状态推不上来"。**改 IPC 负载形状必须同时改订阅端**（这条在 `direct-session.js` 的注释里也写了）。
- 还没做：Mac 侧中文候选（Slice 4 的代码与单测已就位，缺真人打一次拼音）；图片/文件剪贴板（Slice 5，走同一条桥的其它 op）。

**Slice 4 已验（2026-10-11）+ 一个"关不掉"的真 bug**：

- 中文这条通了，判据是**真键盘 + 临时探针**：`focus: active=true`（收字字段确实拿到焦点）→ 敲 `abc7` 全程 `input … composing=true` 一条都不送 → 提交候选（空格/回车）→ `compositionend data="abc7"` → 桥 → 手机搜索框出现 `abc7`。⚠️ **用户"打不了汉字"的第一层原因不是链路断**：Mac 处在拼音输入法时，字母全进合成态，**必须提交候选**才会发出去 —— 排查这类反馈先确认他提没提交。
- **合成态也同步到手机**（用户 10-11：「竞品打字比我们的好看，它会将输入法文字显示在光标后」）：Mac 每次 `compositionupdate` 把**当前整串拼音**经桥送 `{op:'compose',text}` → 输入法 `InputConnection.setComposingText()` ⇒ 手机上出现带下划线的合成文字，提交时 `commitText` 直接替换它。真机验过：敲 `shd` 不提交 → 手机搜索框显示带下划线的 `sh d`；按空格选定 → 变成「手动」 ✓。协议上 compose 是高频的（每键一条），**不回 ack**（下一条就来覆盖，丢了无所谓）；空串走 `finishComposingText()`，桥断了也不会把半截拼音留在人家输入框里。
  - ⚠️ **10-11 晚这条被改掉了**：合成串改成**只在 Mac 上画**（见 Slice 4d），**不再送手机** —— 用户拿截图说「不对」，指的正是同一串在手机上（下划线那段）与 Mac 胶囊里**各显示一遍**。竞品也不在手机上显示拼音。桥的 `{op:'compose'}` 与设备侧 `setComposingText` **都还在**（是桥的能力，不是死代码），要恢复就把它接回 `App.vue` 的 `compose` 里（见 `direct-session.js` 上那条注释）。
  - 同一轮还修了一个隐患：`onCompositionEnd` 现在**一定**发一次空串。原先只有 `emit()` 那条路，而它对空串提前 `return` ⇒ **Esc 取消合成时没人通知**，Mac 胶囊会一直挂着。
- ⚠️ **候选词表拿不到，但候选窗不用我们做**：macOS 不把第三方输入法的候选词表暴露给应用（`NSTextInputClient` 只有 marked text，没有 candidates）。⚠️ **旧结论更正（10-11 晚）**：这里原先写的是"截图里那排「1 史蒂夫舒服 2 啥的方式」是**手机自己的输入法**在合成（外接键盘模式），要那个观感只能走 UHID" —— 那个推断**不成立**："macOS 不给词表" 推不出 "候选条不是 macOS 画的"；**系统候选窗本来就是 macOS 自己画的，应用根本不需要知道词表**。复核（用户确认那张截图取自**竞品的 Mac 窗口**）：候选条就是 **macOS 的系统候选窗**，按我们交给它的 caret 矩形往下摆 —— 这一块**我们本来就有**，4c 做的是把位置定对。真要"手机自己出候选"那条路（UHID + Mac 切英文模式）仍然存在，但它会换掉整条输入链路、与我们的 helper 输入法互斥，**不是**拿到候选条的前提。
- 补了 ack/nack：手机上没有聚焦的输入框时，提交以前是**静默丢**（发了字什么都没发生也没人说），现在设备回 `{op:'ack'}` / `{op:'nack',reason:'no-editor'}`，画面给一句「手机上没有正在输入的输入框」。⚠️ nack 那条**只有代码与链路，真人演示没做出来**（adb 侧焦点控制不稳，测出来的一次是"字进了别处"）。
- ⚠️ 中途出现的 `abc7abc7` 双份是**探针自己造的**（模板字符串里 `committed=${commit(text)}` 把真正的 commit 又调了一遍）。**临时探针不许有副作用**，这条记下来免得再犯。
- ⚠️ **「关闭 mac 打字失效」的真因 = 归属只活在内存里**：dev 实例重启（或进程被强杀）后主进程没有 owner，而设备上还是我们的输入法 ⇒ 页面查到 `off`、按钮是暗的；点一下走 `enable()`，又因为 stash 已被上一任清掉、认不出原值 ⇒ 回 `unavailable`，**谁也关不掉，手机还没有键盘**。解法 = `adopt()`：`state` 那一次查询顺带认领残留（原值优先取设备侧 stash，stash 没了从 `ime list -s` 里挑第一条不是我们的输入法兜底，并把原值补回 stash），认领后那颗是亮的、点一下即还原。一个别的输入法都没有时**不认领**（不装懂）。真机复现验过：把设备写成我们的 + 删掉 stash → 重启 dev → 页面一开那颗就是「Mac 键盘输入中」、stash 被补成兜底值 → 点一下关掉、输入法还原、token 与 stash 都清 ✓。
- ⚠️ **「输入中感觉会多个空格」= 选候选的那个空格被送了两遍**（10-11 用户报）。中文输入法用**空格选候选**时，macOS 吃掉空格并提交候选词（走我们桥的 `commitText`），**同一个空格还照旧冒到 `window` 的 `keydown` 上** —— 而 `' '` 就在 `KEYBOARD_KEYS` 里（`shared/keys.js`），`onKeyDown` 在 `keyCode !== undefined` 时**提前 `return`**，那句"Mac 键盘在收字就别再发一遍"的 `captureText()` 闸在后面的可打印字符分支里，**根本轮不到空格**。设备端我们的输入法**不拦按键**（`MirrorInputMethodService` 没实现 `onKeyDown`），所以那条 `KEYCODE_SPACE` 被编辑器当成真的空格插了进去 ⇒ 手机上多一个空格。**回车选候选同理**（会多一个换行），只是没人报。
  - **改法**：按键归属抽成纯函数 `src/mirror/keyRouting.js` 的 `routeKeyDown()` / `isImeKey()`，**"输入法正在消化这个键"（`event.isComposing || keyCode === 229`）这条判据排到查 `KEYBOARD_KEYS` 之前**，命中的键一个都不转发（候选词本身走 `compositionend` 那条文本路，不靠这个键）。`useMirrorInput.js` 改成按 `routeKeyDown` 的返回值分派，并加了 `forwardedKeys` 集合 —— `keyup` 只补发真的发过 `down` 的键，免得被吞掉的键再冒出一个无主的 up。判据在 `tests/mirror/keyRouting.test.js`（14 条，含"合成态的空格/回车/退格都不转发"与"不在合成态的空格照旧走按键"）。
  - ⚠️ **教训**：同一个"谁负责这个键"的问题上有**两条判据叠着**（输入法有没有吃掉、可打印字符归谁），写成一行行 `if` 时极易把一条漏在提前 `return` 后面。**判据叠两层就抽成纯函数并补单测**，别靠读代码确认。

**Slice 4d：拼音胶囊 —— 把 marked text 画在 Mac 上（2026-10-11，照竞品补的）**

用户 10-11 拿竞品截图点单：「**可以做成竟品的样子吗**」。图里是「白底圆角胶囊（下划线拼音 + 光标）」+ 下面一排候选。

- **先拆图，别整块照抄**：那是**两件东西叠着**。
  - **候选条 = macOS 的系统候选窗**，不是竞品画的，也不是我们能自绘的（词表拿不到，见上一条的更正）。它按 caret 矩形的下沿往下摆 ⇒ **我们本来就有**。
  - **胶囊 = 竞品自己画的**。判据取自竞品 Mac 二进制：它实现了完整的 `NSTextInputClient`（`setMarkedText:selectedRange:replacementRange:` / `hasMarkedText` / `markedTextStorage` / `unmarkText` / `validAttributesForMarkedText`）并带一个 **`inlineInputOverlayView`**。**macOS 不代画 marked text** —— 宿主收到 `setMarkedText:` 之后自己负责呈现，所以这块必须应用自己画。
  - 顺手排掉一个误判：那个橙色块**不是**竞品的品牌标记（竞品图标是绿白，`AppIcon.icns` 导出比对过），它是 Mac 输入法自己那套预编辑窗的一部分。
- **我们的缺口正好是胶囊**：收字字段 1×1 全透明、`font-size:1px`，Chromium 把合成串画在里面等于看不见；拼音又被我们送去手机（`setComposingText`），所以 Mac 上什么都不显示。
- **落地**：新增纯模块 `src/mirror/macTextCapsule.js`（`macTextCapsule()` 判据 + `capsuleBox()` 几何，判据在 `tests/mirror/macTextCapsule.test.js`）；`App.vue` 里加 `.mirror-mactext-capsule` 覆盖层，位置由 `capsuleBox()` 给 —— ⚠️ 初版是**横向贴锚点、纵向以那一行为中心**（`translateY(-50%)`），**第三轮已改成"顶边贴正文行下沿、高 1.3 个行高"**（见下）。
- **判据三条叠着**（任一条不成立都不画）：归属是我们的 + 收字字段**真的拿到焦点** + 正在合成。画错的表现是"用户没在打字，画面上却挂着一个胶囊"。
- ⚠️ 胶囊**只是显示器**：不接指针、不参与输入、不进无障碍树；锚点仍由收字字段决定。
- ⚠️ 它是**产品的一部分**（不像探针那样藏在 dev 开关后面）—— 但只在**合成期间**出现，纯 ASCII 直接落字时没有它。
- **第二轮（同日，用户拿我们自己那版截图说「不对」）**：拼音**显示了两次** —— 手机上那一行已经用下划线画了（`setComposingText` 送过去的），胶囊里又一遍。**修法 = 照竞品：合成串只画在 Mac 上，不送手机。**
  - `App.vue` 的 `compose` 回调**只** `noteMacTextComposing(text)`，不再 `composeViaMacKeyboard(text)`；`macTextSink.onCompositionEnd` 现在一定补发一次空串（理由见上）。
  - ⚠️ **教训**：用户说「输入法文字显示在光标后」时，我们当成了"送手机、让手机画"。**他说的是 Mac 上的胶囊。** 竞品那张图里手机上根本没有拼音 —— 当时就该从图上读出这一点，而不是从字面推。
  - 顺带量到的两处差异（用户**没**要求改，先记着）：竞品的胶囊浮在那一行的**下方**、高约 **2 倍行高**；我们的骑在行上、1 倍行高。竞品那套看起来是把**胶囊自己的矩形**当 caret 矩形交给 macOS，所以候选窗正好落在胶囊下面（「行 → 胶囊 → 候选条」）。要跟就得动交给 macOS 的矩形，与 4c 定准的锚点有取舍，**没动**。
- **第三轮（同日，用户贴竞品图说「对比一下，还是有差距」）**：上一条那两处差异就是差距本体，**已改**。这一轮先把两张图逐像素量了一遍（脚本临时写的，用 Pillow 找蓝/白/深色像素的包围盒），把"看着不一样"变成数字：

  | 量到的元素 | 竞品（560×248） | 我们（816×242，改前） |
  |---|---|---|
  | 正文行墨迹（中文） | y[52,79]，高 **28** | y[71,102]，高 **32** |
  | 拼音胶囊 | y[90,146]，高 **56**；**顶边贴正文行下沿**（90 > 79） | y[69,111]，高 **42**；**骑在正文行上**（中心 90 ≈ 行心 86） |
  | 胶囊高 / 正文墨高 | **2.0×** | 1.3× |
  | 系统候选条 | y[154,201]；**顶边贴胶囊下沿**（154 vs 146） | y[128,175]；顶边贴**正文行**下沿 |

  - **差距是结构性的**：竞品是「正文行 → 胶囊 → 候选条」**三层**；我们是「正文行（胶囊骑在上面）→ 候选条」**两层** —— 胶囊没有自己的那一层。
  - **改法**：把**交给 macOS 的 caret 矩形**从「正文行那一格」换成**胶囊那一格**。新增 `capsuleRect()`（`src/mirror/macTextCapsule.js`）：横向贴锚点不变，纵向 `top + height`（顶边贴正文行下沿），高度 `× CAPSULE_HEIGHT_RATIO = 1.3`；`macTextAnchorStyle` 改用这个矩形 ⇒ 系统候选条自然落在胶囊**下面**。胶囊字号比例 `CAPSULE_FONT_RATIO = 0.48`（换算回行高仍是 0.62，与旧版一致 —— **拼音本身没变大，变大的是胶囊壳**），并去掉 `.mirror-mactext-capsule` 的 `translateY(-50%)`。
  - **取舍**：caret 矩形不再落在手机光标那一行，而是下移一格。这个矩形的**唯一用途**就是给 macOS 摆候选条，所以 4c 定准的锚点（横向 x、以及"从手机光标推出来"这件事）**完全不受影响**；代价是矩形不再与手机上闪烁的竖线重合，dev 探针的判据跟着改成"与胶囊重合"。
  - 两个常量都按上表反推：胶囊高 56 / 行高（墨高 28 ⇒ em≈32 ⇒ 行高≈43）≈ **1.3**；拼音字高 20 ⇒ em≈27 / 胶囊高 56 ≈ **0.48**。
  - 横向那半边**没动**：竞品胶囊左边贴着正文行的 caret x（259 vs 正文末 256），与我们一致。竞品候选条比胶囊再往右 13px（272 vs 259），那是 macOS 自己的偏移，不归我们管。
    - ⚠️ **更正（第四轮量得更细）**：那 13px 里**大部分是候选窗自己的内缩** —— 蓝色选中块离窗沿还有一圈，两者的**外框左缘**只差几个像素（胶囊 259 / 候选窗外沿 ≈266）。不是 macOS 把胶囊和候选条错开，别按那条改。
- **第四轮（同日，用户：「上个功能不要了，我已恢复。拼音框不要无限长，固定宽度，而且不要超出屏幕」）**：胶囊从"随合成串变长"改成**固定宽度 + 夹在画面内**。
  - **先把"固定宽度"这个取值量出来**（复用同一批竞品图，Pillow 逐行扫边框 + 深色墨迹包围盒）：胶囊外框 x[259,450] 宽 **192**、高 **56** ⇒ 宽/高 **≈3.43**。两张图（06-16 / 06-29，同一段 `s d f s d f`）量出来**完全一致**（墨迹宽 108、右边距 60）。
  - ⚠️ **判据是它不裹文字**：拼音墨迹只占 108，**左边距 24、右边距 60** —— 左右不对称，右边多出来的约 36px 是**预留**。这是"固定宽度、文字靠左"的形状，不是"按文字收紧"。所以直接拿 3.43 当我们的常量是站得住的。
  - **改法**：`CAPSULE_WIDTH_RATIO = 3.4`（新增）；`capsuleRect()` 多返回 `width`（只由高度决定，与合成串无关），并按第二个入参 `screenWidth` 把 `left` 夹进画面（`0 ≤ left ≤ screenWidth − width`）。画面宽未知（缺省 / 0 / 非有限数）**不夹** —— 宁可按真实锚点摆。
  - ⚠️ **夹的是同一个矩形**：`macTextAnchorStyle`（= 交给 macOS 的 caret 矩形 = 字段位置）与胶囊样式都出自 `capsuleRect()`，所以**字段与胶囊一起夹**，"两层同源"这条不变量守住了。只夹胶囊、不夹字段的话，两层会在同一屏里错开 —— 那正是前几轮一直在修的现象。**代价**：靠近画面右缘打字时矩形整体左移，候选窗跟着左移，与手机光标错开**最多一个胶囊宽**。
  - `App.vue`：新增 `macTextScreenWidth`，与 `macTextAnchorCss` **同一个出处** —— `syncMacTextAnchor()` 里那次 `getBoundingClientRect()` 只量一次、两个用途（换算坐标 + 夹取宽度），不会出现"位置是新的、宽度是旧的"。
  - CSS：`.mirror-mactext-capsule` 由 `inline-flex` 改 `flex`（宽度定死，内容不许再撑开）+ `overflow: hidden`；文字段 `flex: 0 1 auto; min-width: 0; direction: rtl` —— 装不下时**从头部裁**（`direction: rtl` 让 LTR 文本在盒内右对齐、溢出裁在左边，拼音是纯 LTR 强字符不会触发双向重排），保住靠近光标的尾部；光标段 `flex: none`，合成串再长它也留在胶囊内。
  - `capsuleBox()` 的输出统一过一遍两位小数：`26 × 3.4` 在浮点里是 `88.39999999999999`，不收敛就会绑成 `width: 88.39999999999999px`。
  - ⚠️ **未真机验证**：固定宽度与夹取的观感（尤其是短拼音时右侧的留白）还没在真机上打过字。
  - **单测**：`tests/mirror/macTextCapsule.test.js` 11 → 16 条（新增固定宽度只由高度决定、右缘夹取、画面比胶囊窄/锚点在画面外贴 0、画面宽未知不夹；`capsuleBox` 加 `width` 与夹取同源两条）。

**Slice 4b：候选窗锚点（2026-10-11，真机两轮，机制成立但不精确）**

用户 10-11 反馈：「竞品的候选词就在光标下边，我们飘在别处」。

- **根因**：macOS 摆放输入法候选窗**只认宿主交给它的 caret 矩形**。原生应用（竞品）自己实现 `NSTextInputClient`，`firstRectForCharacterRange:actualRange:` 返回**手机光标换算到屏幕**的矩形，所以候选窗贴着手机光标。Electron 里这条方法**改不了** —— Chromium 拿**聚焦元素的 DOM caret 矩形**充当它。我们的收字字段原来靠 grid 同格叠、**没有任何 `left/top`**，它的 caret 就落在画面左上角 ⇒ 候选窗跟着跑偏。**元素没定位，候选窗就没锚点。**
- ⚠️ 这条与 Slice 4 那条「读不到第三方输入法候选词表」**无关**，别混：候选窗本来就是 macOS 画的、词表本来就来自 Mac 输入法，我们缺的不是词表，是锚点。那条结论只对「把候选词画进手机画面」成立。
- **改法（Electron 内可行）**：收字字段改 `position: absolute`（`.mirror-screen` 补 `position: relative` 当定位祖先），`left/top` 绑到**用户点画面那个点**的显示位置 —— 点哪儿，手机光标就在哪儿，候选窗就贴哪儿。`.mirror-frame` 上原来的 `focusMacText()` 保留，取点挂在 `.mirror-screen` 的 `pointerdown`（它先于冒泡到 frame 的聚焦跑）。
- 两个方向的换算抽成 `src/mirror/macTextAnchor.js` 的 `clientToDevice` / `deviceToScreen`（纯函数，判据在 `tests/mirror/macTextAnchor.test.js`）：量的是与 `useMirrorInput.videoCoords()` **同一块 canvas 显示矩形**，两者互为逆变换，letterbox 的黑边被同一套比例排除；点到黑边上时夹进 `[0, size]`，不把候选窗甩出画面。
- ⚠️ 换算的退化输入（尺寸未知 / 矩形为零）一律返回 `null`，**不许兜底成 0** —— 那就是把候选窗锚回左上角，正是这次要修的现象。锚点缺失时由页面兜底到画面正中。
- 锚点存**设备坐标**、显示位置每次现算 ⇒ 窗口缩放与黑边比例变化自动跟上（`ResizeObserver` 里补一次 `syncMacTextAnchor()`），不用另存一份记忆。
- ⚠️ 收字字段**不能用 `display:none` / `visibility:hidden` / 零尺寸**收掉：那样 DOM caret 矩形不存在，候选窗会退回窗口左上角。1×1 + 全透明 + `pointer-events: none` 是它的正确形状。
- ⚠️ 挪位置只能用 `left/top`，**不能重挂 DOM**（重挂会 blur，输入法当场断）。
- **真机第一轮（2026-10-11 下午，用户口述）**：**候选窗位置确实变了** ⇒ 「把收字字段挪过去」这条机制成立，Electron 里 Chromium 用 DOM caret 矩形充当 `firstRectForCharacterRange` 也成立。但**「不是特别精确」**。
- **真机第二轮**：用户点明「红点跟着鼠标点击走，候选窗在红点下方 —— 我要的是**在光标下方**」。⇒ 红点（= 我们交给 macOS 的 caret 点）与手机上真实的闪烁光标**不是同一个东西**，锚点必须跟光标走，不能跟鼠标走。
- ⚠️ **「设备侧拿不到光标的像素位置」这个结论是错的，Slice 4c 已推翻**（见下）。第一轮据 `dumpsys input_method` 的 `mCursorRect=Rect(0, 0 - 0, 0)`（WebView 编辑器 `com.miui.notes` 的 `RichEditorWebView` 与原生 `miuix.androidbasewidget.widget.ClearableEditText` 各测一次都恒为 0）断定"此路不通"，把 `CursorAnchorInfo` 记成"精确解作废"。**真相是：不主动要就不下发。** 留这两行是为了记住这个坑 —— 静态观测"没看到值"不等于"拿不到值"，尤其在它本来就有"需先订阅"语义的时候。（但要读全：4c 真机验下来还有第二个坑 —— **回调会来、坐标却要先过 `getMatrix()`** 才是屏幕坐标；"能拿到值"与"值直接能用"是两件事。见下。）
  - 同批被排除的还有 `uiautomator dump`：对 WebView **只给一个整块矩形**（`class="android.webkit.WebView"`，内部节点 `NAF="true"` 无子节点）；原生 `ClearableEditText` 能给节点矩形，但**给不了光标在文本里的像素位置**。这条结论**仍然成立**，只是它不再重要 —— 有了 4c 那条，不再需要从控件树里挖。
- **落地的形状（4b，自攒锚点 —— 现在是 4c 的退路）**：
  - **位置** = `点画面定基准` + `按我们送出去的文本往前推`。推进宽度 = 宽字符 1 em / 其余 0.55 em（`estimateAdvancePx`），em 由设备密度换算（`wm density` → `scaleDisplayDpi` → 1sp = dpi/160 px，正文按 16sp）。**宽字符估得准**（方块字），拉丁有 ±10%；估小了候选窗落在光标后面，估大了超前。合成串（拼音）也计入推进宽度（它顶替光标），退格往回退一个字。
  - **高度** = **一个行高**（`LINE_HEIGHT_RATIO = 1.35`），且矩形**以锚点为中心**。用户第一轮的观察"候选窗在红点下方"正好证明 macOS 是**按 caret 矩形的底边**摆放的 —— 所以给 1px 高的矩形，窗口就压在文字行上；给一个行高、底边落在文字行底，它才落在**文字行下方**。实现上靠 `font-size`/`line-height` 撑高 DOM caret（不给高度的话 Chromium 报的还是那条 1px 的线）。
- **dev 探针改了形状**：从"红圈"改成**交给 macOS 的那个 caret 矩形本身**（1px 宽 × 一个行高）。判据三条：与手机竖线重合 ⇒ 位置对；候选窗仍压在文字行上 ⇒ 高度不对；打字后落在光标后面 ⇒ 推进宽度估小了。
  - ⚠️ **它默认不画**（10-11 用户：「**我不要自定义光标，输入选择框位置对就行**」）：只在 **dev 且调试面板（`tools` 按钮）打开**时才渲染（`v-if="devTools && showHud && …"`），打包版里元素压根不存在。**镜像里没有任何自定义光标** —— 收字字段 `.mirror-mactext` 带 `caret-color: transparent`，它自己的 DOM 光标不可见；那条红线纯粹是给我们看锚点的诊断件。候选窗是 **macOS 画的**，它只认我们交出去的 caret 矩形，跟这条红线没有任何关系。
- **4b 的自攒锚点缺陷**：手机应用自己改文本（自动纠错、联想补全、选中替换）时账会错位，没有纠偏手段 —— 只能靠用户重新点一下画面定基准。这正是要上 4c 的动因。

**Slice 4c：抄竞品的 `CursorAnchorInfo`（2026-10-11，已真机验证可用 —— 关键在 `getMatrix()`）**

用户 10-11 追问：「andromeld 怎么做的？能不能抄」。拆了竞品 Mac 二进制与设备 APK，照抄、真机验完、并修掉了一个自己踩进去的坑。**结论：能抄，链路通，补上 `getMatrix()` 之后坐标正确，已启用。**

- **竞品怎么做的（拆包所见）**：
  - Mac 端是**原生 AppKit**（无 Electron Framework），自带 `adb` 与 `andromeld-mcp-server`，含 `WebRTC.framework`。二进制里能搜到 `caretRect` / `caretWidth` / `caretSpacing` / `currentCaretX` / `currentCaretHeight` / `currentCaretOriginY` / `leadingText` / `currentSelectionLocation` 这一组字段，以及 `NSTextInputClient` / `firstRectForCharacterRange:actualRange:` / `setMarkedText:selectedRange:replacementRange:`（是 Swift 应用，类名被 name-mangling，但这几个 ObjC 选择器名原样保留）。
  - 设备端 APK 里有 `MirrorInputMethodService` / `MirrorImeServerBridge` / `MirrorImeBridgeBinderParcel` / `Shizuku`，以及 `requestCursorUpdates` 与 `getInsertionMarkerHorizontal/Top/Bottom`。
  - ⚠️ **一处推断要标清楚**：把 Mac 端那组 `caret*` 字段与设备端那几个 API 连起来看，"竞品用 `CursorAnchorInfo` 定位候选窗"是**推断**，不是实证 —— dex 里出现这两个符号也可能来自它捆绑的某个库。它 Mac 端那组字段名（`caretSpacing` / `leadingText` / `leadingTextStartX`）反而更像**自攒**的账（与 4b 同思路）。别再把这句当定论引用。
- **机制**：`InputConnection.requestCursorUpdates(int)`（API 21+）**主动订阅**，编辑器随后把 `CursorAnchorInfo` 推进 `InputMethodService.onUpdateCursorAnchorInfo()`。常量：`CURSOR_UPDATE_IMMEDIATE = 1`、`CURSOR_UPDATE_MONITOR = 2`（后者持续跟随，选它）。已核对 android-36 SDK，两处 API 都在。
- ⚠️⚠️ **必须再补一步 `getMatrix()`**（这条是本次最大的坑，单独列出来）：
  - `getInsertionMarkerHorizontal/Top/Bottom`（以及 `Baseline`、`getCharacterBounds`）报的是**编辑器本地坐标**，官方文档逐字写着"在本地坐标中返回……将在屏幕上呈现时使用 `getMatrix()` 进行转换"。
  - 但 `CursorAnchorInfo` 的**类摘要**写的是"此类将文本插入点和组合字符串的位置封装在**屏幕坐标**中"—— 那句话说的是**过矩阵之后**的结果。只看摘要就会以为拿到的已经是屏幕坐标。
  - 正确做法：`float[] pts = {x, top, x, bottom}; info.getMatrix().mapPoints(pts);` —— 变换后才是屏幕坐标。
  - 漏掉这一步的后果：拿到的是控件局部坐标（个位数），锚到画面原点附近，**比不采信更差**。
- **落地（三处，各归各位）**：
  - **设备侧** `MirrorInputMethodService`：`onStartInput` / `onStartInputView` 里调 `requestCaretUpdates()`（`CURSOR_UPDATE_MONITOR`，`try/catch (Throwable)` 包住）；`onUpdateCursorAnchorInfo` 读三个 `getInsertionMarker*`，`NaN` 跳过，**再过 `getMatrix().mapPoints()` 转成屏幕坐标**，然后 `bridge.notifyCaret(true, x, top, bottom)`；`onFinishInput` 报 `notifyCaret(false, …)`。**纯上报，不改任何输入行为**。`MirrorBridge` 加 `notifyCaret`，经 `out` 发 `{"op":"caret","valid":…,x,top,bottom}`。
  - **桥** `macBridge.js`：`handleLine` 认 `op === "caret"` → `readCaret(msg)` → `onCaret?.(rect)`；`readCaret` 对 `valid === false` 或字段非有限数一律回 `null`。`direct-session.js` 透传 + 导出 `onMacKeyboardCaret(listener)` 订阅口。
  - **渲染层** `App.vue`：`macTextDeviceCaret` 收设备上报，`TRUST_DEVICE_CARET = true` **采信**；`macTextAnchor` / `macTextCaretHeightPx()` 都过 `reportedDeviceCaret()`，设备没报时才退回 4b 自攒。换算在 `macTextAnchor.js` 的 `caretRectToAnchor`（纯函数，判据在 `tests/mirror/macTextAnchor.test.js`）。
- **真机验证（Mi 10 / MIUI，2026-10-11）**：
  - **通的**：`onStartInput pkg=…` 会来；`requestCursorUpdates(MONITOR) -> true`（编辑器**接受**了请求）；`onUpdateCursorAnchorInfo` **确实被回调**，还带着有意义的 `selStart/selEnd`（笔记那条是 `selStart=249`，正是正文里光标的位置）。`onFinishInput` 也在输入框没了时报 `valid:false`。整条桥 `{op:'caret'}` 到 Mac 侧收得到（用 `adb forward tcp:9999 localabstract:anddrive-mac-keyboard` + 自写旁听器验的，不依赖 Electron 应用）。
  - **第一轮（漏了矩阵）**：报回的值都是个位数，与控件真实屏幕位置对不上，一度误判成"平台给不出屏幕坐标、这条路作废"。
  - **第二轮（补上 `getMatrix()`）**：两类编辑器都精确吻合。`raw` 是本地坐标，`matrix` 是官方给的那个变换，`screen` 是变换后的结果：

    | 应用 / 控件 | 控件屏幕边界（uiautomator） | raw（本地） | matrix | 变换后（屏幕） |
    | --- | --- | --- | --- | --- |
    | MIUI 短信 · 收件人框 | `[526,467][609,579]`（高 112） | `0 / 30 / 82` | 纯平移 `(526, 467)` | `526 / 497 / 549` |
    | MIUI 笔记 · 正文（`RichEditorWebView`） | `[66,491][1017,2206]` | `195.6 / 335.3 / 356.4` | 缩放 `2.75` + Y 平移 `244` | `538 / 1166 / 1224` |

  - **为什么说它是对的（两处独立佐证，不是"看着像"）**：
    - 收件人框：矩阵平移量 `(526,467)` **恰好等于该控件的屏幕原点**；变换后行顶 `497 = 467 + 30`，而该框高 112、行高 52、垂直居中 ⇒ 行顶应为 `(112−52)/2 = 30` 偏移 —— 两条路算出来同一个数。
    - 笔记 WebView：矩阵是缩放 `2.75`（= 设备像素比）+ Y 平移 `244`，而 uiautomator 报的 WebView 边界正是 `[0,244][1080,2206]`；`195.6 × 2.75 = 538`、`335.3 × 2.75 + 244 = 1166`，而 1166 落在正文框 `[66,491][1017,2206]` 内。**WebView 那条同时印证了"raw 是 CSS px"**（高度 21.1 ≈ 16px 字号 × 1.3 行高）。
  - **第三轮：跨应用一致性（5 个应用 / 4 类输入表面，2026-10-11 晚）**。第二轮只覆盖了"纯平移"与"缩放"各一例，担心是个例。补测三个应用后结论不变 —— **每一例上报的坐标都落在控件真实边界内，且打字时光标随插入点推进**：

    | 应用 / 控件 | 输入面 | 控件屏幕边界（uiautomator） | 上报（屏幕坐标） |
    | --- | --- | --- | --- |
    | MIUI 短信 · 收件人框 | MIUI 原生 `EditText`（纯平移） | `[526,467][609,579]` | 空框 `x=526 / top=497 / bottom=549` |
    | MIUI 笔记 · 正文 | Chromium `RichEditorWebView`（缩放 2.75 + Y 平移 244） | `[66,491][1017,2206]` | `x=538 / top=1166 / bottom=1224` |
    | 设置 · 搜索框 | AOSP Settings `EditText`（纯平移） | `[187,101][863,222]` | 空框 `187 / 129 / 193`；打 `hello` 后 `x` 走 `242 → 294 → 373 → 401`，纵向恒定 `129 / 193` |
    | MIUI 浏览器 · 地址栏 | Chromium 原生 `EditText`（纯平移） | `[152,101][879,217]` | 空框 `152 / 131 / 187`；打 `abc` 后 `x` 走 `200 → 222 → 291.578125`，纵向恒定 `131 / 187` |
    | MIUI 相册 · 搜索框 | MIUI `EditText`（纯平移，左侧含搜索图标内边距） | `[73,112][870,232]` | 空框 `189 / 144 / 200`；打 `abc` 后 `x` 走 `212 → 238 → 261 → 332.56640625`，纵向恒定 `144 / 200` |

    - 判据三条：**① `x` 落在控件左右沿之间**（空框时贴内容左沿；相册那条 `189 > 73`，因为该框左侧有搜索图标与内边距）；**② `top`/`bottom` 落在控件上下沿之间**，且 `bottom − top` 为一个行高（设置/浏览器/相册分别是 64 / 56 / 56 px，同框内恒定）；**③ 打字时 `x` 单调推进、纵向不动** —— 这条才真正证明上报的是**插入点**而不是固定左沿。
    - ⚠️ **矩阵那一步在每个应用上都必需，不是只有 WebView 才需要**：三个"纯平移"编辑器上报的 `top` 都比控件屏幕顶边高约 28–32px（设置 `129−101=28`、浏览器 `131−101=30`、相册 `144−112=32`）—— 那正是**本地坐标**。若跳过 `getMatrix()`，这三例都会把候选窗抬高 101–112px（约两个行高），错得比不采信更明显。**这条从反面再次证明矩阵变换是主链路的一部分。**
    - 上报值出现**小数**（浏览器 `291.578125`、相册 `332.56640625`）是好事：说明是设备端真实排版测量出来的，不是整数吸附的近似。
    - 覆盖的输入面：MIUI 原生 `EditText` / AOSP Settings `EditText` / Chromium 原生 `EditText`（地址栏）/ Chromium `WebView` 正文 —— 4 类，其中 WebView 带**非平凡矩阵（缩放）**，其余为**纯平移**，两类都过。
- **仍未解（都不影响主路）**：
  - 短信那两例里 `dumpsys input_method` 的 `mServedView=DecorView`、主 `inputContext` 的 `isActive()=false`（另有 `mFallbackInputConnection` 是 active）—— 不确定这是 MIUI 常态，还是我们的输入法没有真正的输入视图导致的。**存疑，别当结论**（现在坐标已经对了，这条的优先级很低）。
  - 有没有编辑器把 `getMatrix()` 设成 identity 却又给本地坐标（那样变换救不回来）。5 个应用（含 WebView 与三种原生 `EditText`）都没遇到；真遇到就是那个 app 的问题，靠 4b 兜底。
- **踩坑记录（可复用）**：
  - ⚠️ **别只看 API 的类摘要，去看每个 getter 的逐字说明。** 这次就是被类摘要那句 "in the screen coordinates" 带偏，漏了 `getMatrix()`，白跑一轮。**平台 API 里出现"配套的变换矩阵/坐标系"时，默认它不是给你白拿的。**
  - ⚠️ 排查"数值不对"别靠猜：把**原始值 + 中间量 + 变换后的值**一起打出来（本轮就是靠同时打 raw/matrix/screen 一次定位）。同时用 uiautomator 取控件真实边界做**独立基准**，别拿自己的推算当基准。
  - 装包后系统**不会自动重新绑定**输入法服务：`settings put secure default_input_method` 回读已是我们的，但 `ps` 里没有 `com.anddrive.helper:ime`。解法 = 先切到别的输入法再切回来。
  - ⚠️ **`onUpdateCursorAnchorInfo` 只在光标/选区变化时触发**：对着已经聚焦的同一个输入框反复 `input tap` **不会**产生回调（第一次旁听只收到 `hello`、没有 `caret`，就是这个原因，不是链路坏了）。要验证得**制造新的输入会话** —— 先 `KEYCODE_HOME` 再重新拉起界面，或换一个输入框。
  - 同场竞品在跑时，它会**秒级夺回**归属（force-stop 它的 helper 也没用，Mac 端会重新拉起）。所以"我们的输入法 + 聚焦编辑器"这个状态很窗口化，测的时候要连写带点一起下发。
  - **临时探针只能打日志、不许有副作用**，验完必须撤掉并重建 APK（本轮已撤，`grep AndDriveImeProbe` 在 dex 里为 0）。





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
   CSS 由 `mirrorInitGet` 返回的 `initialCss`（主进程 `win.getContentBounds()` **减掉那圈常驻黑框**，
   见 `MIRROR_FRAME` / `mirrorScreenInsets()`）给出，读不到才回落 DOM。

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

> **10-11 补一条读数事实**（做「关屏按钮不亮」那个 bug 时量的）：`Hangup` 态下 SurfaceFlinger 报的是
> **`powerMode=On`**（不是 `Off`）—— 面板物理灭着，但 SF 还在驱动它做合成。所以**不能拿 `powerMode` 判
> `Hangup` 的屏灭**，长条那颗「关屏 / 恢复亮屏」要按 `mWakefulness` 认（见 §2 那张表「休眠提示与唤醒」行）。
> 另外两条复现要点：`Hangup` 只在 **bedtime**（`updateWakefulnessLocked`）这条路上出现，**按电源键**走的是
> `goToSleep` → `Asleep`；而 `mStayOn=true`（`stay_on_while_plugged_in=7` + 插电）会让 bedtime 压根不发生。

> **10-11 手工复现配方（adb）**：`settings put secure synergy_mode 1` —— ⚠️ 命名空间必须是 **`secure`**，
> **不是 `global`**：写错会**静默无效**（`beginSynergy()` 读的是 `Settings.Secure`），设备照样走普通 `Asleep`，
> 白等一轮。配上 `stay_on_while_plugged_in=0`，`input keyevent 224` 唤醒后静置过 `screen_off_timeout` 即进 `Hangup`。

> **10-11 再补一条读数事实（`Hangup` 态的可操作性）**：**`Hangup` 下触摸注入不会被丢弃。** 用 `input swipe`
> （与 scrcpy `injectTouch` 走的是同一条 `InputManager.injectInputEvent` 路径、同为 `shell` uid）在
> `mWakefulness=Hangup` 下注入「下拉通知栏」，随后**不唤醒**直接 `screencap`（`Hangup` 下 SF 照常合成，截图有效）
> 拿到的是**已展开的通知栏**；全程 `mWakefulness` 稳在 `Hangup`。⇒ 镜像里的点击/滑动**能送达设备 UI**。
> ⚠️ 但**注入触摸不构成唤醒路径**：同一发 `input tap` 在普通 `Asleep` 下**同样唤不醒**设备（对照组实测），
> 所以这不是 `Hangup` 特有 —— 注入事件本来就不被电源策略当作唤醒源。**设备醒不醒只认 `input keyevent 224`**
> （即 `needsRealWake` 那条分流），别指望用户点一下镜像就把手机点醒。

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
- 镜像窗口 HUD（仅 dev 显示，**在画面右侧的独立边栏里、不遮挡镜像内容**，**外观与右侧长条同一套（浅色浮栏）**，展开时主进程把窗口撑宽同样的量（`mirror:windowHud`）⇒ 画面不被挤小、手机不重排；字段名中文）：「WebGL」（是否可用）、「渲染方式」（webgl/bitmap、hardware/software 两个原值）、「已显示 / 已绘制 / 跳过绘制」、「解码队列」（decodeQueueSize）、「跳过解码 / 解码器重置」、「画面区 / 视频 / 尺寸变化」（画面区尺寸 / 视频尺寸 / 视频尺寸变化次数）、「视频包 / 接收字节」、音频那组「收到包 / 已播放 / 播放队列 / 已解码 / 时钟 / 状态」。
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
