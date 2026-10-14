# MEMORY.md —— AndDrive 项目长期笔记

（按主题沉淀，跨会话复用。日期日志在 `YYYY-MM-DD.md`，这里只留"下次还会用到"的结论。）

## 镜像页（`mirror.html`）的 CSS 是**独立产物**

- 入口：`mirror.html` → `src/mirror/main.js` → `import '../styles/index.css'`（与主窗口共用同一份源文件，但**产物是两份**：`dist/assets/mirror-*.css`）。
- ⚠️ **Tailwind v4 的 `@theme` 只发出"真正被用到"的令牌。** 镜像页一个 Tailwind 工具类都没有（`App.vue` 全用 `<style scoped>` 里的普通 CSS），所以 `dist/assets/mirror-*.css` 里**没有 `:root` 段、没有任何 `--color-*` 定义**。
- ⇒ **在镜像页里写 `var(--color-accent)` 这类令牌，取不到值**：`background` 变成无效值 = 透明。2026-10-11 长条按键高亮就差点这样上线（白图标贴白面板 = 完全看不见）。
- **规矩**：镜像页的 chrome 不跟主题走（面板底色是写死的 `#fbfbfb`），色值也**写在组件里**；需要复用就在组件内声明局部变量（如 `.mirror-rail__panel` 的 `--rail-accent: #007aff`）。
- **用之前先验**（静默失效，构建/lint/单测全绿也发现不了）：
  ```
  npx vite build
  grep -o -- '--color-[a-z0-9-]*:' dist/assets/mirror-*.css   # 定义
  grep -o -- 'var(--color-[a-z0-9-]*)' dist/assets/mirror-*.css  # 引用
  ```
  引用有、定义无 ⇒ 那个变量是悬空的。

## 镜像窗右侧长条（`.mirror-rail`）

- 显隐状态机在 `src/mirror/chromeReveal.js`（纯函数 + `tests/mirror/chromeReveal.test.js`）：进格子就弹、离开格子 1 秒后收；`setPinned` 是那颗「一直显示」的常驻开关。
- 几何/时长数只有一个出处：`electron/mirror/options.js` 的 `MIRROR_FRAME` / `MIRROR_RAIL`，经 `App.vue` 的 `windowStyle` 注入成 CSS 变量（主进程算窗口尺寸也要用同一份数）。
- 开关型按键（关屏 / 常驻 / Mac 键盘）的"开着"态 = `.mirror-rail__key.is-active`（填实主色 + 白图标）。
- **贴边浮出的那层浅灰涂装（`is-chrome`）= 一个元素 `.mirror-chrome`**（2026-10-13 第四稿）。用户口径：「上边和右边的边框以及左上角右上角右下角的圆角不协调，**不是一个图层**」→「改成一个 div」—— 他指的是 **DOM 结构**（上一版是 `.mirror-titlebar` 一条臂 + `.mirror-rail` 一条臂 + `.mirror-main` 三层 `radial-gradient` 补三个角，三个元素在画同一层涂装，连淡入都分两套）。现在：那层铺满 `.mirror-body` 填 `#dcdfe3`，`.mirror-titlebar` / `.mirror-main` 抬到 `z-index: 1` ⇒ **手机轮廓自己把中间挖掉**，剩下就是上臂 + 右臂 + 黑框三个圆角外侧那三块；左下角那块用 `clip-path` 切一个 `--frame-radius` 见方的方口（多出的部分落在黑框里被手机盖住，所以不必按圆弧裁）。
- ⚠️ 因此：**`.mirror-titlebar` 与 `.mirror-rail` 的底色必须保持 `transparent`**（灰只有一个出处），`.mirror-rail__panel` 的白胶囊只剩两档全屏（那条 `:not(.is-fullscreen)` 覆盖照旧）。
- **2026-10-14 起长条有第二档形态**（用户：「投屏宽度足够宽就改成全屏时在投屏里浮动的样子」）：**画面宽 ≥ 640** 时它不再占窗口右边那一格，改成像桌面模式全屏那样**浮在画面右上**（白胶囊 + hover 才出 + 可上下拖）；窄画面（普通竖屏手机窗口，画面约 360–420）仍是「在外面」那一档。类 = `.mirror-window.is-rail-float:not(.is-fullscreen)`，判据 = `options.js` 的 **`mirrorRailFloats(画面区那一格的宽, previous)`**（唯一出处，主进程建窗时算一次、渲染层实时跟）。
  - ⚠️ **量 `.mirror-main` 的宽，别量画面本身**：浮起来画面自己就宽 86px，拿画面判会被自己的结果推着走。
  - ⚠️ **两条线（迟滞）**：`previous` 决定按哪套内缩扣长条那一截（在外面扣 94、浮着扣 8）⇒「浮起来要 ≥640、收回去要 <640」。一条线时拖上下边会抖（比例锁余量也跟着形态差一条长条宽，而拖上下边时窗口宽是由高推出来的）。
  - ⚠️ **跨进程契约**：内缩是「一档两值」，主进程的窗口尺寸 / 比例锁余量 / `initialCss` 与渲染层判据必须用**同一个** `railFloating`；翻转由 `mirror:railFloat` 从渲染层报回主进程重设比例锁（`session.js` 的 `relockAspect`）。**这条 IPC 绝不动窗口尺寸** —— 窗口宽正是判据的输入，一动它就在阈值附近自己来回跳。以后再加「哪一档少占一截（宽度或高度）」的东西，要么走同一条上报，要么把判据整个搬到一侧。
  - **同一天第二条把这一档的窗口定成"只剩手机"**（用户：「上边头部就去掉，mac 的 3 个按键放进投屏中，标题去掉。右侧悬浮操作栏上下居中，且只有鼠标移入内容区才显示出来，不要移动到右边就展示」）：`mirrorScreenInsets(true)` 的 `top` 也只剩黑框（**右 86 + 上 28 两截一起让掉**）；`.mirror-titlebar` 整条 `display: none`、名称不画；三颗彩虹键**常驻**（落点走 `mirrorTrafficLightPosition(true)`，**两档形态两个落点**，见下面那条「第六条」）；长条**上下居中**（`railDock.js` 的 `railAnchorTop`）；触发改成「指针在 `.mirror-main` 里」。
  - ⚠️ 浮动态的三条坑（都踩过）：
    1. **没有标题栏 = 没有拖窗区** ⇒ 补了 `.mirror-float-drag`（**顶边整条**：`width: 100%` × `MIRROR_TITLEBAR.floatDragHeight = 24`）。⚠️ 第一版是左上角 80×28 的小方块，被用户当场打回，见下面那条「第六条」。
    2. **`watch(railFloating, …, { flush: 'post' })` 是必须的**：窗口态面板撑满整格（`offsetHeight` = 窗口高），换完类之前读它算居中会算出 0。**同步读 `--rail-top` 也读不到新值**（Vue 的 DOM 更新是异步的）—— 离屏核对时我一度以为拖拽坏了。
    3. **`railAnchorTop` 是"写一次"的锚点，不是每帧约束**：只在"进浮动态 / 改窗口大小"两拍写进 `railTop`，否则用户拖出来的位移每次重算就被抹掉。代价：改窗口大小会抹掉拖拽位移（注释里写清了）。
  - 连带：浮动态**整层浅灰涂装都不画**（只剩三块孤零零的楔形，像脏点）；长条格子与**面板**都是 `pointer-events: none`，只有 `.mirror-rail__key` / `__handle` / `__dev` 是 `auto`（面板浮在画面右缘，吃事件 = 把画面右缘 74px 的触控永久拿走）。⚠️ 这样改之后 `panel.matches(':hover')` **照样为真**（`:hover` 顺着命中目标往上传），`toggleRailPinned` 那条判据不用换写法 —— 离屏实测确认过。
- **第六条（2026-10-14）：浮动态的「三颗落点」与「拖窗区」都被报障修过一遍，两条都别退回**：
  - **三颗落点分两档形态**：`mirrorTrafficLightPosition(railFloating)` —— 窗口态 `{12, 7}`（在标题栏里）、浮动态 `{24, 24}`（挪进画面）。⚠️ 浮动态**不能**用 `{12, 7}`：它距画面圆角圆心 `(44, 44)` 是 48.9 > 半径 40（`MIRROR_SCREEN_RADIUS`）⇒ 红灯一半压在黑色圆角**外面**，正是用户报的「mac3 个彩虹见往右往下点，超出屏幕了」。⇒ **改画面圆角半径就得回头验 `floatLightX/Y` 还在圆内**（`tests/electron/mirrorOptions.test.js` 有一条钉着这条几何）。
  - **拖窗区两档都是「顶边整条」**：窗口态 = `.mirror-titlebar` 那条；浮动态 = `.mirror-float-drag`（`width: 100%` × `floatDragHeight = 24`）。⚠️ **第一版左上角 80×28 的小方块已被打回**（「app 投屏后不能拖拽了」）—— 那块地方本来就盖着 AppKit 画的**三颗彩虹键**（画在网页内容**之上**、CSS 盖不住也**命中不到**），方块中间根本抓不到，可抓的只剩几条缝。代价：浮动态手机画面最顶 24px 收不到触控（用户从三个候选里**明确选定**并接受）。
  - ⚠️ **`mirror:windowButtons` 的载荷带 `railFloating`**（`{shown, railFloating}`）：落点分两档 ⇒ **翻转形态那一拍也要重设一次**（`setWindowButtonVisibility(true)` 会把三颗打回 AppKit 默认左上角）。别退回成只传一个布尔。
  - ⚠️ **画面圆角半径的唯一出处是 `options.js` 的 `MIRROR_SCREEN_RADIUS = 40`**（渲染层从 `windowStyle` 取 `--radius`），因为它同时是**几何**（圆角切掉那块 = 圆心 `(bezel + r, bezel + r)`、半径 `r` 的四分之一圆）。别再写回 CSS 里一份。
  - 验「拖窗区在哪」**只能靠命中测试**（`DOM.getNodeForLocation`）：**合成鼠标事件驱动不了原生拖窗**（在拖窗块里按下 + 移动 `120,90` ⇒ 窗口位移 `0,0`）。真机读数：`.mirror-float-drag` = `[0,0,841,24]`，沿顶边 7 个点全命中它、`y ≥ 26` 命中 `canvas`。
- ⚠️ **这三颗开关的状态都不跨会话保存**（窗口级一次性开关）：用户 2026-10-11 一度点单「记住我点的选项」、已实现后又当天撤销 —— **别再把它当需求捡回来**。要恢复得进 `prefs`（`shared/scrcpyConfig.js` 的 `normalizeScrcpyConfig` + `resolveRuntimePrefs`），且「关屏使用」那颗**永远不该进** —— 它画的是设备实时电源状态（`mWakefulness` / `powerMode`），持久化它只会跟用户的电源键打架。

## 声音在哪出声：**设备级一条会话，每台设备只有一个窗口承载它**（2026-10-14 定稿）

- **2026-10-14 实测确认：同一台设备上并发两条 REMOTE_SUBMIX 采集会互相破坏。** 用户报「打开两个镜像声音重叠、关掉一个声音又回到手机」。设备侧受控实验（`af3d7abd`，`dumpsys media.audio_policy`）：
  - 一条采集时正常：多一个 `IOProfile name:r_submix output`、`Devices: {AUDIO_DEVICE_OUT_REMOTE_SUBMIX}` 的输出 ⇒ 应用音频被截走（手机静音、电脑出声）。
  - 再起一条采集（音频-only 探针）：**两条都被接受**（`Inputs (2)`，各自 1 个 `State: Active` 的 `AudioRecord` client），路由仍指着 r_submix ⇒ **两条都拿到同一份混音 ⇒ 两个窗口都放 = 重叠**。
  - **释放其中任意一条**（我的探针结束）：剩下那条**仍是 `Active`**，但 `AUDIO_DEVICE_OUT_REMOTE_SUBMIX` 那个输出**整条消失**（应用输出被挪回 `deep_buffer_out → SPEAKER`）⇒ 声音回到手机扬声器，电脑那边只剩静音。**路由是按"最近一次采集的生死"重置的，不是按引用计数。**
  - ⇒ 结论：**音频是设备级的一条流，不是窗口级的**。同一台设备**同时只能有一条采集**，且它的生命周期不能挂在某一条窗口上。
- **2026-10-14 落地（第三条，已全绿）**：镜像会话**恒 `audio: false`**（`buildMirrorOptions` 写死）；另起一条**纯音频会话**（`buildAudioOnlyOptions` = `{video:false, audio:true, control:false, sendDeviceMeta:false, sendStreamMeta:true, audioCodec:'opus', audioSource:'output'}`，jar 走**独立路径** `AUDIO_SERVER_PATH = /data/local/tmp/scrcpy-server-audio.jar`），由该设备**最早打开的镜像窗口**承载（`electron/mirror/audioHost.js` 的 `pickAudioHost`，纯函数 + 单测），那个窗口关掉时交给下一个幸存者（`mirror:audioHost`，**等旧窗口 `closed` 之后才发**）。设置页「声音输出」现在的语义 = **要不要起那条音频会话**（`resolveRuntimePrefs().audio`）。
  - ⚠️ **起新采集前必须先确认设备侧把旧的拆干净了**（`mirror:audioIdle` → 主进程轮询 `dumpsys media.audio_policy | grep -c 'Devices: {AUDIO_DEVICE_OUT_REMOTE_SUBMIX'`，上限 4s）：**释放要 1.24~1.30s，不是瞬时的**（三轮 1283/1241/1298ms）。反序实测（新采集先起、旧的随后释放）：新会话**一直在收包**（461 个）但设备侧 `Outputs` 从 9 掉回 7、`Devices:` 不再指向 `REMOTE_SUBMIX` ⇒ **声音回手机、包照收** = 用户报的那个症状。
  - ⚠️ `Devices: {` 前缀不能省：`Audio Patches` 段里那个同名字符串是**静态配置**，一直在。
- **并行建两条会话几乎免费**（实测）：并行推两份 733KB jar 与推一份同为 ~1.28s，两条 `start()` 合计 ~0.31s，第一条音频包 ~1.72s —— 与单条视频会话（~1.65s）同时。所以「单窗口也走伴随会话」不亏，而且**只有一条音频路径**更好维护。
- 未做的优化（`docs/TODO.md` 与 `NATIVE_MIRROR.md` 都记了）：接管空档 ≈ 1.3（等放开）+ 1.6（推 jar + start）≈ 2.9s；把音频 jar 在建镜像会话时**顺手并行预推**能降到 ~1.6s（代价：每窗口多推一份 733KB，并行时几乎免费；且要处理「宿主的音频 server 启动时会删掉自己那份 jar」这个竞态）。用户没提，先不做。
- 用户口径最终版（10-11 深夜）：「这个不要抄了，把现在音频这个功能切换相关的代码删掉，就保留默认」⇒ **仍然没有运行时切换**（`openAudioSession` / `setAudioOnComputer` / 悬浮栏那颗按钮 / 探针 `pnpm audio:spike` 都不存在，别照着旧记录找）。10-11 删它是因为「切到电脑」一次要 1.8–3.5s（推 jar 1245ms + 起 server ~290ms + 音频元数据 ~280ms + 编码器首包 ~1.2s）—— **2026-10-14 那个形态又回来了，但理由完全不同**（修并发破坏，不是为了切换）。
- ⚠️ **设备在投屏期间不出声，是 scrcpy 建会话时给音频路由定死的**（默认 `audio_source=output` → `AudioDirectCapture` 走 `REMOTE_SUBMIX`，采到回环就不再渲染到设备），控制协议里**没有任何音频路由消息**（随包 5.0.1 `Controller.java` 的 23 种 `TYPE_*` 里没有一项管音频）⇒ 想让某条**已经在跑**的会话开始/停止出声只能整条重来 —— 这正是音频要单独一条会话的原因（接管时只动音频，画面/虚拟显示/应用归属一律不碰）。**这条不会因为升 scrcpy 而改变**。
- 机制事实（都在用）：① **每条会话都要自己推一次 jar** —— `Server.java:249` 建会话就 `CleanUp.unlinkSelf()` 删掉自己那份（所以两条会话必须用**不同路径**，不然互相踩，实测第二条不重推直接 `Aborted`），一次 1.25s；② **音频-only 会话必须 `sendDeviceMeta: false`** —— 上游把 64 字节设备名写在**第一个 socket** 上，没视频时那就是音频 socket，客户端会把设备名头 4 字节当编码号（真机报 `Unknown audio codec metadata value: 1298735153` = `0x4D692031` = "Mi 1"）；③ 服务端采不到音频时把流标 `disabled`（**不是抛错**，`audioStream` 回来的对象没有 `codec`/`stream`）⇒ 要显式认这一档，否则就是「点了没反应」。
- 澄清两条源名口径（免得被带偏）：`mic` / `mic-*` / `voice-*` 全是**采麦克风**，与「手机出声还是电脑出声」无关；`audio_dup` 只作用于 `playback` 源，对默认 `output` 直采源是空操作。Tango 从 2.6 起就暴露 `audioSource: "playback"` 与 `audioDup`（旧结论「得先让 Tango 暴露它」是错的）。
- 「静音」那一档（`capture on` + 本地 `gain 0`，与「电脑」一样让设备静音）用户 10-11 明确**先不做** —— 别当需求捡回来。
## 设备电源状态：`Hangup` 与「屏灭」判据

- 设备两条一手读数（一次 adb 调用一起拿，见 `electron/adb.js` 的 `getPowerState`）：`mWakefulness`（`dumpsys power`）+ SurfaceFlinger 的 `powerMode`（`dumpsys SurfaceFlinger`）。
- ⚠️ **`Hangup` 态下 `powerMode` 报的是 `On`**（面板物理灭着、合成照跑）—— 所以**不能拿 `powerMode` 判 `Hangup` 的屏灭**，要按 `mWakefulness` 认。
- 判据分两个集合（`src/mirror/sleepWatch.js`，**语义不同别合并**）：
  - `FROZEN_STATES = {Asleep, Dozing}` → 「要不要弹『已休眠』」（画面是否停帧）。
  - `PANEL_OFF_STATES = FROZEN_STATES + Hangup` → `panelIsOff()` 用它判「算不算屏灭」。
- **`Hangup` 只在 bedtime（超时灭屏）那条路上出现**；**按电源键**走 `goToSleep` → `Asleep`。而 `mStayOn=true`（`stay_on_while_plugged_in=7` + 插电）会让 bedtime 压根不发生 —— 复现 `Hangup` 前先确认这两点。
- **把屏弄亮的两条路能力不同**（`needsRealWake()` 分流）：设备不是 `Awake`（`Asleep`/`Dozing`/`Hangup`）时必须走**真唤醒** `input keyevent 224`（`setDisplayPower(Normal)` 唤不动，实测 `Hangup` 下发后 8 秒仍 `Hangup`）；设备 `Awake` 时屏是我们用 `setDisplayPower(OFF)` 关的，回 `Normal` 就对（不占 `INJECT_EVENTS`，更稳）。
- **`Hangup` 下触摸注入不会被丢弃**（10-11 实测）：注入「下拉通知栏」、**不唤醒**直接 `screencap`（Hangup 下 SF 照常合成，截图有效）能拿到已展开的通知栏。**但注入触摸不是唤醒路径** —— 普通 `Asleep` 下同样唤不醒（对照组），非 `Hangup` 特有。⇒ 镜像里点击/滑动能用，但点一下不会把手机点醒；唯一唤醒入口仍是 `input keyevent 224`。
- **手工复现 `Hangup` 的命名空间**：`settings put `**`secure`**` synergy_mode 1` —— 写成 `global` **静默无效**（`beginSynergy()` 读 `Settings.Secure`），设备会照常走普通 `Asleep`。配 `stay_on_while_plugged_in=0`，唤醒后静置过 `screen_off_timeout` 即进 `Hangup`。

## 镜像会话的收摊：只有一个入口

- `electron/mirror/session.js` 的 **`stopMirrorSession(id)` 是唯一收摊入口**（还原 `miProjectionRestore` / `keepAwakeRestore`、`releaseMacKeyboard`、关窗、`goHome`）。关窗 / 断开设备 / ⌘Q / **server 意外退出**四条路都走它。
- ⚠️ **别在别处 `sessions.delete(...)` 代替它**：还原函数挂在会话记录上，记录一删就再也调不到，设备的 `synergy_mode` / `stay_on_while_plugged_in` / 默认输入法会永远留在我们改过的值上（2026-10-11 修过一次：`mirror:state` 的 `exit` 分支就踩了这个）。
- 重复调用安全：`if (!session) return false` ⇒ 后到的那个自然空转，所以两条路撞上不用加锁。
- ⚠️ **`stopMirrorSession` 是在窗口 `closed` 的处理器里被调的**（`createMirrorWindow` 里那行 `win.on("closed", …)`）⇒ 那一刻窗口**已经销毁**（`isDestroyed()` 为真）。**任何"等这个窗口真的关掉再做事"的逻辑，都不能指望在 `closed` 派发途中挂上去的 `once("closed")` 监听** —— `emit` 对本次用的是监听器快照，它永远不会为这一次触发。要么用 `isDestroyed()` 早退走"当场做"，要么挂 `close`（早一拍）。（2026-10-14 音频移交给接手的那个窗口就踩在这上面：早退分支才是生产路径，`once("closed")` 只兜「窗口还活着」那条路。）

## 「插电不休眠」泄漏的症状与判据（排障用）

- 症状：**退出镜像后手机亮度像被调到最低、而且屏幕不灭**。
- 判据（别去翻亮度代码 —— 全仓库没有任何写设备亮度的地方）：
  ```
  adb shell settings get global stay_on_while_plugged_in   # 停在 7 = 我们的残留
  adb shell dumpsys power   | grep -E "mStayOn=|mWakeLockSummary=|mUserActivityTimeoutOverride"
  adb shell dumpsys display | grep -E "policy=|mBrightness="
  ```
  典型读数：`mStayOn=true`、`mWakeLockSummary=0x0`（不是 wakelock）、`policy=DIM`、`mBrightness == mScreenBrightnessDimConfig`。
- 机制：`mStayOn=true` ⇒ `isItBedTimeYetLocked()` 为假 ⇒ 超时那条路走不到 `goToSleep` ⇒ 显示策略**永远停在息屏前的 `DIM`** ⇒ 屏幕亮着、最暗、不灭。**是"卡在变暗档"，不是"亮度被调低"。**
- 修：`adb shell settings put global stay_on_while_plugged_in 0`（AOSP 默认；7 是 app 写的值，所以 7 基本可判定为我们的残留）。

## 从本 agent 里把应用跑起来做真机验收（2026-10-14 跑通过，照抄这套）

- ⚠️ **`ELECTRON_RUN_AS_NODE=1` 会继承进来**（WorkBuddy 自己是 Electron）。不清掉的话 Electron 会**当 node 跑**，报 `The requested module 'electron' does not provide an export named 'BrowserWindow'`。⇒ 一律 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS <cmd>`。
- ⚠️ **`pnpm dev` 的 vite 与它拉起的 Electron 同生共死**（杀掉 Electron，vite 也退）⇒ 给 Electron 加参数（`--remote-debugging-port`）不能"杀子留父"，走**生产包**：`env -u ... npx electron . --no-sandbox --remote-debugging-port=9333`（`dist/` + `dist-electron/` 建好即可，无 `VITE_DEV_SERVER_URL` 就走 file://）。**9222 常被 Chrome 占，用 9333。**
- 驱动 = **CDP + 生产 IPC**：`curl 127.0.0.1:9333/json/list` 拿目标 → `Runtime.evaluate`（`awaitPromise`）里调 `window.electronAPI.mirror.*`（`config` 从 `electronAPI.scrcpyConfig.get()` 拿）。**镜像窗**另有 `window.__anddriveIpc`（非隔离窗口 preload 才挂）：`invoke('mirror:initGet')` 认身份 / 埋 `ipc.on('mirror:audioHost')` 探针。**关窗用渲染层 `window.close()`**（= 用户点红点那条路，比 `mirror:stop` 更真）。
- ⚠️ `startMirrorSession` 会**复用**同 `serial + packageName` 的既有会话 ⇒ 开第二个窗口必须**换包名**（`com.miui.calculator` / `com.miui.notes` 好用）。
- 收摊记得：删临时脚本（用完即删）、把用户的 `pnpm dev` 起回来。

## 设备与音频实测基线（2026-10-14 更新）

- 当前测试设备 `af3d7abd` 报的是 **model 2509FPN0BC / Android 17 / SDK 37** —— 旧记录里同一个 serial 写的是 **Mi 10 / Android 13**，**设备换过了**，别再按 Mi 10 的口径推。
- 判据（都真机验过）：采集数 = `adb shell "dumpsys media.audio_policy | grep -c 'Devices: {AUDIO_DEVICE_OUT_REMOTE_SUBMIX'"`（**`grep -c` 无匹配时退出码 1，要 `|| true`**，只看 stdout 数字）；"在实时收"看 `dumpsys media.audio_flinger` 里 REMOTE_SUBMIX **输入**线程（`type 3 (RECORD)`）的 `Frames read` 增量（48kHz 下 4 秒 ≈ 19.2 万帧）；进程用 `ps -A -o ARGS | grep 'scrcpy.Server'`（`ps -A | grep com.genymobile.scrcpy` 匹配不到）。
- **双窗口音频已端到端验收通过**（两窗共存时设备侧恒 1 条采集、关宿主窗后 +276ms 推送到幸存者、采集 1422ms→0 / 1745ms→1、新音频会话 scid 换新、关非宿主窗全程无波动）。全部读数见 `docs/NATIVE_MIRROR.md` §3「音频转发」那条。

## 工程约定（本仓库）

- 纯换算/判据抽成可测模块（`src/mirror/*.js` + `tests/mirror/*.test.js`），组件里只绑样式。
- 改完必跑：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`npx vite build`。
- 改动同步 `docs/NATIVE_MIRROR.md`（按 Slice 编号累加"第 N 轮"）与 `docs/TODO.md` §6.2。
