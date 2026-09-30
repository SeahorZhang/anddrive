# AndDrive 架构与约定

> **这份文档是什么**：读代码前该知道的地图 —— 进程怎么分、数据怎么流、每条链路的真入口在哪、哪些设计是**刻意**的（别顺手"优化"掉）。
> 所有 `file:line` 于 2026-09-28 逐条核对过当前代码。**不一致时以代码为准**，并请顺手改这份文档。
> 待办与缺陷见 [`TODO.md`](TODO.md)；镜像引擎的取证记录与实测数据见 [`NATIVE_MIRROR.md`](NATIVE_MIRROR.md)；Helper 的输出契约见 [`../helper-app/README.md`](../helper-app/README.md)。

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
| 投屏启动 | `electron/mirror/session.js:100+` → `mirrorInitGet` → `src/mirror/session.js` → `direct-session.js` | 同设备同应用只开一个窗口（`findAppSession` 命中就 focus 并返回 `reused: true`）；会话起来后 `startApp` + `ensureAppHere` 搬任务 |
| 画质档位 | `shared/scrcpyConfig.js` `DISPLAY_QUALITY_TIERS` + `DISPLAY_QUALITY_BIT_RATES` | compat 1.5 / native 2 / sharp 3（默认 sharp）。虚拟显示尺寸 = 窗口 CSS × 倍率、dpi = 160 × 倍率，于是 **1dp = 1 CSS px**。**码率上限按档位走**（8M / 16M / 32M），设置页里两者是**同一个下拉**——实测每档稳态码率差 5 倍，拆开只会配错；存盘仍是 `quality` + `bitRate` 两个字段，老配置对不上预设时下拉列一项标灰的「自定义」，不改用户的值（唯一例外：改版前的出厂组合 `sharp + 24M` 由 `normalizeScrcpyConfig` 升级到 `sharp + 32M`）。倍率与码率都**只在开会话时生效**（`resizeDisplay` 不带 dpi；4.1 控制消息里也没有改码率的） |
| 桌面快捷方式 | `electron/shortcutCore.js`（纯逻辑）+ `electron/shortcut.js` | `.adr` = 正式 UTI `com.anddrive.mirror-shortcut` + `LSHandlerRank: Owner`（只声明后缀会被历史构建副本抢走）；文件里存稳定设备标识，打开时反查地址，参数取主进程最新全局配置。历史注册清理：`pnpm run shortcut:fix` |
| Helper | `helper-app/…/ListMain.java`，以 `app_process`（shell uid 2000）一次性执行 | **零权限、零后台组件、不监听端口**，stdout 一行 JSON 即退出。`QrPairActivity` 提供"跳到无线调试二维码页"，Mac 侧至今没调用过 |
| 设备统计 | `electron/adb.js` `getDeviceStats` | getprop/df/battery/meminfo/loadavg/ip 并行采集，30s 缓存 + force 刷新；`df /data` 失败退到 `df /` |

## 4. 刻意设计（别当冗余清理）

- **adb 超时阶梯**（`electron/adb.js` 顶部的 `ADB_CONNECT_TIMEOUT_MS` / `ADB_TRANSFER_TIMEOUT_MS` 等常量）：默认 15s / connect-pair 45s / 安装卸载拉文件 5min。transport 半死时子进程既不退出也不报错，全靠这层兜住并把超时归为 `offline`。
- **ROM 怪癖嗅探**：卸载「报 Failure 却退出 1」、装 Helper 与 `clearAppData` 靠 stdout 里 `/Success/i` 判定、`exportApk` 靠 `N files pulled` 正则、helper 输出取最外层 `{`…`}` 以躲 linker/ART 噪声（都在 `adb.js`：`uninstallHelper` / `installHelper` / `clearAppData` / `exportApk` 与 `normalizeListOutput`）。这些丑但**是真需要的**。
- **投屏时手机静音**：服务端 `ROUTE_FLAG_LOOP_BACK`（不传 `audio_dup`）是刻意的 —— 只回环、不在本机渲染。副作用也已知：会话结束、AudioPolicy 撤销后手机当场出声，这不是 bug。要两边同时出声才需要 `audioDup`。
- **`displayFollow` 用 debounce 不用 throttle**：`RESIZE_SETTLE_MS = 250`（`src/mirror/displayFollow.js:13-23`）。真机量过：throttle 每 150ms 发一步，服务端 300ms 去抖**并没有**合掉中间值，每一步都真的重排虚拟显示 → 画面"转好几次"。相同尺寸直接丢弃，因为重复 `resizeDisplay` 会让服务端白走一次 `virtualDisplay.resize()` → capture reset。
- **`debug.anddrive.vd.isr` prop**：随包 server 是自编 scrcpy 4.1（`VirtualDisplayConfig.setIgnoreActivitySizeRestrictions`），该 prop 默认 `"1"`、留作 A/B 逃生口，系统缺 @hide API 时自动退回公开 `createVirtualDisplay`。既定接口，不要改成启动参数。
- **`.catch` 吞掉的分寸**：设备侧探测类失败（读第三个 prop、卸载已卸载的 helper）允许吞；**用户操作的结果不许吞**（收藏写盘失败必须抛，渲染层据此回滚星标）。
- **虚拟显示尺寸只有一个主人**：显示像素只在 `src/mirror/direct-session.js` 的 `displayFor(css)` 一处算（建显示与后续 `resizeDisplay` 同源），`src/mirror/connect.js` 的 `startScrcpy` 只**接收**算好的 `display`；建显示用的 CSS 优先取主进程传来的 `pendingInit.initialCss`（窗口内容区），读不到才回落 DOM —— 深链冷启动时页面还没排版完，读 DOM 会拿到 Electron 默认的 512x512。相应地 `buildMirrorOptions` 的 `newDisplay` 是**必填**（缺了就抛），拼串走 `formatNewDisplay`：**别再加兜底默认尺寸**，任何写死的 `WxH/dpi` 都与画质档位的 dpi 不符，会静默开出一块错密度的显示。
- **镜像页不碰设备缓存**：接回横幅要的那个图标随启动参数走（`startMirrorSession` 的 `request.iconUrl` → `sanitizeIcon` → `pendingInit.iconUrl`），不是去 `adb:getCachedApps` 读全量再 find —— 为一格图标花一整轮 IO，且 `.adr` 冷启动时缓存根本还没建。
- **多设备**：**单设备优先** —— 同一时刻只有一台活动设备，而且**它不会自己变**：
  - 切换必须显式：首页右上角「切换设备」下拉（`PageHeader.vue`，展开期间才轮询 `adb devices`，收起用令牌停轮询）列出其他已连接设备，点选走 `App.vue` 的 `switchDevice` → `releasePrevious` → IPC `adb:releaseDevice(serial, { keepMirror: true })`：teardown 上一台的存储/连接池并清 stats、codec 缓存，**不碰 transport、也不关它已经开着的镜像**（`session.js` 的清理钩子见 `keepMirror` 就原样返回），所以上一台留在 `adb devices` 里随时可切回、投着的那路继续投；完全断开仍走「断开连接」的 `adb:disconnect`（不带 `keepMirror`，会话照旧关）。切换后首页各面板按 `:key="device.address"` 重挂重新拉数据。
  - 冷启动/自动重连都不替用户挑：`getConnectedDevice()` 按 `stableId` 分组，**两台以上不同手机在线就返回 `null`**（同一台的有线/无线仍优先无线那条）；发现循环走 `pickAdoptableDevice(devices)` —— 只有一台可连接才静默接管；`startRecovery()` 只在 `sameDevice(existing, target)` 时接管，否则回到 `reconnectApi(target.address)`。
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

镜像窗口 HUD **仅 dev 显示**（`src/mirror/App.vue` `showHud`），放在**画面右侧的独立边栏**（宽 `HUD_WIDTH`，不遮挡镜像内容：画面上的覆盖层只盖 `mirror-main` 那一块），字段名用中文：「解码队列」长期 >0 且「解码器重置」增长 = 解码跟不上；「WebGL 不可用 … bitmap」= WebGL 被判软件渲染；「尺寸变化」启动后应为 0（否则是重复 resize）。虚拟显示按**画面区**算（`direct-session.js` 的 `contentCss`），不按视口 —— 边栏宽度不计入画面区，否则画面比例与显示比例对不上、`1dp = 1 CSS px` 也会错位（生产里画面区 = 视口，行为不变）。量帧率前必读 `NATIVE_MIRROR.md` §4.0 的取证纪律（并发 `app_process` 会话与静止画面会骗人）。

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
    options.js       ScrcpyConfig → scrcpy 4.1 选项、编码解析（auto 落地）、窗口 bounds（纯函数，双端共用）
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
