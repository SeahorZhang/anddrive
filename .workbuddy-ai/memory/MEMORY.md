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
- ⚠️ **这三颗开关的状态都不跨会话保存**（窗口级一次性开关）：用户 2026-10-11 一度点单「记住我点的选项」、已实现后又当天撤销 —— **别再把它当需求捡回来**。要恢复得进 `prefs`（`shared/scrcpyConfig.js` 的 `normalizeScrcpyConfig` + `resolveRuntimePrefs`），且「关屏使用」那颗**永远不该进** —— 它画的是设备实时电源状态（`mWakefulness` / `powerMode`），持久化它只会跟用户的电源键打架。

## 声音在哪出声：**只有默认档，运行时切换已删**（2026-10-11 当天做当天删）

- 用户口径最终版（10-11 深夜）：「这个不要抄了，把现在音频这个功能切换相关的代码删掉，就保留默认」⇒ 现在音频**恒在画面那条会话里**（`buildMirrorOptions` 的 `audio` = 设置页「声音输出」，默认开 = 声音转到电脑、投屏期间手机静音），**没有运行时切换**；`buildAudioOnlyOptions` / `startAudioScrcpy` / `openAudioSession` / `setAudioOnComputer` / 悬浮栏那颗按钮 / 探针 `pnpm audio:spike` **全都不存在了**，别照着旧记录找。
- ⚠️ **设备在投屏期间不出声，是 scrcpy 建会话时给音频路由定死的**（默认 `audio_source=output` → `AudioDirectCapture` 走 `REMOTE_SUBMIX`，采到回环就不再渲染到设备），控制协议里**没有任何音频路由消息**（随包 5.0.1 `Controller.java` 的 23 种 `TYPE_*` 里没有一项管音频）⇒ 运行时改这一档只能整条会话重来。**这条不会因为升 scrcpy 而改变**。
- 删它的实测理由（Mi 10 / 随包 5.0.1，别再重走）：独立音频会话形态**能跑**，但一次「切到电脑」**1.8–3.5s 才出第一个音频包** = 推 jar 1245ms + 起 server ~290ms + 音频元数据 ~280ms + 编码器首包 ~1.2s，还偶发 `disabled` 要重试；每个窗口多推一份 733KB jar、多起一个 server 进程。
- 机制事实留着（哪天真要做常驻 agent 才用得上）：① **每条会话都要自己推一次 jar** —— `Server.java:249` 建会话就 `CleanUp.unlinkSelf()` 删掉 `/data/local/tmp` 那份，第二条不重推就 `ClassNotFoundException`，所以「推一次两条会话共用」不是优化；② **音频-only 会话必须 `sendDeviceMeta: false`** —— 上游把 64 字节设备名写在**第一个 socket** 上，没视频时那就是音频 socket，客户端会把设备名头 4 字节当编码号（真机报 `Unknown audio codec metadata value: 1298735153` = `0x4D692031` = "Mi 1"）；③ 服务端采不到音频时把流标 `disabled`（**不是抛错**，`audioStream` 回来的对象没有 `codec`/`stream`）⇒ 要显式认这一档，否则就是「点了没反应」。
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

## 工程约定（本仓库）

- 纯换算/判据抽成可测模块（`src/mirror/*.js` + `tests/mirror/*.test.js`），组件里只绑样式。
- 改完必跑：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`npx vite build`。
- 改动同步 `docs/NATIVE_MIRROR.md`（按 Slice 编号累加"第 N 轮"）与 `docs/TODO.md` §6.2。
