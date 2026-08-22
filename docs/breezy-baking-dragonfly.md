# AndDrive 重构计划（2026-08-23 复盘更新）

## Context

AndDrive 当前是 Electron 43 + Vue 3 + Vite 的 Android 无线调试桌面工具，核心链路为：

`Vue renderer → desktopApi → preload IPC → electron/main.js → electron/adb.js → Android HelperService`

本次目标是让代码更清晰、更简单，删除无用代码并重写明显不良实现。产品模型已确定为**单设备优先**：不实现多设备切换，不保留未完成的多设备 UI。平台策略已收敛为 **macOS（Apple Silicon）only**：Windows/Linux 构建能力已删除；scrcpy 资源仅有 arm64 二进制，x64 包不可用。CI 暂不纳入本轮。

**阶段状态总览**：

| 阶段 | 状态 |
| --- | --- |
| Phase 1 质量安全网 | ✅ 已完成 |
| Phase 2 缺陷修复与清理 | ✅ 已完成 |
| Phase 3 IPC bridge 与单设备会话 | ✅ 已完成 |
| Phase 4 拆分 Electron 服务 | ○ 未开始 |
| Phase 5 拆分 AppList | ○ 未开始 |
| Phase 6 macOS-only 构建收敛 | ◐ 第 1 项已完成 |

### 已完成基线（含计划外进展）

- **质量安全网**：`pnpm lint / format:check / typecheck / test` 均为无副作用可重复命令；Vitest 51 例覆盖缓存 sanitize/serialize、ADB devices/设备信息解析、图标帧解析、断开错误识别、单设备选择、scrcpy 校验；Helper 有 `test:helper` / `lint:helper` Gradle 入口与 `HelperProtocolTest`；JSDoc 类型集中在 `shared/types.js`。
- **Phase 2 八项全部完成**：缓存版本独占、真实断开链路（取消加载 → 释放 forward → 停止 scrcpy → `adb disconnect`）、单设备 UI 清理、ConfirmDialog/AddDeviceDialog 异步资源治理、app_process 旧方案删除、生成物停止追踪。
- **功能精简（计划外）**：电量与存储信息已整体删除——`dumpsys battery`、`df -h`、对应 UI/图标/类型字段全部移除，`getDeviceInfo` 只返回 serial/model/deviceName。
- **构建收敛（计划外）**：`build:win:x64`、`build:linux:x64`、`build:mac:x64` 脚本、electron-builder 对应段、main/adb/scrcpy/after-pack/download-adb 中的平台分支及 `resources/adb/{win,linux}` 二进制全部移除；README 已声明支持范围。
- **Renderer API 收口（计划外）**：删除 `useAdb` composable 及其兜底 stub，新增 `src/services/desktopApi.js` 作为唯一桥接，业务组件统一 import 该模块。

### 当前剩余问题

- `electron/adb.js`（约 500 行）仍混合 ADB 执行、mDNS 发现、Helper 安装/升级、HTTP 客户端、图标批量协议与缓存协调。
- `src/components/home/AppList.vue`（约 316 行）同时维护缓存事件、图标状态、搜索、MRU 与启动状态管理。
- scrcpy 进程与 App load 仍未按 serial 建立归属注册表（Phase 4 范围）。
- ADB/scrcpy 资源路径在 `electron/adb.js` 与 `electron/scrcpy.js` 各自硬编码；`scripts/build-helper.sh` 仍优先 Homebrew 固定 Gradle 路径而非 `helper-app/gradlew`；`vite.config.js` 读取配置时即删除 `dist-electron`。

## Recommended approach

保持"先安全网、再修复行为、最后拆分职责"的顺序。每一阶段保持可构建、可验证，避免同时改动 IPC、Helper 协议和 Vue 状态机。不一次性迁移全项目 TypeScript；新模块用 JSDoc/checkJs 渐进补充。

## Phase 3 — 统一 IPC bridge 与单设备会话 ✅

**关键文件**：`electron/ipcContract.js`、`electron/main.js`、`electron/preload.js`、`shared/deviceSession.js`、`electron/scrcpyRequest.js`、`src/services/desktopApi.js`、`src/App.vue`。

**落地内容**：

1. **唯一 IPC contract**：新增 `electron/ipcContract.js` 集中定义全部 channel（invoke + 推送事件）；preload 与 main handler map 均引用常量，channel 字符串不再散落。
2. **scrcpy 参数下沉**：Renderer 只提交 `{ serial, packageName, label, iconDataUrl }`；`buildScrcpyRequest` 在 main 校验领域数据并构造 CLI args（分辨率/codec/码率/窗口策略留在主进程），原 `validateScrcpyRequest` 退役。
3. **单设备 session**：`resolveSession(devices)` 纯函数输出 `empty/connected/conflict` 三态，替代静默取首项的 `selectDevice`（已删除）；main 经 `adb:getActiveSession` 暴露，多设备冲突返回 serials 列表由 UI 展示。无消费方的 `adb:getDevices` 桥接通道一并移除。scrcpy 进程与 App load 的按 serial 归属注册表归入 Phase 4。
4. **App.vue 显式状态机**：`idle/restoring/connected/disconnecting/error` 替代字符串页面切换。断开失败保持当前设备页并在确认框内展示错误、允许重试；恢复失败与多设备冲突在添加设备页显示横幅。`PageHome` 以 serial 为 key 强制重挂载，杜绝旧事件污染。

**验收结果**：channel 字符串仅存在于 contract/main/preload；Renderer 源码无 scrcpy CLI 参数；多设备冲突可见且不静默选择；serial 切换或断开后旧状态不会污染当前视图。

## Phase 4 — 拆分 Electron ADB/Helper/scrcpy 服务

**目标**：保留 IPC 行为，按职责拆分 `electron/adb.js`，使核心逻辑可独立测试。

**建议结构**：

```text
electron/
  adb/adbClient.js              # ADB 路径、命令执行、设备/断开/forward
  adb/deviceParser.js           # devices、device info 纯解析（parsers.js 已有基础）
  adb/discoveryService.js       # Bonjour mDNS 生命周期
  helper/helperLifecycle.js     # 安装、启动、ping、升级、forward
  helper/helperClient.js        # HTTP、重试、JSON/buffer 请求
  helper/helperProtocol.js      # 端点、版本、图标帧解析
  helper/appLoader.js           # 应用列表、图标、缓存协调和进度事件
  cache/appCache.js
  scrcpy/scrcpyService.js       # 资源、进程、临时图标目录
```

**迁移顺序**：

1. 先提取 ADB 基础命令封装、forward/remove-forward 与 devices 解析。
2. 提取 Bonjour discovery，确保 start/stop 幂等且不依赖 renderer。
3. 提取 Helper 安装/启动/协议升级和 forward 生命周期。
4. 提取 HTTP/超时/重试、`/ping`、`/apps`、`/icons-bin`、legacy fallback、`parseIconBatch`。
5. 提取 App loader orchestration：依赖注入使用 ADB/Helper/cache，不直接持有 ipc sender。
6. 重构 scrcpy service：以 serial 关联进程，统一启动/停止和临时目录清理；资源 resolver 统一后不再各自硬编码。

> 原第 6 条（getDeviceInfo 命令执行与解析分离、修正 `df -h` 假设）已随电量/存储功能删除而失效，予以移除。

Android 侧先不全面重写 `HelperService.java`；在协议稳定后再按 `HelperProtocol`、HTTP server、应用 repository、icon repository、batch codec 逐步提取，并在真实设备上验证 ADB forward 访问仍正常。

**验收**：配对、Helper 安装、首次列表、缓存、图标批量和 legacy fallback、取消加载、断开、scrcpy 启停行为保持不变；失败和取消路径不遗留 forward、进程或临时目录；每个新服务有纯单元测试或明确的集成边界。

## Phase 5 — 拆分 AppList 与 Vue 状态逻辑

**目标**：让组件只负责组合 composable 和渲染，保留现有缓存优先、图标渐进加载、搜索和 MRU 行为。

**关键文件**：`src/components/home/AppList.vue`、`src/components/home/index.vue`、`src/services/desktopApi.js`、`src/composables/useDeviceInfo.js`；新增 `useInstalledApps.js`、`useAppLauncher.js` 和必要的展示组件。

**工作内容**：

1. `useInstalledApps(serial)` 管理缓存读取、loadId、IPC 订阅/取消、authoritative 列表、图标 patch、loading/complete/error 和 serial/unmount 清理。
2. `useAppLauncher(serial)` 管理 pending icon launch、launching/error 状态、desktopApi 调用和 MRU 顺序。
3. `AppList.vue` 只保留搜索和组合；必要时提取 `AppSearch`、`AppGrid`、`AppTile`，不要为简单 markup 过度拆分。
4. Home 页面只消费统一 `useDeviceInfo` 并展示唯一设备信息（当前仅设备名）。
5. 将当前 `replaceApps`/`promoteApp` 的重复 Map 重排逻辑合并为一个小型纯函数并测试。

**验收**：搜索、缓存先显、权威结果替换、图标晚到后启动、图标失败、launch error、MRU、serial 切换和卸载行为均有测试或可重复手工验证；`AppList.vue` 不拼 scrcpy CLI、不维护 IPC listener 细节。

## Phase 6 — 收敛 macOS-only 构建与资源流程（部分完成）

**已完成**：第 1 条——Win/Linux/mac-x64 构建脚本、targets、平台分支代码与跨平台二进制已删除，README 已声明 Apple Silicon only。

**剩余工作**：

2. 统一资源 resolver：ADB/scrcpy/helper APK 路径集中一处，消除 `adb.js` 与 `scrcpy.js` 的重复硬编码。
3. `build-helper.sh` 改为始终优先 `helper-app/gradlew`，删除 Homebrew 固定路径分支（**现状与原计划矛盾，脚本仍以 `/opt/homebrew/opt/gradle@8` 为首选**）；保留现有 ANDROID_HOME 探测。
4. 增加显式 `verify-resources` 前置检查：`resources/adb/mac/adb`、`resources/scrcpy/{scrcpy,scrcpy-server}`、`helper-app.apk` 缺失时快速失败；`after-pack.js` 保留为最终包校验。
5. 移除 `vite.config.js` 顶层删除 `dist-electron` 的副作用，改用显式清理步骤或构建工具生命周期。
6. README 补全：macOS 前置条件、无线调试流程、单设备规则、检查/测试/Helper/打包命令（详细连接说明已在 `docs/phone-connection.md`，README 引用即可，避免重复维护）。

**验收**：干净工作区按文档可完成准备、构建和打包；缺少资源时快速且明确失败；Vite 配置被读取不会删除既有产物；包内二进制通过 after-pack 检查。

## Deferred — 下一轮 CI

本轮不增加 CI。下一轮复用本地命令增加 Node lint/format/typecheck/test 与 Android Gradle test/lint 的最小 workflow；不把签名、notarization、真实设备和跨平台发布纳入首版 CI。

## Dependencies and commit boundaries

```text
Phase 3 → Phase 4 ─┐
        └──────────┴→ Phase 5
Phase 6 与 3/4/5 无依赖，可随时并行
已完成阶段 + 各阶段产出 → future CI
```

推荐按可独立回滚的提交拆分（✅ 已提交）：

1. ✅ check-only lint/format、Vitest、JSDoc 基础；
2. ✅ cache version 修复及测试；
3. ✅ disconnect IPC 与 UI 生命周期；
4. ✅ 删除废弃 Vue/Android/生成物；
5. ✅ 功能精简：电量/存储删除；
6. ✅ 构建收敛：Win/Linux/mac-x64 移除；
7. ✅ desktopApi facade（useAdb 删除）；
8. ✅ IPC contract 与 scrcpy 参数下沉、单设备 session 与 App 状态机；
9. Electron service 拆分；
10. AppList composables/UI 拆分；
11. 资源 resolver、verify-resources 与 gradlew 收敛。

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
