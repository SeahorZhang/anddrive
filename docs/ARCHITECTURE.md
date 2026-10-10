# AndDrive 架构与约定

> **这份文档是什么**：读代码前该知道的地图 —— 进程怎么分、数据怎么流、每条链路的真入口在哪、哪些设计是**刻意**的（别顺手"优化"掉）。
> 所有 `file:line` 于 2026-09-28 逐条核对过当前代码。**不一致时以代码为准**，并请顺手改这份文档。
> 待办与缺陷见 [`TODO.md`](TODO.md)；镜像引擎的取证记录与实测数据见 [`NATIVE_MIRROR.md`](NATIVE_MIRROR.md)；Helper 的输出契约见 [`../helper-app/README.md`](../helper-app/README.md)；**adb 的完整调用清单与「能不能不用 adb」的判定**见 [`ADB_DEPENDENCY.md`](ADB_DEPENDENCY.md)。

## 1. 形态

Vue 3 + Electron（vite / rolldown），**仅 macOS Apple Silicon** 的 Android 设备管理器（USB 有线 / 无线调试两种传输）+ 自研镜像（投屏）客户端。代码分四块：主进程 + `shared/`（**`electron/adb.js` 是全仓最大文件**，8 个职责挤在一起，见 `TODO.md` O1）、渲染层 `src/**`、测试 `tests/`（vitest，纯逻辑为主）、设备侧 Helper（一个 Java 类）。规模数字不写在这里 —— 会过期，用 `cloc`/`wc` 现量。

```text
主窗口 (isolated)          镜像窗口 (nodeIntegration, contextIsolation:false)
  src/**                     src/mirror/**
  window.electronAPI         window.electronAPI + window.__anddriveIpc(裸 ipcRenderer)
        │ invoke                     │ 直接跑 TCP/帧路径，也 invoke 拉参数
        ▼                            ▼
  electron/main.js ──── electron/mirror/session.js（建窗、下发参数、会话记录）
        │
  electron/adb.js ── adb / mdns / helper / 缓存 / 设备统计 / ~25 个 IPC handler
```

**关键取舍：帧路径不过 IPC。** 镜像窗口里解码、渲染、音频、控制序列化全在渲染进程完成（`src/mirror/connect.js` 用 Tango 官方库直连 adb server），主进程只负责建窗、给参数、记会话。代价是镜像窗口必须 `nodeIntegration` + 关掉隔离（`electron/preload.js:7-16`），**已知并刻意**；`preload.js` 只在隔离时走 `contextBridge`，非隔离时直接 `window.__anddriveIpc = ipcRenderer`。

由此派生两条硬约束：

1. `src/mirror/connect.js` **不得静态 import `@yume-chan/*`**，必须经 preload 注入的 `window.require` 拿同一份模块副本。Vite 打包出第二份实例时，`PushReadableStream` / `MaybeConsumable` 跨副本写流会挂死（已踩过，见 `NATIVE_MIRROR.md` §2.1）。
2. `vite.config.js` 里把镜像页与主页的共享代码拆成独立 `mirror-support` chunk 的 `advancedChunks` 配置**勿删** —— 合并会让镜像页执行主页的 `createApp().mount('#app')`。

## 2. IPC 契约

通道字符串**只该出现在三处**：`electron/ipcContract.js`（定义）、`electron/preload.js`（包装）、`electron/main.js` / 各模块（注册）。语义约定：跨桥抛出的 `Error.message` 必须是**可直接展示给用户的中文文案**，渲染层不再做二次翻译。

按域分组（`electron/ipcContract.js:8-73`）：连接发现与设备状态（`adb:*`）、应用操作（`adb:forceStop` / `clearData` / `uninstallApp` / `getAppInfo` / `exportApk`）、设备统计（`adb:getDeviceStats`）、镜像（`mirror:start|list|stop|stopAll|focus` + `mirror:initGet` 渲染层主动拉参数以避免时序竞态 + `mirror:exit` / `mirror:state` / `mirror:result` 三个下行事件）、镜像→设备的应用搬移（`mirror:appTask` / `mirror:moveTask`，注意**这两个注册在 `adb.js` 里**，不在 mirror 目录）、权限（`permissions:*`）、收藏（`favorites:*`）、全局参数（`scrcpyConfig:get|set`）、快捷方式（`shortcut:*`）。

⚠️ 已知脏点：各模块在 import 时自注册 handler（`electron/adb.js` 一个文件就注册 23 个，全仓 39 个），所以「谁提供哪个通道」只能靠 grep。（曾有的 `installHelpera` 拼错已在 2026-09-28 改正 —— 这类错误 tsc 抓不到，因为渲染层是从无类型标注的 `window.electronAPI.adb` 上解构，改完要**对构建产物**验两侧同名。）

## 3. 链路的真入口

| 链路 | 入口 | 事实 |
| --- | --- | --- |
| 扫码配对 | `src/components/AddDeviceDialog.vue` 的 `start` | 就在组件里，**没有 `usePairing` composable**。随机 SSID+密码 → `uqr` 出 `WIFI:T:ADB;…` SVG → `findDeviceApi()` 等 `_adb-tls-pairing._tcp` → `pairApi` → `resolveConnectAddressApi(name)` → `emit('paired')` 交给父层。状态只有 `idle|waiting|error`，成功分支直接交给外面。外壳是 reka-ui `DialogRoot`（Esc / 焦点陷阱 / 角色白拿），`devices` 由 `App.vue` 的 `discoveredDevices` 灌进来当「可用设备」，点「连接」`emit('connect')` 走 `connectDevice` |
| 发现与接管 | `src/App.vue:217-237` `discoverLoop` | 1s 轮询 `adb mdns services` + `adb devices`；连上即停；令牌递增让后一次调用取代前一次。**扫码弹窗开着时不接管**（`:223-226`，否则右上角列表被清空） |
| 心跳与重连 | `src/App.vue:59-73` / `:122-145` | 5s 查 `getDeviceState`，3s 退避重连 ×10。超时被 `adb.js` 归为 `offline`，所以心跳真能发现掉线 |
| 设备标识 | `electron/deviceIdentity.js` | 收藏、应用缓存、快捷方式都按 `ro.serialno` **稳定标识**存，落盘别名表 `device-aliases.json` 反查当前传输地址（无线重连一次地址就换，早期按地址存会裂成多个桶） |
  **不做老用户兼容**：只认稳定标识键（外加别名未建立时写过的传输地址键）；stable-id 之前留下的地址桶不再回收。
| 应用列表 | `electron/adb.js`（helper `app_process`）+ `src/components/home/AppList.vue` | 范围 = **凡 LAUNCHER 拉得起的都列（含系统应用）**；helper 不再按 `FLAG_SYSTEM` 过滤（9-29 改：HyperOS 的「设置」带 SYSTEM 位、日历/计算器更新过反而不带，按这个位筛会随机缺项）。两阶段：先包名/标签，再补图标。`ICON_BATCH_SIZE=20`、并发 3（`AppList.vue:34-39`）。**图标不在 JSON 里**：每张单独成文件 `userData/app-cache/icons-v1/<稳定标识哈希>/<包名哈希>.png`，年龄看文件 mtime（7 天过期）；快照 `apps-v1/<标识哈希>.json` 只存包名与标签，90 天过期、写盘 tmp+rename 原子。冷启动由主进程读本地文件把 `iconUrl` 补回返回值，渲染层拿到的仍是 data URL |
| 列表排序 | `AppList.vue:68-78` | **收藏组置顶 + 设备返回原序**；没有 MRU、没有 `orderApps()`、没有 `appOrdering.js` |
| 投屏启动 | `electron/mirror/session.js` 的 `startMirrorSession` → `mirrorInitGet` → `src/mirror/direct-session.js` 的 `bootstrap`/`startSession` | 同设备同应用只开一个窗口（`findAppSession` 命中就 focus 并返回 `reused: true`）；会话起来后 `startApp` + `ensureAppHere` 搬任务 |
| 画质档位 | `shared/scrcpyConfig.js` `DISPLAY_QUALITY_TIERS` + `DISPLAY_QUALITY_BIT_RATES` | compat 1.5 / native 2 / sharp 3（默认 sharp）。**倍率只在大屏模式生效**（2026-10-07 起）：那条路虚拟显示尺寸 = 窗口 CSS × 倍率、dpi = 160 × 倍率，于是 **1dp = 1 CSS px**；默认（上游产物）显示就是主屏尺寸与密度，档位在这条路上**只换码率**。**码率上限按档位走**（8M / 16M / 32M），设置页里两者是**同一个下拉**——实测每档稳态码率差 5 倍，拆开只会配错；存盘仍是 `quality` + `bitRate` 两个字段，老配置对不上预设时下拉列一项标灰的「自定义」，不改用户的值（唯一例外：改版前的出厂组合 `sharp + 24M` 由 `normalizeScrcpyConfig` 升级到 `sharp + 32M`）。倍率与码率都**只在开会话时生效**（`resizeDisplay` 不带 dpi；5.0/5.0.1 的控制消息里也没有改码率的） |
| 桌面快捷方式 | `electron/shortcutCore.js`（纯逻辑）+ `electron/shortcut.js` | `.adr` = 正式 UTI `com.anddrive.mirror-shortcut` + `LSHandlerRank: Owner`（只声明后缀会被历史构建副本抢走）；文件里存稳定设备标识，打开时反查地址，参数取主进程最新全局配置。历史注册清理：`pnpm run shortcut:fix` |
| Helper | `helper-app/…/ListMain.java`，以 `app_process`（shell uid 2000）一次性执行 | **零权限、零后台组件、不监听端口**，stdout 一行 JSON 即退出。`QrPairActivity` 提供"跳到无线调试二维码页"，Mac 侧至今没调用过 |
| 设备统计 | `electron/adb.js` `getDeviceStats` | getprop/df/battery/meminfo/loadavg/ip 并行采集，30s 缓存 + force 刷新；`df /data` 失败退到 `df /` |

## 4. 刻意设计（别当冗余清理）

- **adb 超时阶梯**（`electron/adb.js` 顶部的 `ADB_CONNECT_TIMEOUT_MS` / `ADB_TRANSFER_TIMEOUT_MS` 等常量）：默认 15s / connect-pair 45s / 安装卸载拉文件 5min。transport 半死时子进程既不退出也不报错，全靠这层兜住并把超时归为 `offline`。
- **ROM 怪癖嗅探**：卸载「报 Failure 却退出 1」、装 Helper 与 `clearAppData` 靠 stdout 里 `/Success/i` 判定、`exportApk` 靠 `N files pulled` 正则、helper 输出取最外层 `{`…`}` 以躲 linker/ART 噪声（都在 `adb.js`：`uninstallHelper` / `installHelper` / `clearAppData` / `exportApk` 与 `normalizeListOutput`）。这些丑但**是真需要的**。
- **投屏时手机静音**：服务端 `ROUTE_FLAG_LOOP_BACK`（不传 `audio_dup`）是刻意的 —— 只回环、不在本机渲染。副作用也已知：会话结束、AudioPolicy 撤销后手机当场出声，这不是 bug。要两边同时出声才需要 `audioDup`。
- **`displayFollow` 用 debounce 不用 throttle**：`RESIZE_SETTLE_MS = 250`（`src/mirror/displayFollow.js:13-23`）。真机量过：throttle 每 150ms 发一步，服务端 300ms 去抖**并没有**合掉中间值，每一步都真的重排虚拟显示 → 画面"转好几次"。相同尺寸直接丢弃，因为重复 `resizeDisplay` 会让服务端白走一次 `virtualDisplay.resize()` → capture reset。
- **随包有两份 scrcpy server 产物，设置页「大屏模式」切它们**（2026-10-07 改，2026-10-09 升到 5.0.1）：默认 `resources/scrcpy/scrcpy-server` 是**上游 5.0.1 官方产物**（release 资产 `scrcpy-server-v5.0.1`，dex 里 `anddrive` 字符串 0 次）；`resources/scrcpy/patched/scrcpy-server` 才是自编那份（走隐藏的 `VirtualDisplayConfig.setIgnoreActivitySizeRestrictions`，带 `debug.anddrive.vd.isr` / `.pres` / `.rot` 三个 prop）。**判据只有 `shared/scrcpyConfig.js` 的 `scrcpyServerResource(config)` 一处**，主进程拼路径与 spike 都读它；两份烤进去的协议版本号都必须等于 `SCRCPY_SERVER_VERSION`（`scripts/verify-resources.mjs` 逐个查，少一份或版本不匹配都是白屏）。补丁的两份 .java 原文留档在 `~/code/scrcpy-5.0.1-patched/anddrive-patch/`（那棵树 = 上游 5.0.1 + 这两份覆盖），要改补丁先从那里拷回去再编 —— 产物是唯一能拿出补丁效果的东西，别顺手删 `patched/`。
- **一个会话有两种形态：建虚拟显示的单应用镜像，与采主屏的镜像**（2026-10-09 加「镜像手机」，同日加「Android 13 及以下点应用也采主屏」）：**判据两条**——`packageName` 为空，或设备 API 级别 ≤ 33（`mirrorsMainDisplay`，读不到版本不算）；在主进程 `startMirrorSession` 一处定成 `pendingInit.deviceMirror` 再下发，渲染层不自己猜。
  - **建虚拟显示**（Android 14+ 点应用图标）= 带 `new_display` 新建一块虚拟显示 + `startApp` 把应用搬上去 + `flex_display` 跟随窗口 + 「接回画面」。
  - **采主屏**（顶栏「镜像手机」，以及 13 及以下点应用）= **连 `new_display` 这个键都不发**。上游的分叉点在**键在不在**（`Server.java:144-149`：`getNewDisplay() != null` → `NewDisplayCapture`，否则 → `ScreenCapture` 采主屏）；⚠️ **发空串不等于不发**：空串是「新建一块主屏尺寸的显示」这个**值**的语义。实测随包 5.0.1 官方产物：不发键 → server stdout `Display: using SurfaceControl API` 且没有 `New display: … (id=N)` 那行。
  - 于是采主屏这一档**没有**：可 resize 的显示（跟随窗口与重排遮罩整块跳过，见 `direct-session.js` 的 `initialDisplay` 与 `if (createdDisplay)`）、「这块显示上的应用」（接回轮询跳过）、补丁产物的用武之地（`scrcpyServerPath({ largeScreenDisplay: false })` 显式要官方那份）。窗口改大小只剩本地缩放主屏画面，`vd_system_decorations` 也不发（主屏的状态栏本来就在）。
  - **13 及以下点应用时 `startApp` 照发**（渲染层的门槛是 `packageName` 有没有，不是 `deviceMirror`）：上游 `Controller.getStartAppDisplayId()` 在没有新建显示时用 `display_id` 的缺省值 **0 = 手机主屏**，所以这条控制消息正好把 app 开在手机屏幕上 —— 这就是「不用虚拟屏幕打开 app，直接手机打开它再镜像」。整场只有 14+ 那一档需要接回，所以接回轮询仍按 `deviceMirror` 跳过。
  - 会话键仍是「设备 + 包名」，整机就是「设备 + 空」⇒ **一台设备一个整机镜像窗口**，再点唤到前台；label 退「手机镜像」。13 及以下点应用仍按「设备 + 包名」记会话（同一个 app 只开一个窗口、窗口标题是应用名），换别的 app 是**另一个窗口**，两个窗口看的是同一条主屏画面。
  - **关掉这种会话时把手机放回桌面**（`goHome`，判据 `session.returnsHome = 带着包名 && mirrorsMainDisplay(sdk)`）：那个 app 是我们 `startApp` 到手机屏幕上去的，窗口都关了不该让它停在手机上（用户 2026-10-09：「我在电脑上关闭镜像后，手机上要回到桌面」）。**虚拟显示那档与整机镜像都不动手机** —— 前者 app 在我们那块显示上、会话结束显示就没了，后者没有「我们打开的 app」。走的是 `am start -a MAIN -c HOME`，**不是 `input keyevent KEYCODE_HOME`**：实测 MIUI 14 上按键没生效（焦点在 `NotificationShade` 时 `mFocusedApp` 纹丝不动），而 `am start` 这条不占 `INJECT_EVENTS`。尽力而为、失败不抛（设备已断开时必然失败，不该拖住关窗）。
- **设备侧登记有两条，两条都必须还原**（关窗 / 断开设备 / ⌘Q 都汇到 `stopMirrorSession` 一处）：
  - `miProjection.js`：往 `Settings.Secure` 写 `synergy_mode=1`（只 MIUI/HyperOS），让 HyperOS 息屏后仍继续合成那块采集显示。
  - `keepAwake.js`：往 `Settings.Global.stay_on_while_plugged_in` 写 7（**只 Android 13 及以下**，判据同为 `mirrorsMainDisplay(sdk)`）—— 那一档采的是手机那块屏，**面板灭了就没帧可采**，而它没有 `Hangup` 这扇门（用户 2026-10-09：「低版本安卓不会进入 hangup，所以需要用 keepawake 的能力」）。因为这条判据现在对空包名也要用，`startMirrorSession` **每台设备都读一次 `ro.build.version.sdk`**（与 `wm size`/`wm density` 并列发，不多等一个来回）。
  - 两条写法不同是有原因的：`synergy_mode` 是布尔开关，关会话置 0 就行；`stay_on_while_plugged_in` 是**用户自己的电源偏好** ⇒ 开之前先读原值、最后一个会话关掉时原样写回，**读不到原值就一个字节都不写**（宁可这次不保活，也不把用户的设置留在我们手里）。同一台设备多个会话按**引用计数**共用一次改写 —— 关掉其中一个窗口不该撤掉另一个还在用的保活；第二个会话**绝不重新读**（那时读到的 7 是我们自己写的）。
- **镜像窗口报「已休眠」，但不自己弹醒**：`src/mirror/sleepWatch.js` 轮询设备的**两条**电源读数（`mWakefulness` = 睡没睡，`dumpsys SurfaceFlinger` 的 `powerMode` = 面板亮没亮），只有 `Asleep`/`Dozing` 算休眠（HyperOS 的 `Hangup` 灭屏仍合成，报休眠就是谎报；一次 adb 失败当「不知道」，不弹点不动的横幅）。**轮询把两条读数一起报出来，第一次读也报**（`onChange(asleep, state)`，`state = { wakefulness, screen }`；两条全空才算「不知道」，任一变了就报，读失败那一拍只是跳过、链子不断），页面里凡是跟屏有关的状态都从它派生：「已休眠」= `FROZEN_STATES.has(wakefulness)`，长条那颗「关屏使用 / 恢复亮屏」= `screen ? screen !== 'ON' : FROZEN_STATES.has(wakefulness)`。⚠️ **那颗按钮必须看第二条读数**（用户 10-10「关掉屏幕按钮再点一次要可以点亮」）：`setDisplayPower(OFF)` 只关面板、`mWakefulness` 全程 `Awake`，只看睡没睡它就永远翻不回来；`Hangup` 也画灭屏（不算休眠但屏确实灭了）。⚠️ 别在页面里另记「是不是我们关的」：轮询一旦没观察到醒（MIUI 走 `Hangup`，根本不进 `Asleep`）那个标记会永远挂着，把「继续使用」那颗按钮整个吃掉（用户 10-10 报的「手按电源键后镜像提醒恢复的按钮没了」）。**快慢两档**（用户 10-10「已休眠、点继续使用不灵敏」）：平时 `intervalMs = 1500` 慢轮询（每拍一次 adb），`kick()` 之后转 `fastMs = 300` 快轮询、持续 `fastWindowMs = 5000` 再自己回慢档；`kick` 挂在三个时刻 —— 点「继续使用」、点「关屏 / 恢复亮屏」、长条刚被唤出来（他正要看那颗图标）。⚠️ **按钮成功之后也不要乐观改读数**：命令被接受 ≠ 设备真醒了（屏亮起到 `mWakefulness` 翻成 `Awake` 有几百毫秒，锁屏还会把它按回 `Dozing`），上一轮这么写过，结果「点亮屏幕后已休眠按钮就消失了，但其实手机无法操作」（用户 10-10），而且页面写的值会把轮询的比较基线带歪、再也纠不回来 —— **页面里 `powerState`（两条读数一起）只允许 `onSleepChange` 一个写入点**。灵敏度全靠 kick 的 300ms 快档。命中就在窗口盖「已休眠 + 继续使用」，**点了才**发 `input keyevent 224`（KEYCODE_WAKEUP，只唤醒不解密码锁；MIUI 上这条吃「USB 调试（安全设置）」那道闸，被拒时把设备原文第一行带回按钮旁）。这一条**不分会话形态**，也只是报告 + 等用户点，不动设备设置 —— 手按电源键是用户的决定，程序不抢着叫醒（9-29 那版「自动弹醒」的口径已被这次的竞品形态替掉）。
- **设备侧登记有两条，两条都必须还原**（关窗 / 断开设备 / ⌘Q 都走这里）：
  - `miProjection.js`：MIUI/HyperOS 会话写 `Settings.Secure.synergy_mode=1`（关会话写 0），让 HyperOS 息屏后仍合成 —— 那条门叫 `Hangup`。
  - `keepAwake.js`：**Android 13 及以下**的会话写 `Settings.Global.stay_on_while_plugged_in=7`（AC|USB|无线，等价 `svc power stayon true`）。这一档镜像的就是手机那块屏，**面板灭了就没帧可采**，而它没有 `Hangup` 那扇门（用户 2026-10-09：「低版本安卓不会进入 hangup，所以需要用 keepawake 的能力」）。判据同 `mirrorsMainDisplay(sdk)` ⇒ `startMirrorSession` 现在**每台设备都读一次 `ro.build.version.sdk`**（与 `wm size`/`wm density` 并列发）。
  - 两条写法不同是有意的一：`synergy_mode` 是布尔开关，归 0 即可；`stay_on_while_plugged_in` 是**用户自己的偏好设置**，所以开之前先读原值、最后一个会话关掉时原样写回，**读不到原值就一个字节都不写**（宁可这次不保活，也不把用户的设置留在我们手里）；同一台设备多个会话按**引用计数**共用一次改写，第二个会话**绝不重读**（那时读到的是我们自己写的 7，还原成 7 就把用户的值钉死了）。
- **设备睡了就在窗口里报「已休眠」，不自动弹醒**（`src/mirror/sleepWatch.js` + `App.vue`）：轮询设备的两条电源读数（`mWakefulness` 睡没睡 + SurfaceFlinger 的 `powerMode` 面板亮没亮），只有 `Asleep`/`Dozing` 算睡了 —— `Hangup` 不算（HyperOS 登记过的灭屏态仍出帧，报休眠就是谎报），一次 adb 读失败当「不知道」，不弹一个点不动的横幅。命中就盖一条「已休眠」+「继续使用」（竞品同名的两格），**点了才**发 `input keyevent 224`（KEYCODE_WAKEUP，只唤醒、不解密码锁；MIUI 上这条吃「USB 调试（安全设置）」那道闸，失败把设备原文第一行带回按钮旁）。这一条**不分会话形态**：只报告 + 等用户点，不动设备设置。手按电源键是用户的决定，程序不抢着叫醒。
- **`.catch` 吞掉的分寸**：设备侧探测类失败（读第三个 prop、卸载已卸载的 helper）允许吞；**用户操作的结果不许吞**（收藏写盘失败必须抛，渲染层据此回滚星标）。
- **虚拟显示与镜像窗口的尺寸各有唯一一个主人**（2026-10-07 分两种模式）：
  - **默认（上游原生产物）**：`new_display` = `<窗口画面区物理像素>/<按主屏长边等比的密度>`，并且**带 `flex_display`**（跟大屏模式一样跟随窗口）。两个数都不能省：尺寸 = CSS × `devicePixelRatio`，于是 1 个显示像素正好落在 1 个屏幕物理像素上，按 px 写死的控件（抖音弹幕、顶部那排 tab）不被整帧 downscale 压小；密度由 `shared/scrcpyConfig.js` 的 `scaleDisplayDpi` 算（与上游 `NewDisplayCapture.scaleDpi` 同式：`主屏密度 × 新长边 / 主屏长边`），于是长边 dp 数与主屏一致、版式仍由设备决定。**为什么密度要我们自己算**：上游只在**非 flex** 那条路上做 `scaleDpi`（`prepare()` 里 `if (dpi == 0) { assert !flexDisplay }`，release 包断言是关的）—— 实测 flex + 只给尺寸时 Android 退成**基准密度 160**（`756x1640/density 160` ⇒ 长边 1640dp，应用直接被当成超大屏），而带上算出来的密度就是 `density 308`（= 440×1640/2340）。设备密度从 `getPhysicalScreenDensity`（`wm density` 的 Physical，只读）拿。
  - **拿不到设备信息就不新建形状**：`screenSize` / `screenDpi` 任一为空 → 渲染层不给 `display` → `new_display` 传**空串**（上游默认 = 主屏尺寸与密度）且**不开 flex**（flex 缺尺寸会撞上面那条断言）。窗口此时退回既有的 850x600。
  - **跟随的代价两种模式一样**：`resizeDisplay` 只带宽高、不带 dpi，密度在建显示那一刻定死 —— 窗口变化后「1 显示像素 = 1 屏幕物理像素」继续成立，但长边 dp 数会随窗口漂移（`--max-size` 那类视频约束不参与）。
  - **大屏模式（补丁产物）**：显示像素只在 `src/mirror/direct-session.js` 的 `displayFor(css)` 一处算（= 窗口 CSS × 画质档位倍率，dpi = 160 × 倍率，1dp = 1 CSS px），建显示与后续 `resizeDisplay` 必须同源；窗口尺寸是这条链的**输入**，所以绝不照帧反推窗口。`formatNewDisplay` 是全项目唯一校验尺寸形状的地方（`dpi` 缺省就只写 `<宽>x<高>`），大屏模式拿不到尺寸直接抛 —— **别再加兜底默认尺寸**，任何写死的 `WxH/dpi` 都与画质档位不符。
  - **建完之后只能按手机比例拖**（2026-10-11 用户：「不可以随意更改，只能按手机比例拖拽宽度和高度」）：`createMirrorWindow` 一建好就 `win.setAspectRatio(ratio, mirrorContentExtraSize())` —— 上游这一条就是 AppKit 的 `contentAspectRatio`，拖哪条边由系统自己锁，**不用**我们在 `resize` 里回弹一次。**锁的是画面那块矩形、不是窗口**：`ratio` 取同一份 `wm size`（`mirrorAspectRatio(screenSize)`，与 `mirrorWindowBounds` 同源，两处各读一次会打架），窗口比画面多出的那圈黑框 + 右边长条算成**不参与比例的余量**走第二个参数（`mirrorScreenInsets()` 的横竖总量：横 4+(4+86)=94、纵 4+4=8）。dev 边栏撑宽的也是**窗口**、同一类余量 ⇒ `mirror:windowHud` 每次改完量再按 `mirrorContentExtraSize(next)` 重设一次，漏这一步就是「撑开边栏后拖一下边，边栏那 240px 当场被挤没」。读不到 `wm size` ⇒ `ratio=0` = **不锁**（0 是上游给的「取消比例」那档），不自己编一个比例。⚠️ 上游文档那两条都在真窗上验过：程序化 `setSize` **不受**比例约束（所以边栏撑宽走得动），macOS 真全屏也不受影响（1600x1000 进得去，退出仍是锁住那对数）。代价：**手机转到横屏时窗口不会跟着换形状**，画面在锁住的比例里 letterbox（这一档本来也不发 `resizeDisplay`，只是以前能手动拖成横的）。
  - **窗口形状必须在建之前就对**：`mirrorWindowBounds(screenSize, workArea)` 照**设备画面比例**等比 fit 进「可用区减 80 边距」，`screenSize` / `screenDpi` 由主进程读 `wm size` / `wm density` 的 **Physical** 行（`getPhysicalScreenSize` / `getPhysicalScreenDensity`，只读不改）。横窗会开出一块横显示、竖屏 app 立刻换版式，所以**不是**「先开 850x600、等第一帧再收一次」（那一版当天就被替掉了：会跳一次可见的错误形状）。
  - **镜像窗口本体透明：黑框常驻 + 手机右边外面那条悬浮长条 hover 才出现**（2026-10-10 三轮：先做「hover 往外扩那一圈」→ 当天删掉换成压在画面右边缘的长条 → 再当天挪到**手机外面**，「任何 UI 都不要在手机里出现」）：收起时看见的是**那块圆角屏幕 + 贴它外沿的一圈黑色边框**（「就是个手机样子」），右边那 86px 什么都不画；鼠标**进到窗口右边那一格**长条才**原地淡入**（只有 opacity：进来 180ms ease-out、出去 260ms ease-in —— 用户 10-10：「不要从右侧往左展示，直接过渡展示出来就行」⇒ 没有位移/缩放；「消失的时候感觉不太协调」⇒ 出去慢一档），红绿灯跟着出现，**离开那一格 1 秒后才收回**（`RAIL_HIDE_DELAY_MS`；前面两版都作废了 —— 「停手 1.5s 自动淡出」是在栏里不动也收，「只有移出窗口才收」是回到画面上还杵着）。
    - ⚠️ **镜像页共用 `src/styles/index.css`，那里 `#app { background-color: var(--color-canvas) }`（浅色模式 `rgb(245 245 247/82%)`）会把整扇透明窗口铺成一块浅色板** —— 用户 10-10 报的「有一层一直在展示的框框」「鼠标没进窗口也展开」真因就是它，不是边框层、也不是 hover 触发区。已在 `src/mirror/App.vue` 的样式里 `:global(body #app) { background-color: transparent }` 抹掉（只写在镜像页组件里，主窗口不受影响）。⚠️ **选择器必须带 `body`**：`src/mirror/main.js` 先 import 组件、后 import 全局样式，同特异度时**后注入的那条赢**，写 `#app` 会被压回去（10-10 第一版就栽在顺序上）。**以后镜像窗口"该透明却有一层颜色"，先查 `#app` 与全局样式，再看自己的层。**
    - **窗口 = 画面 + 那圈黑框 + 右边那条，内缩是「不对称」的**（`options.js` 的 `MIRROR_FRAME.bezel = 4` 与 `MIRROR_RAIL.width = 86`，`mirrorScreenInsets()` 是唯一换算处：左/上/下 4，**右 4 + 86**）：主进程 `mirrorWindowBounds` 按它定窗口、`initialCss` 按它扣出画面矩形；渲染层把它转成 CSS 变量。**长条那一格永远占着布局，显隐只动它自己那层面板** ⇒ 画面那块矩形不随 hover 动（它一改，14+ 的跟随窗口会话每次 hover 都会发一条 `resizeDisplay`，手机上就跟着重排一次）。长条挪到画面外之前它是浮在画面上的 overlay、不占宽度 —— 用户 10-10 那句「任何 UI 都不要在手机里出现」换成了现在这样（这条不对称由 `tests/electron/mirrorOptions.test.js` 钉住）。
    - **全屏那一屏是另一种排法**（2026-10-10 用户拿 AndroMeld 的截图点单「抄过来」，同一晚再追三条：「三颗别隐藏 / 右侧一直显示 / 背景别黑要亮」）：主进程把 `enter-full-screen` / `leave-full-screen` 推成 `mirror:fullscreen`（初值不用等事件 —— 页面自己读 `pendingInit.prefs.fullscreen`），`.is-fullscreen` 那一组规则做四件事：① 长条那格**不再从窗口右边挖走宽度**（与画面同格叠放、贴右上角、按内容高 ⇒ 画面才真居中，满屏里那 86px 会让它偏左半条）；② 黑框**按视频自己的比例收成手机那一块**（`aspect-ratio: var(--screen-ratio)`，比例由 `syncCanvasBox` 喂 —— ⚠️ **不能取 `meta.width/height`**：那是建会话那一刻的快照，实测那时上游 `AdbScrcpyVideoStream` 的尺寸还是 0，比例永远算不出来、黑框收不拢）。⚠️ **这一档黑框不能用 `border`**（10-11 用户「全屏画面有点黑边」）：`aspect-ratio` 管的是**含边框那个盒**（全局 `box-sizing: border-box`），边框吃掉的 4px 让里面那块内容盒比视频窄一圈 —— 实测 1600x1000 那屏内容盒 `442x968`=0.4566 而视频 `1080x2340`=0.4615，contain 之后上下各露 ~5px 黑。改成往外画的 `box-shadow: 0 0 0 var(--bezel)`（不吃布局，圆角沿元素 `--radius` 外扩 ⇒ 外沿自动 `radius + bezel`），盒本身正好等于视频比例（复测内框 450x976=0.4611，残差不到 1px）。**窗口态照旧用 `border`** —— 那边的内容盒由主进程按 `mirrorScreenInsets()` 定死、正好等于画面矩形，没有这个问题（同一屏窗口态实测中心行/列除那圈 4px 黑框外没有第二段黑）；③ 铺一块**亮底 `#d1e4e4`**（竞品那张图四周那圈浅薄荷，多点采样同一个值）—— ⚠️ 全屏那一屏背后**不是桌面**，透明窗口在那儿就是一块黑；④ 长条**常驻**（`opacity:1` + `pointer-events:auto`，特异度盖过 `.is-shown` ⇒ 不用动 `chromeReveal` 的状态机）；拖窗条与**红绿灯那一截一起撤**（那三颗在全屏里归系统收放，那一截就是一块空白 —— 用户 10-11「全屏右侧悬浮红绿灯区域要去掉」），顶边留白改由面板 `padding-top: 10px` 给。1920x1080 实测：画面矩形 `x=716 w=487`（中线 959.5 ≈ 屏幕正中）、上下各留 12px、面板 `74x263` 贴右上角。**窗口态一行没动**。
    - ⚠️ **全屏里那三颗红绿灯：随系统，我们不动它**。macOS 真全屏（独立 Space）把红绿灯连标题栏一起收进「鼠标移到顶边才浮出」，10-11 逐条实测四条救法都不出 —— 进全屏时 `setWindowButtonVisibility(true)`、动画落定后再调一次、`setWindowButtonPosition(null)` 交回默认、建窗口时压根不藏，截图顶部像素扫描 `#ff5f57/#febc2e/#28c840` 命中数**全 0**。中途试过 **`fullscreenable:false` + `maximize()`**（zoom 撑满，三颗确实常驻，实测 1600x1000 的屏 zoom 成 1600x894，代价是菜单栏与 Dock 仍占一条）—— 用户 10-11 一句话回退：**「我要的是全屏，不是放大按钮」**；他也明确拒绝我们自绘三颗。⇒ 现在保真全屏，红绿灯一个字节不碰，浮出来正好落在右上角那一格里（与窗口态同一个位置）。
    - 状态机 `src/mirror/chromeReveal.js`（`poke()` / `leave()` + **一个延后收起的定时器**）：`poke()` 幂等（挂在 pointermove 上每帧都调，重复报会白发一遍开关红绿灯的 IPC）并且**会撤掉到期计时**；`leave()` 由**那一格的 `pointerleave` + `isOutsideRect(坐标 vs 格子矩形)` 双重判定**驱动，过了几何关才延 `RAIL_HIDE_DELAY_MS`（1000ms）收，重复 leave 不叠加计时。⚠️ **别退回"收到 leave 就收"**：长条显形时会盖到触发带上面，命中层一变浏览器就补发一次 leave，那样变成「鼠标在那一条里移动 = 展示/隐藏来回抖」（10-10 报的循环，判据在 `tests/mirror/chromeReveal.test.js`）。触发 = **`.mirror-rail` 那一格自己的 `pointermove`**：面板收起时格子是命中层，显形时面板的 move 冒泡上来还是格子接住 ⇒ 两种状态同一条判据，**不用按坐标筛**（长条在画面外面，也吃不掉手机上的点按；这是它挪出画面之后顺手省掉的一层 hack）。红绿灯走 `mirror:windowButtons`（`ipcMain.on`，不等结果）。⚠️ 红绿灯**没有淡出可跟**（系统画的），面板淡出期间它们会先「啪」地没了 ⇒ 藏它们要延 `MIRROR_RAIL.fadeOutMs`（260ms）等淡出跑完，期间若又显形就不补这一刀（用户 10-10「消失的时候感觉不太协调」真因之一）。⚠️ **`setWindowButtonVisibility(true)` 会把落点打回 AppKit 默认的左上角**，构造参数那次 `trafficLightPosition` 就这么丢了（10-10 探针窗口实测：藏一次再放出来三颗就回左边，用户报的「彩虹按钮并没有靠右」是它）⇒ 放出来之后**必须紧跟一次 `setWindowButtonPosition`**（判据在 `tests/electron/mirrorSession.test.js`，钉的是两类调用的**顺序**）。
    - **长条从上到下：红绿灯那一截（`.mirror-rail__lights`，`keysTop` 以下才是我们画的）→ 「关屏使用」→ dev 的 `tools` → 最底部三个导航键**（⚠️ 关屏那格的图标与高亮画的是**现在的状态**，不是「点下去会发生什么」：亮着屏 = `lucide:monitor`、灭着 = `lucide:monitor-off` + `is-active`。状态取 `screenIsOff = screenOff || asleep`，其中 `asleep` 是轮询设备 `mWakefulness` 的真读数，设备一报醒就把「是我们关的」那个标记清掉 ⇒ 用户自己按电源键亮屏，图标也跟着翻回来。上一版反过来标，被指出「明明是亮着屏幕，息屏图标却展示息屏」。「已休眠」横幅因此改由 `sleepBanner = asleep && !screenOff` 控制：关屏使用期间不弹，恢复亮屏归长条那颗）（返回 / Home / 多任务，`.mirror-rail__keys` 靠 `margin-top: auto` 贴底，10-10 从顶部挪下来的；走**已有**的 `kind:'key'` → Tango `injectKeyCode`，不起 adb 进程）。按键说明用 **reka-ui 的 Tooltip**（与主窗口 `PageHeader.vue` 同一套：`TooltipProvider :delay-duration="0"` + `TooltipRoot` + `TooltipTrigger as-child` + `TooltipPortal/Content side="left" :side-offset="10"`），**一移上就出、在按键左侧展开**（气泡会短暂压在手机画面上，这是他要的效果，不是常驻 UI）。样式（`TIP_CLASS`）照用户 10-10 给的参照图改成**白底胶囊**：`rounded-full border border-black/10 bg-white px-3.5 py-2 text-[12px] font-medium text-black/75` + 软阴影，`whitespace-nowrap` ⇒ **文案必须短到一行**（长说明留在文档里，别塞进气泡）。实测：150×36、离按键左 12px、垂直居中、一行不换行。⚠️ 参照图里气泡带图标，但 `@iconify/vue` 的 `Icon` 放进 reka 的 `TooltipContent` 渲染不出来（`svgCount: 0`，连占位节点都没有）⇒ 气泡走纯文字。⚠️ 挂了 reka tooltip 之后按钮上**不要再留 `title`**，否则系统气泡和这个气泡会同时弹。⚠️ 也做过一版「每个键下面一行占位小字 `:hover` 显影」，他说「没刚刚好看，要 tooltips 那种」⇒ 已撤，别再加回来。`TooltipProvider` / `TooltipRoot` 都是纯上下文组件、不产生 DOM 元素，所以长条那套 flex 排布不受影响（实测面板子元素仍是 `[lights, key, dev, keys]`）。**以后加的功能键排在顶部那一组以下**（竞品对应 `mirror.nav.{back,home,recents}`、`mirror.menu.add_control`「添加按键」）。宽度改 `MIRROR_RAIL.width`，红绿灯落点 `mirrorTrafficLightPosition()` 跟着算对（判据在 `tests/electron/mirrorOptions.test.js`：长条宽 ≥ 三颗那 58px + 两侧内缩）。
    - **格子 86（占布局）≠ 面板 74（画出来的那块）**：面板 `width: calc(格子 − 2×6px)`（**从格子推导**，以后只改 `MIRROR_RAIL.width` 一个数）、**与手机同高**（顶到窗口顶与底，10-10「浮动条跟手机一个高度」）、`justify-self: end`、只留左右各 6px，圆角 26、底色 `#fbfbfb`（用户 10-10 点定），按键是浅底深字（`rgb(0 0 0 / 5%)` 底 + `/62%` 图标，深底那套配色在浅条上看不见）。面板居中在格子里 ⇒ 与红绿灯那 58 同一根中线（实测两者中心都是 479）。**红绿灯那一截**：`lightTop = 18`、`keysTop = 50`（10-10 一路调过 14 → 18 → 30 → 37 → 28/70，10-11 又回到 18/50 —— 这两个数是他在真窗上对着调的手感值，不是算出来的不变量）、`.mirror-rail__lights` 占到窗口顶往下 `keysTop` 并带一条 `rgb(0 0 0 / 7%)` 下沿分隔线 ⇒ 读起来是「标题栏 + 按键区」两段，不是三颗圆点挤在按键堆边上（用户 10-10 点的 B）。
    - **黑色边框常驻**，画在 `.mirror-frame` 的 `border` 上（全局 `box-sizing: border-box` ⇒ 内容盒正好 = 往里缩 `bezel` 的那块画面矩形；圆角 `--radius 40 + bezel 4 = 44`，与屏幕同心；10-10 用户「四个角再圆润点、边框窄一点」⇒ 半径 30→40、黑框 6→4）。它**不跟 hover 显隐**（用户 10-10：「黑色那一圈边框要永远显示」）。**长条上没有 `-webkit-app-region: drag`**（挂上会让命中层/事件在 hover 时来回翻 = 那个展示/隐藏循环，而且长条自己就是 hover 才出来的），拖窗口只靠常驻的 `.mirror-dragstrip`（顶部 24px、不画颜色，它是 `.mirror-frame` 那格里的第二层 ⇒ **只压在画面顶部 24px**，管不到右边的长条格子，所以长条上的按键不再需要 `no-drag`）。⚠️ 代价照旧：手机画面最顶那一条点不到（先落窗口拖动）—— 用户 10-10 说「任何 UI 都不要在手机里出现」时选的是「只搬条，其余不动」，这一条因此留着。
    - **布局不写 `position`，也不写 `z-index`**（2026-10-10 整理）：画面区与 dev 边栏用 flex 左右排，每一栏内部要叠的层放进 grid 的**同一格**（`grid-area: 1 / 1`），谁在上面就是模板里的先后顺序。⚠️ 格子用 `minmax(0, 1fr)` 且孩子带 `min-width/min-height: 0`：canvas 上是主进程算下来的死像素，留着 `min-content` 下限窗口缩小就顶住了、`ResizeObserver` 也不触发。
  - 开会话的 CSS 优先取主进程传来的 `pendingInit.initialCss`（**画面那块矩形** = 窗口内容区减掉那圈常驻黑框，见 `mirrorScreenInsets`），读不到才回落 DOM —— 深链冷启动时页面还没排版完，读 DOM 会拿到 Electron 默认的 512x512。
  - **全屏启动怎么落地**：`fullscreen` 是 scrcpy **客户端**窗口的选项，上游 server 的 `Options.java` 里没有这个键 —— 我们的对应物就是 `BrowserWindow`。`createMirrorWindow` **不传构造参数 `fullscreen`**，改为 `ready-to-show` → `show()` 之后按开关 `setFullScreen(true)`：macOS 上「构造参数 `fullscreen:true` + `show:false`」经常进不去，而显式传 `fullscreen:false` 会把窗口标成不可全屏。`fullscreenable: true` 保持开着（用户 10-11：「我要的是全屏，不是放大按钮」—— 中途为救红绿灯试过 `fullscreenable:false` + `maximize()` 的 zoom 撑满，已回退，缘由见上面那条）。默认值仍是**关**（2026-10-07 试改默认开，当天被收回）。
- **镜像页不碰设备缓存**：接回横幅要的那个图标随启动参数走（`startMirrorSession` 的 `request.iconUrl` → `sanitizeIcon` → `pendingInit.iconUrl`），不是去 `adb:getCachedApps` 读全量再 find —— 为一格图标花一整轮 IO，且 `.adr` 冷启动时缓存根本还没建。
- **多设备**：**单设备优先** —— 同一时刻只有一台活动设备，而且**它不会自己变**：
  - 切换必须显式：首页右上角「切换设备」下拉（`PageHeader.vue`，展开期间才轮询 `adb devices`，收起用令牌停轮询）列出其他已连接设备，点选走 `App.vue` 的 `switchDevice` → `releasePrevious` → IPC `adb:releaseDevice(serial, { keepMirror: true })`：teardown 上一台的存储/连接池并清 stats、codec 缓存，**不碰 transport、也不关它已经开着的镜像**（`session.js` 的清理钩子见 `keepMirror` 就原样返回），所以上一台留在 `adb devices` 里随时可切回、投着的那路继续投；完全断开仍走「断开连接」的 `adb:disconnect`（不带 `keepMirror`，会话照旧关）。切换后首页各面板按 `:key="device.address"` 重挂重新拉数据。
  - 冷启动/自动重连都不替用户挑**不认识**的设备：`getConnectedDevice()` 按 `stableId` 分组，**两台以上不同手机在线就返回 `null`**（同一台的有线/无线仍优先无线那条）；发现循环走 `pickAdoptableDevice(devices, lastStableId)` —— 只有一台可连接才静默接管，多台时只接管记过的那台；`startRecovery()` 只在 `sameDevice(existing, target)` 时接管，否则回到 `reconnectApi(target.address)`。
  - **上次设备（2026-10-07）**：`adoptDevice` 把接管那台的 **stableId** 写进 `scrcpy-config.json` 的 `lastDeviceStableId`，上面那条「多台时只接管记过的那台」就是读它，**只有这一个读取处**（不加设置页开关，行为常开）。**存 stableId 而不是 serial**：无线 serial `adb-<序列号>-<随机>._adb-tls-connect._tcp` 里那段随机串每次开无线调试都换（实测同一台 Redmi 依次是 `:41759 / :46611 / :34875`），存 serial 下次必然对不上。
  - **免扫码重连是 adb 上游的能力，不自建手机上报通道**：配对过一次以后，无线调试的端口广播由 adb server 自己 browse 并自动建 transport（`adb devices` 里那条 `adb-…._adb-tls-connect._tcp` 就是它建的，实测 platform-tools 37.0.0），桌面侧只需要在它出现后接管。AirSync 那种「手机侧常驻 App 上报 IP+adbPorts」的链路**评估后不做**：它要 helper-app 变成有网络权限、要保活的常驻服务，还要 Mac 侧反向发布 mDNS —— 换回来的只是上游已经做了的那件事。
  - 插上新设备时首页只做一件事：心跳那轮（`healthLoop` 每 5s 已经刷过列表）用 `watchNewConnectedDevices(devices, seenDevices, device.value)` 报出**这一轮比上一轮新出现的**可连接设备，弹一条常驻（`duration: 0`）的「新设备 · 发现 X，可以连接」，动作「连接」走 `switchDevice`；`seen` 是 stableId 集合、由函数自己维护（见过的记下、从列表消失的摘掉，拔掉再插回来算新出现）。**「新」只能是按轮次差集**：`adoptDevice` 先 `markDevicesKnown([...discoveredDevices, target], seenDevices)` 播种，否则从扫码页选中一台进首页的那一秒，会把列表里原本就在的另一台当新设备提醒。
  - 历史上那个承诺 `conflict` 状态的 `shared/deviceSession.js` 已删除。

## 5. 构建与验证

`pnpm build` 是 **beta** 构建，正式版叫 `pnpm build:prod`（名字与语义相反，`package.json:10-11`）。本地质量门已经齐：`typecheck` + `lint`(oxlint+eslint) + `test`(vitest) + `format:check` + `verify-resources`，**但没有 CI**。

```sh
pnpm typecheck && pnpm lint && pnpm test          # 改完必跑
pnpm dev                                          # 连接设备 → 应用右键「启动镜像」
pnpm mirror:spike <serial> h265 /tmp/m.m265 15    # 无界面协议验证
pnpm build-helper && pnpm verify-resources
```

镜像窗口 HUD **仅 dev 显示**（`src/mirror/App.vue` `showHud`），放在**画面右侧的独立边栏**（宽 `HUD_WIDTH`，不遮挡镜像内容：画面上的覆盖层只盖 `mirror-main` 那一块）。10-10 用户点单「点击调试信息也浮动到右侧，风格跟操作栏一样」⇒ 它现在是**与长条同一套外观的浅色浮栏**（`#fbfbfb` / 圆角 26 / 四周留 6px / 深色字），并且展开时通过 `mirror:windowHud` 让主进程**把窗口撑宽同样的量** ⇒ 画面那块矩形不会被挤小（挤小就会发 `resizeDisplay`、手机上重排一次）。主进程按上一次的值算增量，所以页面重载后重复报同一个值不会二次撑宽；全屏时不动窗口尺寸，字段名用中文：「解码队列」长期 >0 且「解码器重置」增长 = 解码跟不上；「WebGL 不可用 … bitmap」= WebGL 被判软件渲染；「尺寸变化」启动后应为 0（否则是重复 resize）。虚拟显示按**画面区**算（`direct-session.js` 的 `contentCss`），不按视口 —— 边栏宽度不计入画面区，否则画面比例与显示比例对不上、`1dp = 1 CSS px` 也会错位（生产里画面区 = 视口，行为不变）。量帧率前必读 `NATIVE_MIRROR.md` §4.0 的取证纪律（并发 `app_process` 会话与静止画面会骗人）。

需要判断"用户实际跑的是哪份产物"：`out/dist/dist-electron` 的 chunk 哈希会变，旧构建残留在 `release/` 里会被 LaunchServices 抢走 `.adr`（§3 快捷方式）。

## 6. 关键文件

```text
electron/
  main.js            建窗、argv/anddrive:// 唤起、runDeviceTeardown、dev 孤儿看门狗
  adb.js             adb 执行+超时+错误归一、发现、helper、应用缓存与图标、应用操作、设备统计、IPC 注册
  storage.js         设备存储：跑 helper 的 StorageMain 取数 + 15s 缓存 + 挂载/卸载编排（mount_webdav 到 ~/Volumes）
  devfs.js           设备文件系统：per-serial adb 长连接 + sync（列/stat/读/写，compression 必须显式关）；取一段按偏移量分原语（start=0 走 sync RECV，中间偏移才 spawn `dd`）；mkdir/rm/mv/cp 走 exec:；stat 与目录清单走 TTL 缓存（写后精确失效）；adapter 交给 webdav
  webdav.js          127.0.0.1 WebDAV（Class 2：可写卷必须会答 LOCK），按随机 token 路由到某个卷的 adapter；macOS 自造的 ._xxx/.DS_Store 在进设备前就回 404
  fileCache.js       文件内容缓存：读过一段后物化整份到 userData/file-cache，键含 size+mtime，2GB/文件、4GB 总量 LRU；fetch 交的是 Buffer（不是流），每块之间过 `beforeChunk` 让路钩子
  readWindow.js      顺序读窗口的存放/命中规则 + `planWindowFetch`（按访问形状决定同步取 256KB/2MB，大窗在背后补）——拆出来是为了给这两条上回归测试
  ipcContract.js     CHANNELS 唯一定义处
  preload.js         electronAPI（隔离时）/ __anddriveIpc（非隔离时）
  scrcpyConfig.js    全局参数持久化（userData/scrcpy-config.json）
  deviceIdentity.js  稳定标识与别名表          favorites.js  收藏（按稳定标识）
  shortcutCore.js    .adr 纯逻辑               shortcut.js  dev launcher bundle 生成与注册
  iconImage.js       Android 方形图标合成到 1024 画布（Mac 观感对齐）
  menu.js            自定义菜单：⌘Q 只关镜像窗口，⌥⌘Q 硬退出
  mdns.js            手写 DNS-SD 报文（UDP 5353）
  mirror/
    options.js       ScrcpyConfig → scrcpy 选项（随包 server 5.0.1，选项集同 4.1）、编码解析（auto 落地）、窗口 bounds（纯函数，双端共用）
    session.js       窗口/记录生命周期、断开清理、异常退出通知（不做帧转发）
    appSession.js    同设备同应用复用判定      control.js  DOM 事件 → Tango writer 入参（只有 touch/scroll/key/text；`kind:'action'` 那套已删）
src/mirror/
  main.js 镜像页入口 · connect.js Tango 唯一接入口 · direct-session.js 会话建立/流泵/退出处理
  session.js App 访问层(bootstrap/sendControl/dispose) · displayFollow.js 跟随去重(有单测)
  App.vue 解码/渲染/HUD/遮罩 · audio.js Opus→WebCodecs→AudioContext · useMirrorInput.js 输入
src/  App.vue 连接状态机与页面调度 · components/home/ 列表与设备面板 · composables/ 收藏/通知/参数/会话/主题
src/styles/index.css 双主题语义色（`:root` 浅 / `.dark` 深）与 `@custom-variant dark`；组件只写 token，换主题只动这一段
src/composables/useTheme.js 明暗开关（`<html class="dark">` + localStorage），设置页的「深色模式」写这里
shared/  scrcpyConfig.js 参数归一化+档位 · keys.js Android 键值别名 · types.js JSDoc 类型
```
