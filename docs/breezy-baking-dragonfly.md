# AndDrive 分阶段重构计划

## Context

AndDrive 当前是 Electron 43 + Vue 3 + Vite 的 Android 无线调试桌面工具，核心链路为：

`Vue renderer → preload IPC → electron/main.js → electron/adb.js → Android HelperService`

本次目标是让代码更清晰、更简单，删除无用代码并重写明显不良实现。产品模型已确定为**单设备优先**：不实现多设备切换，不保留未完成的多设备 UI。平台策略已确定为**本轮暂定 macOS-only**；Windows/Linux 的发布能力不在本轮实现。CI 暂不纳入本轮，留作下一轮独立工作。

已确认的高风险问题：

- `electron/adb.js`（约 471 行）混合 ADB、mDNS、Helper 生命周期、HTTP/二进制协议、图标加载、缓存和 IPC 事件。
- `src/components/home/AppList.vue`（约 309 行）同时维护缓存事件、图标状态、搜索、MRU、延迟启动和 scrcpy 参数。
- 缓存 schema 版本曾在调用方与 `appCache.js` 分散维护；当前已由 `appCacheSchema.js` 独占 `CACHE_VERSION = 2`，写入时统一补入版本，需保留回归验证避免回退。
- Renderer 同时使用 `useAdb()` 和直接访问 `window.electronAPI.startScrcpy()`；`useDeviceInfo.js` 调用 preload 未暴露的 API。
- “断开连接”只清理 Vue 状态，没有执行 `adb disconnect`。
- scrcpy 与 ADB 运行路径硬编码 macOS，但构建配置仍提供 Windows/Linux 入口且未打包 scrcpy。
- `DeviceSelector.vue`、Android app_process 旧方案、根目录 `preload.mjs` 等属于未使用或失效遗留；Phase 2 已清理这些项目，并保留无副作用的 lint、format、test、typecheck 命令。

## Recommended approach

遵循“先安全网、再修复行为、最后拆分职责”的顺序。每一阶段保持可构建、可验证，避免同时改动 IPC、Helper 协议和 Vue 状态机。不要一次性把全项目迁移 TypeScript；对新增和重构模块采用 JSDoc/checkJs 的渐进方案。

## Phase 1 — 建立本地质量安全网

**目标**：在大范围移动代码前，建立无副作用的检查命令和纯逻辑测试。

**关键文件**：`package.json`、`jsconfig.json`、`electron/appCache.js`、`electron/adb.js`、`electron/scrcpy.js`、`helper-app/app/build.gradle`。

**工作内容**：

1. 将 `lint` 改为只检查；新增显式的 `lint:fix`。将 `format` 与 `format:check` 分开，并覆盖实际源码范围，不让验证命令修改工作区。
2. 引入 Vitest，先覆盖不依赖真实设备的纯逻辑：缓存 sanitize/serialize、ADB `devices` 输出解析、设备信息解析、图标批量二进制帧解析、单设备选择规则、scrcpy 请求校验。
3. 为 `DeviceInfo`、`InstalledApp`、缓存快照、Helper capabilities、App load event、scrcpy request 增加 JSDoc 类型；对新模块逐步启用 `checkJs`。
4. Android Helper 增加最低限度的 local unit test/lint 入口，优先覆盖协议编码、参数解析和图标批量帧编码。

**验收**：

- `pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm typecheck` 都是无副作用的可重复命令。
- 测试不依赖 Electron GUI、ADB server 或真实 Android 设备。
- 先为缓存版本不一致问题补回归测试，确保修复前失败、修复后通过。

## Phase 2 — 修复确定性缺陷并删除无效代码

**目标**：先修复已确认的 P0/P1 问题，减少源码树噪声，再开始拆分服务。

**关键文件**：`electron/appCache.js`、`electron/adb.js`、`electron/main.js`、`electron/preload.js`、`src/App.vue`、`src/components/PageHeader.vue`、`src/components/ConfirmDialog.vue`、`src/components/AddDeviceDialog.vue`、`.gitignore`。

**工作内容**：

1. **修复缓存版本**：让 `appCache.js` 独占快照 schema 版本。`writeAppCache()` 接收不带 version 的领域数据，序列化时统一补入当前版本；禁止调用方手写数字。验证真实加载后可读回缓存、过期/损坏数据仍会被安全清理。（已完成）
2. **实现真实断开**：新增 main/preload/renderer 的 disconnect IPC。单设备断开时取消 App 加载、释放 Helper forward、停止关联 scrcpy、执行 `adb disconnect <serial>`，成功后才切回添加设备页；失败时保留当前状态并展示错误。明确这是断开无线 ADB 传输，配对记录仍保留。（已完成）
3. **按单设备模型清理 UI**：删除未引用且依赖缺失的 `src/components/home/DeviceSelector.vue`；删除与 `BaseButton.vue` 重复的 `DrButton.vue`，统一使用原生 button 基础组件。（已完成）
4. **修复失效 composable**：`useDeviceInfo.js` 不再调用未暴露的 `getprop/dumpsys/df`，改为包装唯一的 `getDeviceInfo(serial)`；移除 `AddDevice.vue` 调试文本和 home 页无条件 `console.log`。（已完成）
5. **修复确认框**：`ConfirmDialog.vue` 要么成为真正通用的 props/emits 组件，要么明确改名为断开专用组件；推荐使用 `title/message/confirmLabel`，取消和关闭均有清晰事件语义。（已完成）
6. **清理异步资源**：保存 `AddDeviceDialog.vue` 的成功关闭 timer，在关闭、重新打开和卸载时取消。（已完成）
7. **删除未接入 Android app_process 旧实现**：删除 `LaunchableAppsMain.java`、`MirrorRuntimeWorkarounds.java`、`MirrorShellContext.java` 及其孤立引用；保留当前 `HelperService` 唯一协议来源。（已完成）
8. 停止追踪并忽略 `helper-app/local.properties`、Gradle reports/build outputs、根目录未使用的 `preload.mjs` 等生成物/机器本地文件；同步清理文档中的模板和过时说明。（已完成）

**验收**：缓存命中可观察；断开后 `adb devices` 不再列出当前无线连接；断开失败不会伪装成功；Helper 仍能构建并提供 `/ping`、`/apps`、`/icons-bin`；删除项无引用。

## Phase 3 — 统一 IPC bridge 与单设备会话

**目标**：Renderer 只依赖一个受控桌面 API，所有系统策略集中在 main。

**关键文件**：`electron/main.js`、`electron/preload.js`、`electron/scrcpyRequest.js`、`shared/ipcContract.js`（新增）、`shared/types.js`、`shared/selectDevice.js`、`src/services/desktopApi.js`（新增）、`src/composables/useDevice.js`、`src/App.vue`、`src/components/home/{index,AppList}.vue`。

**工作内容**：

1. 建立唯一 IPC contract：新增 `shared/ipcContract.js` 集中定义全部 channel 常量和参数/返回值/事件 payload 说明；main、preload 与 adb.js 的事件发送侧均改为引用 `IPC.*` 常量，channel 字符串不再散落。（已完成）
2. Renderer 统一走 facade：新增 `src/services/desktopApi.js` 取代原 `src/electronApi.js`，成为渲染进程访问桥接的唯一入口；业务组件对 `window.electronAPI` 的直接访问为零。（已完成）
3. `startScrcpy` 归入统一桌面 API：请求契约改为纯领域数据 `ScrcpyLaunchInput{ serial, packageName, label, iconDataUrl }`（channel 更名 `scrcpy:start`）；CLI args、默认码率与窗口参数由 main 侧 `buildScrcpyArgs()` 构建，renderer 不再拼接 scrcpy 参数。（已完成）
4. 轻量单设备 session 与多设备冲突：`selectDevice()` 改为返回 `none/ok/conflict` 判别结果，多台在线时在添加设备页展示冲突错误并中止连接，禁止静默取数组第一项；active serial、loadId 取消旧加载、forward 锁与断开统一释放沿用既有实现并保持回归测试。（已完成）
5. `App.vue` 管理显式连接生命周期：`connectionState = restoring | idle | connected | disconnecting | error` 状态机取代字符串页面切换；断开编排上收到 App.vue（成功才回 idle 并清空轮询与设备状态，失败回退 connected 且错误展示在确认框），home 页仅转发 props/事件。（已完成）

**验收**：Renderer 源码不再出现 `window.electronAPI` 或 `start_scrcpy`（已验证）；channel 只存在于 contract/main/preload（已验证）；多设备不会被静默选择（selectDevice 冲突用例覆盖）；serial 切换或断开后旧事件不会污染当前状态（loadId 过滤 + 卸载清理）。

## Phase 4 — 拆分 Electron ADB/Helper/scrcpy 服务

**目标**：保留 IPC 行为，按职责拆分 `electron/adb.js`，使核心逻辑可独立测试。

**建议结构**：

```text
electron/
  adb/adbClient.js              # ADB 路径、命令执行、设备/断开/forward
  adb/deviceParser.js           # devices、device info 纯解析
  adb/discoveryService.js       # Bonjour mDNS 生命周期
  helper/helperLifecycle.js     # 安装、启动、ping、升级、forward
  helper/helperClient.js        # HTTP、重试、JSON/buffer 请求
  helper/helperProtocol.js      # 端点、版本、图标帧解析
  helper/appLoader.js           # 应用列表、图标、缓存协调和进度事件
  cache/appCache.js
  scrcpy/scrcpyService.js       # 资源、进程、临时图标目录
```

**迁移顺序**：

1. 先提取 ADB 基础命令封装、设备输出解析、forward/remove-forward。
2. 提取 Bonjour discovery，确保 start/stop 幂等且不依赖 renderer。
3. 提取 Helper 安装/启动/协议升级和单 session forward 生命周期。
4. 提取 HTTP/超时/重试、`/ping`、`/apps`、`/icons-bin`、legacy fallback、`parseIconBatch`。
5. 提取 App loader orchestration，让它通过依赖注入使用 ADB、Helper、cache，不直接调用 ipc sender。
6. 把 `getDeviceInfo` 的命令执行与 `parseDeviceInfo` 纯函数分离，修正重复正则和脆弱的 `df -h` 假设。
7. 重构 scrcpy service：以 serial 关联进程，统一启动/停止和临时目录清理；当前 macOS 资源路径集中在 resource resolver，不再让组件或 ADB 模块知道路径。

Android 侧先不全面重写 `HelperService.java`；在协议稳定后再按 `HelperProtocol`、HTTP server、应用 repository、icon repository、batch codec 逐步提取，并在真实设备上验证 ADB forward 访问仍正常。

**验收**：配对、Helper 安装、首次列表、缓存、图标批量和 legacy fallback、取消加载、断开、scrcpy 启停行为保持不变；失败和取消路径不遗留 forward、进程或临时目录；每个新服务有纯单元测试或明确的集成边界。

**实施结果**（已完成）：

1. `electron/adb.js` 单体（约 493 行）已删除，拆分为目标结构中的 9 个模块；另新增 `electron/resourceResolver.js`（迁移步骤 7 的资源路径唯一来源，adb/helper/scrcpy 均经它取路径）、`electron/adb/adbDisconnect.js`（原根目录错误分类模块归入 adb 分组）、`electron/scrcpy/scrcpyRequest.js`（校验 + args 构建纯函数随 scrcpy 服务分组）。`cache/appCacheSchema.js` 同步迁入 cache 分组。
2. `adbClient.js`：ensureServer/exec/shell/pair（保留 protocol-fault 自动重试）/listDevices/disconnect（已离线幂等成功）。
3. `discoveryService.js`：start/stop 幂等（stop 先于 start），自持生命周期不依赖 renderer。
4. `helperLifecycle.js`：安装/启动/ping/waitForHelper/协议升级去重 + 单 session forward 状态与串行锁（acquireForwardLock/releaseSession/releaseForSerial）；`getDeviceInfo` 走 helper /device-info 会话。
5. `appLoader.js`：`createAppLoader(helper)` 工厂注入会话能力；进度经 `emit(AppLoadEvent)` 回调上报，ipc sender 只在 main.js 组合边界触碰一次；缓存→authoritative→icons 渐进/batch+legacy fallback→complete 编排与取消语义保持不变。纯函数 `uniqueApps/reconcileCachedApps/rendererApps` 导出并新增单测。
6. `scrcpyService.js`：以 serial 关联进程（同 serial 重启先停旧进程），`stopForSerial(serial)`/`stopAll()` 统一停止并清理临时图标目录；启动入口直接接收领域数据并在内部构建 CLI args。
7. 断开链路由 main.js `disconnectDevice()` 组合：normalize → 停镜像 → 取消加载 → 持锁释放 forward → adb disconnect，保持原有加锁语义。
8. 测试调整：`parseIconBatch` 用例移至 `helperProtocol.test.js`；devices/device info 解析用例在 `deviceParser.test.js`；新增 `appLoader.test.js` 覆盖去重、label 回退与缓存 reconcile 刷新规则（缺失/过期/改名触发刷新）。8 个测试文件 57 个用例全绿；vite build 冒烟通过（16 modules 内联）。真机 smoke（配对/列表/断开）待 macOS 实机复核。

## Phase 5 — 拆分 AppList 与 Vue 状态逻辑

**目标**：让组件只负责组合 composable 和渲染，保留现有缓存优先、图标渐进加载、搜索和 MRU 行为。

**关键文件**：`src/components/home/AppList.vue`、`src/components/home/index.vue`、`src/composables/useAdb.js`、`src/composables/useDeviceInfo.js`；新增 `useInstalledApps.js`、`useAppLauncher.js` 和必要的展示组件。

**工作内容**：

1. `useInstalledApps(serial)` 管理缓存读取、loadId、IPC 订阅/取消、authoritative 列表、图标 patch、loading/complete/error 和 serial/unmount 清理。
2. `useAppLauncher(serial)` 管理 pending icon launch、launching/error 状态、scrcpy facade 调用和 MRU 顺序。
3. `AppList.vue` 只保留搜索和组合；必要时提取 `AppSearch`、`AppGrid`、`AppTile`，不要为简单 markup 过度拆分。
4. Home 页面只消费统一 `useDeviceInfo` 并展示唯一设备信息，移除重复解析和调试日志。
5. 将当前 `replaceApps`/`promoteApp` 的重复 Map 重排逻辑合并为一个小型纯函数并测试。

**验收**：搜索、缓存先显、权威结果替换、图标晚到后启动、图标失败、launch error、MRU、serial 切换和卸载行为均有测试或可重复手工验证；`AppList.vue` 不直接访问 window、不拼 scrcpy CLI、不维护 IPC listener 细节。

**实施结果**（已完成）：

1. `src/composables/useInstalledApps.js`：管理缓存优先读取、loadId 订阅/取消、authoritative/icons/complete 阶段数据、loading/iconLoadComplete 状态与 serial 切换/卸载清理；通过 `bind(handlers)` 暴露 `onAuthoritative/onIcons/onComplete/onReset` 组合点，不感知启动逻辑。
2. `src/composables/useAppLauncher(serial, installed)`：管理 pendingIconLaunches、launchingPackages、launchErrors、MRU 与 `displayApps` 派生排序；`requestLaunch` 保持原语义（有图标立即启动 / 无图标且加载中挂起 / 加载完成后判失败）；scrcpy 仅提交领域数据。
3. `shared/appOrdering.js`：原 `replaceApps`/`promoteApp` 两份重复的 Map 重排合并为纯函数 `orderAppsByMru`（去重、MRU 优先、修剪失效项并返回可持久化 MRU）与 `promoteToMruFront`，新增 `tests/shared/appOrdering.test.js` 覆盖（含不可变性）。测试现为 9 文件 64 用例。
4. `AppList.vue` 从 306 行减至约 114 行：只保留搜索过滤与组合渲染，无 window 访问、无 CLI 拼接、无 IPC listener 细节；未提取 AppSearch/AppGrid/AppTile（markup 简单，避免过度拆分）。
5. Home 页面在 Phase 3 已收敛为只消费 App.vue 统一 `useDevice()` 输出的 device prop，无重复解析与调试日志，本轮无需改动。
6. 行为保持逐行对应：缓存先显 → 权威替换（MRU 剪枝持久化）→ 图标 patch 触发挂起启动 → complete 结算剩余 pending 为失败；serial 切换/卸载经 onReset 同步清理两侧状态。lint/format/typecheck/test 全绿，vite build 冒烟通过。真机 smoke（图标渐进点击启动、MRU 置顶、搜索）待 macOS 实机复核。

## Phase 6 — 收敛 macOS-only 构建与资源流程

**目标**：让产品声明、运行时路径、打包资源和构建命令一致，并提升干净环境可复现性。

**关键文件**：`package.json`、`electron-builder.json`、`electron/scrcpy.js` 或其新 service、`scripts/build-helper.sh`、`scripts/after-pack.js`、`vite.config.js`、`README.md`。

**工作内容**：

1. 按 macOS-only 策略删除或明确禁用 Windows/Linux build scripts、targets 和 UI 启动入口，文档写清当前支持范围；不在本轮准备 Windows/Linux scrcpy 二进制。
2. 统一 macOS ADB/scrcpy/helper 资源 resolver，避免 ADB 路径在 `adb.js` 与 `scrcpy.js` 各自硬编码。
3. `scripts/build-helper.sh` 始终优先使用 `helper-app/gradlew`，不要依赖固定 Homebrew Gradle 路径；增加清晰的 Android SDK 检查和 `test/lint/assemble` 分层命令。
4. 增加显式 `verify-resources`/release 前置检查。`build` 明确串联必要的 Helper 构建或资源校验；`after-pack.js` 保留为最终包校验。
5. 移除 `vite.config.js` 顶层删除 `dist-electron` 的副作用，改用显式清理步骤或构建工具生命周期。
6. 重写 README：项目用途、macOS 前置条件、无线调试流程、单设备规则、检查/测试/Helper/打包命令和资源来源。

**验收**：macOS 在干净工作区按 README 可完成准备、构建和打包；缺少资源时快速且明确失败；Vite 配置被读取不会删除既有产物；macOS 包中的 ADB、scrcpy、server、Helper APK 均通过 after-pack 检查。

## Deferred — 下一轮 CI

本轮不增加 CI。下一轮复用本地命令增加 Node lint/format/typecheck/test 与 Android Gradle test/lint 的最小 workflow；不把签名、notarization、真实设备和跨平台发布纳入首版 CI。

## Dependencies and commit boundaries

```text
Phase 1 → Phase 2 → Phase 3 → Phase 4
                       └──────→ Phase 5
Phase 0 platform decision → Phase 6
Phase 1 + Phase 4/5/6 → future CI
```

推荐按可独立回滚的提交拆分：

1. check-only lint/format、Vitest、JSDoc 基础；
2. cache version 修复及测试；
3. disconnect IPC 与 UI 生命周期；
4. 删除废弃 Vue/Android/生成物；
5. IPC contract 与 desktop facade；
6. Electron service 拆分；
7. AppList composables/UI 拆分；
8. macOS-only 资源和构建文档。

## Final verification

每个阶段完成后执行相关快速检查，最终至少执行：

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build-helper
pnpm build
```

无法自动化的设备 smoke 流程需在 macOS 真机上复核：无线配对、恢复已连接设备、单设备加载应用、缓存命中、图标渐进显示、点击启动 scrcpy、断开后 ADB 连接消失、再次配对。