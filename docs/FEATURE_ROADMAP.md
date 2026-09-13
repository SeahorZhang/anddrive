# AndDrive 功能路线图

> 本文档按优先级排列 AndDrive 后续可交付的功能规划，供拆解任务、排期和评审使用。
> 原理与实现细节见 [`PRINCIPLE_DOCUMENT.md`](PRINCIPLE_DOCUMENT.md)。

## 1. 文档说明

- **目的**：明确「先做什么、为什么做、做到什么程度」，让每个功能都有可验收的边界。
- **维护方式**：条目完成后在标题加 `[x]`，并补充实际实现位置；优先级调整需在「变更记录」中留痕。
- **状态标记**：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成。
- **优先级含义**：
  - **P0**：稳定性与体验基建，缺失会导致功能不可用或不可感知。
  - **P1**：核心使用体验，决定日常效率。
  - **P2**：效率与自动化，锦上添花。
  - **P3**：高级能力与平台化，需产品决策或较大投入。

### 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-14 | 初稿，建立 P0–P3 分级 |

---

## 2. 现状盘点

### 2.1 已实现能力

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 无线 ADB 配对（二维码） | `src/components/AddDeviceDialog.vue`、`electron/adb.js:825` | 生成 WIFI ADB 二维码，扫码后配对 |
| mDNS 自动发现与接管 | `electron/adb.js:241` `listConnectDevices`、`getConnectedDevice` | 轮询 `adb mdns services` + `adb devices` |
| 单设备会话 | `src/App.vue` | 只维护一台活动设备，连接后停止发现轮询 |
| 应用列表（两阶段） | `electron/adb.js:740`、`src/components/home/AppList.vue:76` | 先包名/标签，再按 20 个/批补齐图标 |
| 图标缓存 | `electron/adb.js:370` | 90 天快照、7 天图标刷新、原子写入 |
| scrcpy 启动 | `electron/adb.js:871` | 固定虚拟显示、h265、24M、keep-active |
| Helper 自动安装/升级 | `electron/adb.js:642` `ensureLatestHelper` | 版本不一致时 `adb install -r` |
| 应用列表缓存秒开 | `electron/adb.js:866` | `getCachedApps` 先渲染缓存 |
| macOS 权限面板 | `electron/permissions.js`、`src/components/Settings.vue` | 本地网络/辅助功能/完全磁盘访问 |
| Beta 构建与自签名 | `scripts/`、`electron-builder.beta.mjs` | 独立 appId/userData，证书签名 |

### 2.2 已知短板

- **错误不可感知**：`src/components/home/AppList.vue:56`、`:61`、`:93` 等失败只 `console.log`，用户看不到。
- **无重连**：网络切换或设备休眠后连接失效，`src/App.vue` 的发现循环在连接后即停止，需手动重来。
- **无操作进度**：Helper 安装、列表加载、图标批次仅有一个全局 `loading`，无进度与阶段提示。
- **无设置持久化**：scrcpy 参数写死在 `electron/adb.js:871`；上次设备、窗口几何不保存。
- **MRU 仅会话内**：`PRINCIPLE_DOCUMENT.md` 提到的 MRU 排序未跨会话持久化。
- **多设备无 UI**：`shared/deviceSession.js` 早期会话冲突逻辑已移除，当前静默取第一台。
- **工程保障弱**：测试仅覆盖 electron 解析逻辑，无渲染层测试，无 CI 工作流。

---

## 3. 规划原则

1. **单设备优先**：默认只维护一台活动设备；多设备能力必须显式选择，不得静默降级（见 `PRINCIPLE_DOCUMENT.md`）。
2. **容错优先**：缓存、配对、设备信息等非关键路径失败不得中断主流程。
3. **缓存友好**：能命中缓存就先渲染，再后台刷新。
4. **渐进增强**：列表先出名称再补图标；操作先反馈成功再补齐细节。
5. **可观测**：所有用户可见操作都要有成功/失败/进行中三种可感知状态。

---

## 4. 优先级总览

| 优先级 | 主题 | 条目数 | 影响面 | 预估工作量 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| P0 | 稳定性与反馈基建 | 6 | 全局 | 中 | 无 |
| P1 | 核心体验增强 | 5 | 高 | 中 | P0 |
| P2 | 效率与自动化 | 6 | 中 | 大 | P0/P1 |
| P3 | 高级与平台化 | 5 | 高 | 大 | 产品决策 |

---

## 5. P0 — 稳定性与反馈基建

### [x] P0-1 统一错误与通知系统

- **目标**：任何失败都能被用户看见，并给出可执行的下一步。
- **功能点**：
  - 新增全局 toast/通知组件（成功、错误、进行中、可重试）——采用 `vue-sonner` + `<Toaster />`。
  - 新增渲染层错误工具，替代散落的 `console.log`/静默 `catch`。
  - 主进程错误统一以可读 `message` 跨桥（延续 `electron/ipcContract.js` 约定）。
  - Helper 未安装等场景识别 `HELPER_SETUP:` 前缀并给出「安装 Helper」行动按钮。
- **涉及模块**：`src/components/*`、`src/api/index.js`、`electron/adb.js:586`。
- **实现位置**：`src/composables/useNotifications.js`（基于 `vue-sonner` 的 `toast` 封装 `notify`）、`src/App.vue`（挂载 `<Toaster />` + 连接/断开错误可读化）、`src/main.js`（引入 `vue-sonner/style.css`）、`src/utils/errors.js`（`readableError` / `isHelperSetupError`）、`src/components/home/AppList.vue`（列表/图标/Helper/启动集成）、`src/components/Settings.vue`（权限操作反馈）。
- **验收标准**：断开失败、列表加载失败、图标获取失败、Helper 安装失败均出现可读提示；错误场景可一键重试。

### [x] P0-2 连接健康检查与自动重连

- **目标**：网络抖动/设备休眠后自动恢复，减少手动重连。
- **功能点**：
  - 定时 `adb devices` 心跳，检测当前 serial 是否仍为 `device`。
  - 掉线后回到 `loading`/`addDevice` 并可自动尝试 `adb connect` 重连（可开关）。
  - 区分「设备离线」与「transport 断开」，复用 `disconnectTransport` 幂等语义。
- **涉及模块**：`src/App.vue:54`、`electron/adb.js:77`、`electron/adb.js:284`。
- **实现位置**：`electron/adb.js`（`getDeviceState` 状态分类、`resolveReconnectAddress`、`reconnectDevice` + IPC）、`electron/preload.js`、`src/api/index.js`（`getDeviceStateApi` / `reconnectApi`）、`src/composables/useConnectionPreferences.js`（`autoReconnect` 开关）、`src/components/Settings.vue`（开关 UI）、`src/App.vue`（5s 心跳 `healthLoop`、`handleConnectionLost`、`startRecovery` 退避重连、发现循环令牌化）。
- **验收标准**：拔网/息屏后 30s 内页面反映离线；恢复网络后自动恢复首页或提示重连。

### [ ] P0-3 操作进行态与进度反馈

- **目标**：长耗时操作不再「卡住无反馈」。
- **功能点**：
  - Helper 安装/升级：显示阶段（检测版本 → 安装 → 读取列表）。
  - 图标补取：显示 `已完成/总数` 进度。
  - 禁用重复触发，暴露「取消/重试」。
- **涉及模块**：`electron/adb.js:740`、`src/components/home/AppList.vue:98`。
- **验收标准**：首次连接安装 Helper 时用户可见进度；重复点击不会并发安装。

### [ ] P0-4 设置持久化

- **目标**：用户偏好、上次设备、窗口几何跨重启保留。
- **功能点**：
  - 本地 JSON 偏好存储（`app.getPath('userData')` 下，原子写入，参照缓存实现）。
  - 保存：上次设备 serial、scrcpy 默认参数、窗口大小/位置、自动重连开关。
  - 提供「恢复默认」入口。
- **涉及模块**：新增 `electron/settings.js`、`electron/main.js:32`、`src/components/Settings.vue`。
- **验收标准**：重启后自动填充上次设备与 scrcpy 参数。

### [ ] P0-5 应用列表刷新与失败重试

- **目标**：列表可手动刷新，失败可自动重试。
- **功能点**：
  - 增加刷新按钮/快捷键，保留缓存兜底。
  - 图标批次失败指数退避重试（当前为 `AppList.vue:109` 仅记录）。
  - 区分「无应用」与「读取失败」空态。
- **涉及模块**：`src/components/home/AppList.vue`、`electron/adb.js:779`。
- **验收标准**：单批图标失败后能自动重试且不阻塞其余批次。

### [ ] P0-6 测试与 CI

- **目标**：关键路径有回归保护，改动可自动验证。
- **功能点**：
  - 为渲染层 composable/工具补充单测（Vitest 已配置）。
  - 主进程新增 `settings`、重连逻辑、通知映射测试。
  - 新增 GitHub Actions：`lint`、`format:check`、`typecheck`、`test`、`verify-resources`。
- **涉及模块**：`tests/`、`.github/`、`package.json:18`。
- **验收标准**：PR 触发 CI 且全绿；新增逻辑覆盖率达标（建议 ≥70%）。

---

## 6. P1 — 核心体验增强

### [~] P1-1 搜索、排序与收藏

- **目标**：应用多时也能快速定位。
- **功能点**：
  - 搜索支持包名、拼音首字母（引入轻量拼音库或预生成索引）。
  - 排序：最近使用（MRU）、名称、安装时间。
  - [x] 收藏/置顶，单独分组显示。
- **涉及模块**：`src/components/home/AppList.vue:35`、`src/composables`（新增）、`electron/adb.js`。
- **实现位置（收藏）**：`electron/favorites.js`（按 serial 持久化到 `userData/favorites.json` + IPC）、`electron/ipcContract.js`、`electron/preload.js`、`src/api/index.js`（`getFavoritesApi` / `toggleFavoriteApi`）、`src/composables/useFavorites.js`、`src/components/home/AppList.vue`（收藏/置顶分组、悬停星标、乐观更新）。
- **待办**：拼音首字母搜索、名称/安装时间排序、MRU 排序（依赖 P1-4）。
- **验收标准**：输入拼音首字母可命中；收藏跨重启保留。

### [ ] P1-2 应用操作菜单

- **目标**：从「只能启动」扩展到常用应用管理。
- **功能点**：
  - 右键/长按菜单：启动、强制停止、清除数据、卸载、应用信息、复制包名、导出 APK。
  - 危险操作二次确认（复用 `ConfirmDialog.vue`）。
  - 卸载/导出走 `adb shell pm`、`adb pull`，结果进通知系统。
- **涉及模块**：`src/components/home/AppList.vue`、`electron/adb.js`（新增 IPC）。
- **验收标准**：每个操作有结果反馈；导出 APK 落到用户选择目录。

### [ ] P1-3 scrcpy 参数配置与多窗口管理

- **目标**：镜像质量可调，多窗口可控。
- **功能点**：
  - 全局与单次启动参数：分辨率、码率、fps、编码、音频转发、息屏、置顶、全屏。
  - 运行中会话列表：聚焦、关闭、关闭全部。
  - 会话生命周期绑定设备（`stopScrcpy(serial)` 已具备基础能力）。
- **涉及模块**：`electron/adb.js:346` `startScrcpy`、`:871` IPC handler、新增会话状态 UI。
- **验收标准**：修改参数后下次启动生效；能看到并关闭指定镜像窗口。

### [ ] P1-4 MRU 跨会话持久化

- **目标**：常用应用始终靠前。
- **功能点**：
  - 记录每个设备最近启动的应用（含时间），按设备 serial 隔离。
  - 上限与淘汰策略，损坏时安全降级为空。
- **涉及模块**：新增 `electron/mru.js`、`electron/adb.js`、`src/components/home/AppList.vue`。
- **验收标准**：重启后最近使用的应用仍在首位。

### [ ] P1-5 设备信息面板

- **目标**：连接后掌握设备关键状态。
- **功能点**：
  - 展示型号、品牌、Android 版本、存储占用、电量、Wi‑Fi/IP、CPU/内存。
  - 数据来自 `adb shell getprop`、`df`、`dumpsys battery` 等，带缓存与刷新。
- **涉及模块**：`src/components/home/index.vue`、`electron/adb.js`（新增 `adb:getDeviceStats`）。
- **验收标准**：首页可展开查看，刷新不阻塞应用列表。

---

## 7. P2 — 效率与自动化

### [ ] P2-1 APK 拖拽与批量安装

- **目标**：本地 APK 一键装到设备。
- **功能点**：拖拽 `.apk` 到窗口安装；多选/队列顺序安装；展示每个包的结果。
- **涉及模块**：`electron/main.js`（窗口拖放）、`electron/adb.js:612` `installHelper` 抽象为通用安装。
- **验收标准**：拖入的 APK 安装成功并出现在列表；失败给出原因。

### [ ] P2-2 文件传输

- **目标**：Mac 与设备间互传文件。
- **功能点**：`adb push`/`pull`、拖拽到设备、选择落盘目录、进度显示。
- **涉及模块**：`electron/adb.js`（新增 IPC）、新增传输面板 UI。
- **验收标准**：进度可见、失败可重试、路径可配置。

### [ ] P2-3 截图与录屏

- **目标**：快速留存设备画面。
- **功能点**：一键截图到 Mac；`scrcpy --record` 或 `adb screenrecord` 录屏；文件命名含时间戳。
- **涉及模块**：`electron/adb.js`、`src/components/PageHeader.vue`（工具栏按钮）。
- **验收标准**：点击后在指定目录生成文件并提示路径。

### [ ] P2-4 快捷键与命令面板

- **目标**：键盘高效操作。
- **功能点**：⌘K 命令面板（搜索应用、执行操作）、⌘R 刷新、⌘, 设置、Esc 关闭。
- **涉及模块**：新增 `src/composables/useShortcuts.js`、`src/App.vue`。
- **验收标准**：命令面板可检索并执行至少「启动应用/断开/设置」。

### [ ] P2-5 分组、标签与隐藏

- **目标**：个性化组织应用。
- **功能点**：自定义分组/标签、隐藏应用、自定义显示名；本地持久化。
- **涉及模块**：新增 `electron/preferences` 扩展、`src/components/home/AppList.vue`。
- **验收标准**：分组与隐藏跨重启保留，可恢复默认。

### [ ] P2-6 logcat 查看器与快速 shell

- **目标**：调试能力内建。
- **功能点**：`adb logcat` 流式查看、级别/关键字过滤、暂停/清空/导出。
- **涉及模块**：`electron/adb.js`（进程流）、新增面板 UI。
- **验收标准**：可实时查看并过滤日志，关闭面板后进程清理干净。

---

## 8. P3 — 高级与平台化

### [ ] P3-1 多设备支持（待决策）

- **目标**：多台已配对设备间切换或并行镜像。
- **决策点**：与「单设备优先」原则冲突。建议方案：默认仍单设备，用户显式进入「多设备模式」。
- **功能点**：设备列表/切换器、每设备独立缓存与应用列表、冲突确认（恢复 `deviceSession` 语义）。
- **涉及模块**：`src/App.vue`、`electron/adb.js`、缓存按 serial 已隔离可复用。
- **验收标准**：多台在线时不再静默取第一台，必须用户选择。

### [ ] P3-2 记忆设备与启动自动重连

- **目标**：打开即回到上次设备。
- **功能点**：启动时读取上次 serial → mDNS 解析地址 → `adb connect` → 自动进首页；失败回退添加设备页。
- **涉及模块**：`src/App.vue:33`、`electron/adb.js:284`。
- **验收标准**：同一网络下冷启动可自动回到首页。

### [ ] P3-3 自动更新与更新提示

- **目标**：版本分发与升级体验。
- **难点**：自签名 + 非公证，`electron-updater` 需适配。
- **功能点**：检查新版本、下载、提示手动安装（或落地 dmg）；Beta/Stable 通道区分。
- **涉及模块**：`electron/main.js`、`scripts/`、`electron-builder*.json`。
- **验收标准**：启动时能检测到新版本并给出下载入口。

### [ ] P3-4 深色模式与国际化

- **目标**：外观与语言适配。
- **功能点**：跟随系统深色模式；文案抽离为 i18n 资源（中/英）。
- **涉及模块**：`src/styles/index.css`、全部组件文案。
- **验收标准**：切换系统外观即时生效；无硬编码中文残留。

### [ ] P3-5 新手引导与帮助

- **目标**：降低首次使用门槛。
- **功能点**：首次启动分步引导（开无线调试 → 扫码 → 浏览/启动应用）；内置常见问题（配对失败、权限）。
- **涉及模块**：`src/App.vue`、`src/components/AddDevice.vue`。
- **验收标准**：新用户按引导可独立完成首次连接。

---

## 9. 非目标与待决策

### 非目标（当前明确不做）

- **Windows/Linux 支持**：仓库已移除相关构建配置，README 声明仅 macOS（Apple Silicon）。
- **账号体系与云同步**：本地工具定位，不引入服务端依赖。
- **遥测/崩溃上报**：默认关闭；若引入必须 opt-in 且可离线。
- **删除设备端配对记录**：断开仅移除 transport，配对记录保留（见 README）。

### 待决策

| 议题 | 说明 | 建议 |
| --- | --- | --- |
| 多设备模式 | 与单设备优先原则冲突 | 显式入口，默认关闭 |
| 自动更新方案 | 自签名/非公证限制 | 先做「更新提示 + 手动安装」 |
| 拼音搜索依赖 | 增加包体积 | 预生成索引，避免运行时大依赖 |
| 是否支持录屏音频 | scrcpy 版本能力 | 先做无音频录屏 |

---

## 10. 里程碑建议

| 里程碑 | 内容 | 依赖 | 风险 |
| --- | --- | --- | --- |
| **M1** | P0 全部（反馈、重连、进度、持久化、刷新、CI） | 无 | 重连策略需避免与单设备接管逻辑打架 |
| **M2** | P1 全部（搜索/收藏、操作菜单、scrcpy 配置、MRU、设备信息） | M1 | scrcpy 多窗口会话状态管理复杂度 |
| **M3** | P2 全部（APK/文件传输、截图录屏、命令面板、分组、logcat） | M1/M2 | 文件传输进度与错误处理 |
| **M4** | P3 全部（多设备、自动重连、更新、深色/i18n、引导） | 产品决策 | 多设备与自动更新不确定性最高 |

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| OEM ROM 差异（`pm`/`app_process` 输出） | 列表/操作失败 | 保持解析容错，保留原始 stderr 诊断信息 |
| 自签名证书分发限制 | 更新/权限不稳定 | 更新走手动安装，文档化信任步骤 |
| scrcpy 进程泄漏 | 资源占用 | 会话状态集中管理，退出/断开统一 `stopScrcpy` |
| 多设备并发写缓存 | 数据竞争 | 缓存已按 serial 隔离并原子写入，复用现有实现 |
| 依赖增大导致启动变慢 | 体验下降 | 优先复用现有依赖，按需懒加载 |

---

## 12. 参考

- [`PRINCIPLE_DOCUMENT.md`](PRINCIPLE_DOCUMENT.md) — 架构与核心模块原理
- [`../README.md`](../README.md) — 使用、构建与签名说明
- [`../helper-app/README.md`](../helper-app/README.md) — Helper 协议与输出契约
