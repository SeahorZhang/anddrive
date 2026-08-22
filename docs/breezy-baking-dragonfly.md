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
| Phase 4 拆分 Electron 服务 | ✅ 已完成 |
| Phase 5 拆分 AppList | ✅ 已完成 |
| Phase 6 macOS-only 构建收敛 | ◐ 第 1 项已完成 |

### 已完成基线（含计划外进展）

- **质量安全网**：`pnpm lint / format:check / typecheck / test` 均为无副作用可重复命令；Vitest 51 例覆盖缓存 sanitize/serialize、ADB devices/设备信息解析、图标帧解析、断开错误识别、单设备选择、scrcpy 校验；Helper 有 `test:helper` / `lint:helper` Gradle 入口与 `HelperProtocolTest`；JSDoc 类型集中在 `shared/types.js`。
- **Phase 2 八项全部完成**：缓存版本独占、真实断开链路（取消加载 → 释放 forward → 停止 scrcpy → `adb disconnect`）、单设备 UI 清理、ConfirmDialog/AddDeviceDialog 异步资源治理、app_process 旧方案删除、生成物停止追踪。
- **功能精简（计划外）**：电量与存储信息已整体删除——`dumpsys battery`、`df -h`、对应 UI/图标/类型字段全部移除，`getDeviceInfo` 只返回 serial/model/deviceName。
- **构建收敛（计划外）**：`build:win:x64`、`build:linux:x64`、`build:mac:x64` 脚本、electron-builder 对应段、main/adb/scrcpy/after-pack/download-adb 中的平台分支及 `resources/adb/{win,linux}` 二进制全部移除；README 已声明支持范围。
- **Renderer API 收口（计划外）**：删除 `useAdb` composable 及其兜底 stub，新增 `src/services/desktopApi.js` 作为唯一桥接，业务组件统一 import 该模块。
- **Electron 服务拆分（Phase 4）**：`electron/adb.js` 单体已按职责拆分为 `adb/`、`helper/`、`cache/`、`scrcpy/` 四组模块；新增 `electron/paths.js` 统一资源 resolver，消除 ADB/scrcpy 双份硬编码路径；scrcpy 进程按 serial 关联，支持定向停止。
- **AppList 拆分（Phase 5）**：数据加载与启动流分别收敛到 `useInstalledApps` / `useAppLauncher`；MRU 重排合并为纯函数 `appOrdering.js` 并有单元测试；`AppList.vue` 从 316 行降到 125 行，只保留搜索与组合。

### 当前剩余问题

- `scripts/build-helper.sh` 仍优先 Homebrew 固定 Gradle 路径而非 `helper-app/gradlew`；`vite.config.js` 读取配置时即删除 `dist-electron`。

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

## Phase 4 — 拆分 Electron ADB/Helper/scrcpy 服务 ✅

**实际落地结构**：

```text
electron/
  paths.js                      # 统一资源 resolver（adb/scrcpy/helper-apk）
  adb/
    adbClient.js                # execFile 封装、ensureServer、pair、devices、disconnect、getDeviceInfo
    deviceParser.js             # devices / device info 纯解析
    errors.js                   # 断开与 forward 错误分类（原 adbDisconnect.js）
    discoveryService.js         # Bonjour mDNS 幂等生命周期
  helper/
    helperProtocol.js           # 端口/版本/batch 常量、helperUrl、parseIconBatch
    helperClient.js             # HTTP 超时/重试、JSON/buffer 请求
    helperLifecycle.js          # 安装、启动、ping、一次性升级、forward 所有权与锁
    appLoader.js                # 应用列表编排；send 回调注入，不持有 ipc sender
  cache/appCache.js             # 原 electron/appCache.js 迁入（schema 同迁）
  scrcpy/scrcpyService.js       # 进程按 serial 关联，stopScrcpy(serial?) 定向停止
```

**要点**：

- `main.js` 收敛为纯组装层：handler map 只做服务调用与 sender 桥接。
- `appLoader` 通过注入的 `send(payload)` 回调输出进度事件；`uniqueApps` / `reconcileCachedApps` 作为纯函数导出可单测。
- forward 队列锁与 `activeForward` 所有权集中在 `helperLifecycle`，加载与断开共用同一把锁，行为与拆分前一致。

**验收结果**：配对、Helper 安装、列表/缓存/图标批量及 legacy fallback、取消加载、断开、scrcpy 启停行为保持不变（53 例测试通过）；失败与取消路径仍不遗留 forward、进程或临时目录；纯逻辑模块有单元测试，进程边界收敛在 main 组装层。

## Phase 5 — 拆分 AppList 与 Vue 状态逻辑 ✅

**落地内容**：

1. **`useInstalledApps(serial, getRecency)`**：管理缓存读取、loadId、IPC 订阅/取消、authoritative 替换、图标 patch、loading/complete 状态与 serial/unmount 清理；替换列表时通过 `getRecency` 保留最近启动排序。
2. **`useAppLauncher(serial, installedApps, recencyPackages)`**：管理 pending icon launch、launching/error 标记、desktopApi 启动调用与 MRU；图标晚到经 `watch(apps)` 触发延迟启动，加载完成仍缺图标的请求统一失败。
3. **纯函数 `appOrdering.js`**：`orderApps` / `pruneMru` 合并了原 `replaceApps`/`promoteApp` 的重复 Map 重排逻辑（tests/renderer/appOrdering.test.js 覆盖）。
4. **`AppList.vue`** 只保留搜索框、过滤 computed 与两个 composable 的组合（316 → 125 行）；Home 页仅消费 `useDeviceInfo` 展示设备名。

**验收结果**：搜索、缓存先显、权威结果替换、图标晚到后启动、图标失败、launch error、MRU、serial 切换与卸载清理行为保持不变；`AppList.vue` 不拼 scrcpy 参数、不维护 IPC listener 细节。

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
9. ✅ Electron service 拆分；
10. ✅ AppList composables/UI 拆分；
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
