# AndDrive 功能发散规划

> 本文档基于当前实现整理，用于规划后续演进方向。仅作规划用途，不代表已承诺排期。
> 现状以代码为准；`docs/PRINCIPLE_DOCUMENT.md` 中部分目录/composable 描述已与实现不一致，见文末「文档债务」。

## 一、现状快照（能力边界）

- **连接**：macOS 应用通过 mDNS 发现 `adb-tls-pairing`，扫码（`WIFI:T:ADB;...`）完成配对，再解析 `adb-tls-connect` 地址 `adb connect`。单设备优先，不提供设备切换器。
- **数据**：Helper APK 仅作代码容器，主进程以 shell（uid 2000）一次性执行 `app_process ... ListMain`，stdout 返回可启动的第三方应用 `{packageName,label}`；图标走 `--icons` 模式，128×128 PNG base64，渲染层按 20 个/批顺序补齐。加载前会比对设备内 Helper 的 `versionCode`，旧版自动 `adb install -r` 升级。
- **缓存**：`electron/adb.js` 按 serial SHA-256 存 JSON 快照，90 天过期、20 设备 LRU、图标 7 天刷新，写入用临时文件 + rename。
- **启动**：`startScrcpy` 固定参数（`--new-display=1920x1080/320`、`--start-app=<pkg>`、h265、`-b 24M`、窗口自动摆位），进程按 serial 记入 Map，但只能整体 kill。
- **退出**：`shutdown()` 停止所有 scrcpy、停止并销毁 mDNS 发现、清理本进程残留临时文件、`adb kill-server`。
- **界面**：macOS 毛玻璃风格首页、应用网格、搜索、扫码弹窗、断开确认。
- **更新**：自建更新器（不依赖 Squirrel/签名）；启动查询 GitHub Releases 并后台下载 `.zip`，下载完成右上角显示「更新重启」，重启后弹窗展示更新内容。
- **明显缺口**：多设备、设备信息、应用详情与操作、镜像生命周期管理、设置页、深色模式、国际化、自动更新、测试覆盖面窄。

## 已完成

- **自动更新（应用内）**（2026-09）：自建更新器（`electron/updater.js`），不依赖 `electron-updater`/Squirrel，**无需 Apple 开发者账号与代码签名**。启动查询 GitHub Releases API 比对版本并后台下载 `.zip`；下载完成右上角显示「更新重启」，点击保存更新内容并退出，辅助脚本替换 `.app` 后重启，重启后弹窗展示更新内容。`electron/main.js` 在更新安装时跳过优雅退出延迟。`electron-builder.json` 保留 GitHub publish 与 `zip` 目标用于发布。本地测试用 `scripts/dev-update-server.mjs`（`pnpm dev:update`）+ `ANDDRIVE_UPDATE_API` / `ANDDRIVE_UPDATE_FORCE`。
- **Helper 版本管理与自动升级**（2026-09）：`electron/adb.js` 新增 `ensureHelper` / `parseDeviceHelperVersion` / `shouldUpgradeHelper` / `bundledHelperVersion`；`scripts/build-helper.sh` 构建时从 `app/build.gradle` 解析版本并写出 `resources/helper-app.version.json`，已纳入 `scripts/verify-resources.mjs` 与 `electron-builder.json` 打包；新增 `tests/electron/helperVersion.test.js`。
- **退出生命周期清理**（2026-09）：`electron/adb.js` 新增 `shutdown()`（停 scrcpy、停 mDNS 发现并销毁 bonjour、清理本进程 `.tmp` 缓存、`adb kill-server`）；`electron/main.js` 的 `before-quit` 改为等待清理完成后再退出，带重入保护。

## 二、发散方向

### 1. 连接与设备管理

1. **多设备支持（回归）**：历史上 `shared/deviceSession.js` 已删除；重新引入设备列表与冲突态，顶部加设备切换器。`scrcpyProcesses` 已按 serial 隔离，改动集中在 `src/App.vue` 状态机与 `home/`。
2. **设备信息面板**：`getprop`（型号/品牌/Android 版本/ABI）、`dumpsys battery`、`df` 存储、`wm size` 分辨率、当前 IP，做成设备头可展开卡片。
3. **心跳与掉线自愈**：轮询 `adb devices`，掉线发原生通知 + 一键重连；网络切换后自动重新 `resolveConnectAddress`。
4. **多设备记忆**：`localStorage` 现仅存一台，改为设备数组 + 别名 + 最近连接时间。
5. **手动连接兜底**：除扫码外支持输入 `IP:端口`；USB 连接 + `adb tcpip` 切换。
6. **局域网设备发现**：轮询 `adb-tls-connect` 列出可连设备，而非只等待扫码。
7. **连接诊断向导**：区分「不同网络 / 配对失效 / 端口占用 / ROM 屏蔽」，给出可操作建议，而非裸 stderr。
8. **断开粒度**：断开单个镜像窗口 / 断开设备 / 退出 App 全清（当前只有后两档）。

### 2. 应用列表与信息

1. **应用详情面板**：包名、版本、安装/更新时间、大小、targetSdk、APK 路径、权限、是否系统应用（`dumpsys package`、`pm path`、`du`）。
2. **排序 / 筛选 / 分组**：按名称、安装时间、大小、启动频率；仅用户应用；首字母分组索引。
3. **拼音搜索**：`pinyin-pro` 支持「wx → 微信」首字母检索。
4. **收藏 / 常用 / 最近启动（MRU）**：置顶常用应用，MRU 排序。
5. **应用操作菜单（右键）**：启动、强制停止（`am force-stop`）、清除数据（`pm clear`）、卸载、复制包名、查看详情、拉取 APK。
6. **APK 备份 / 安装**：`adb pull` 到 Mac；拖拽 APK 安装到设备；多选批量卸载/备份。
7. **导出清单**：导出 JSON / CSV / Markdown，便于分享与盘点。
8. **图标缓存升级**：从「base64 塞 JSON」改为「PNG 落盘 + 引用路径」，减小快照体积、加快读取（当前 `MAX_SNAPSHOT_BYTES` 触发时会整体丢弃图标）。
9. **系统应用开关**：`ListMain` 现直接过滤 `FLAG_SYSTEM`，可加参数按需显示。

### 3. scrcpy 镜像与多开

1. **镜像会话面板**：列出正在镜像的应用窗口并支持单独关闭（需为进程返回 id，暴露 `stopScrcpy(id)`）。
2. **多开**：同一设备同时镜像多个应用（能力已具备，主要补 UI 与生命周期管理）。
3. **每应用参数**：分辨率、码率、编码器（h264/h265/av1）、帧率、音频、置顶，按应用记忆。
4. **录制 / 截图**：`--record` 录屏、`--screenshot` 截图到指定目录。
5. **窗口记忆**：记住上次窗口位置/大小，恢复时沿用。
6. **启动方式扩展**：除 `--start-app` 外支持指定 Activity / deep link / URL。
7. **音频与剪贴板**：Android 11+ 音频转发、剪贴板同步开关。

### 4. Helper 设备端

1. ✅ **版本管理与自动升级**（已完成）：比较设备内 APK 的 `versionCode`，旧版自动 `adb install -r`；版本不可读时不动设备。升级 Helper 需同步提升 `app/build.gradle` 的 `versionCode`。
2. **通用命令入口**：`CommandMain <subcommand>` 复用一次 app_process，扩展设备信息/电池/截屏/音量等，避免每个能力单独冷启动。
3. **冷启动优化（探索）**：评估 ADB 隧道 + 常驻进程复用的收益与安全权衡。
4. **无 Helper 降级**：仅用 `pm list packages` + `cmd package` 提供包名列表（无图标/标签）作为兜底。
5. **兼容性矩阵**：`ActivityThread.systemMain()` 在不同 ROM 的行为差异，补测试与降级路径。

### 5. 性能与可靠性

1. **大列表性能**：应用数 500–2000+ 时用虚拟滚动 / `content-visibility`，避免一次性渲染全部网格。
2. **图标加载流式化**：当前顺序逐批，可恢复受控并发 + 可视区优先。
3. **IPC 大 payload**：图标 base64 跨进程复制成本高，探索传文件路径或 `MessagePort`。
4. **后台 / 增量刷新**：进入首页先渲染缓存，再静默刷新差异。
5. ✅ **生命周期**（已完成）：退出时停 ADB server、清理临时文件、优雅结束所有 scrcpy，并释放 mDNS 发现。
6. **诊断日志面板**：内置日志 + 一键导出诊断包（当前只有 console）。
7. **测试扩充**：`tests/electron/*` 目前覆盖 cache/错误/解析；补 IPC handler、scrcpy 参数拼装、`ListMain` 参数解析、排序/搜索纯函数。
8. **E2E 冒烟**：Playwright + Electron 跑「启动 → 空态 → 打开扫码弹窗」。
9. **CI**：GitHub Actions 跑 `lint / typecheck / test / build`。

### 6. 体验与界面

1. **Toast / 通知系统**：安装、启动、卸载的成功/失败反馈（当前失败只在 console）。
2. **菜单栏（Tray/MenuBar）项**：连接状态、快速断开、常用应用直达。
3. **命令面板 ⌘K + 快捷键**：⌘F 搜索、↑↓ 选择、⏎ 启动。
4. **设置页**：默认 scrcpy 参数、缓存管理、主题、语言。
5. **深色模式**：跟随系统 + vibrancy 深色变体（当前配色写死浅色）。
6. **国际化**：中/英，文案集中管理。
7. **首次启动引导**：网络/调试检查清单 + 扫码教学。
8. **细节**：骨架屏、空态插画、应用详情 Sheet、右键菜单、可访问性（键盘焦点、aria）。

### 7. 分发、安全与生态

1. ✅ **自动更新**（已完成）：自建更新器 + GitHub Releases，不依赖 `electron-updater`/Squirrel，无需签名。启动检查下载，下载完成右上角「更新重启」，点击保存更新内容并重启，重启后弹窗展示。见 `electron/updater.js`、`electron/main.js`、`electron-builder.json`（publish + `zip`）。签名公证（7.2）变为可选增强，不再是自动更新的前提。
2. **签名与公证（可选增强）**：解决首次手动下载安装时的 Gatekeeper 拦截（梳理 `scripts/after-pack.js` 现状）。自建更新器已不依赖签名，故此项非必需；购买 Apple 开发者账号后可用于更严格的校验与更顺滑的首次安装。
3. **分发渠道**：Homebrew Cask；评估 universal 构建（当前仅 arm64）。
4. **安全**：校验下载的 adb/scrcpy 哈希；补全 IPC 入参校验；Helper APK 完整性校验。
5. **隐私**：若引入错误上报（Sentry 等），明确不上报设备/应用数据。
6. **文档债务**：重写 `docs/PRINCIPLE_DOCUMENT.md`，补充缺失的 `docs/phone-connection.md`（README 已引用但文件不存在）。

### 8. 发散 / 长期（想法池）

- 多设备批量巡检、企业批量部署。
- 应用使用统计与设备存储可视化。
- 快捷指令 / CLI：`anddrive launch <pkg>`，与 macOS 快捷指令联动。
- 恢复 Windows/Linux 支持（需 adb/scrcpy 多平台资源）。
- 插件化 scrcpy 参数预设（游戏 / 演示 / 省流）。

## 三、建议路线图

### Phase 1 — 可用性补强（小步快跑）

Toast 通知 · 单个镜像关闭 · 应用右键操作（停止/卸载/复制包名）· 拼音搜索 + 排序筛选 · 设备信息面板 · 文档同步。

### Phase 2 — 体验与规模

镜像会话面板与多开 · 应用详情 + APK 备份/拖拽安装 · 图标缓存落盘 · 大列表虚拟滚动 · 设置页 + 深色模式 · 快捷键 / 菜单栏。

### Phase 3 — 平台化

多设备支持 + 心跳重连 · Helper 通用命令入口（自动升级已完成）· 签名公证 / CI（应用内自动更新已完成）· 国际化 · E2E 与测试补齐。

## 四、验证方式

当前可用的检查命令：

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:helper
pnpm build-helper
pnpm build
```

> 注：`pnpm lint` 的 `lint:eslint` 目前会因仓库依赖（typescript-eslint 不支持 TypeScript 7.0）在加载解析器时失败，与本规划无关，实现阶段需先处理或绕开。

## 五、文档债务

- `docs/PRINCIPLE_DOCUMENT.md` 描述的 `electron/adb/adbClient.js`、`electron/adb/discoveryService.js`、`src/composables/*`、`shared/deviceSession.js` 等已不存在或已合并，需要按现有 `electron/adb.js`、`electron/ipcContract.js`、`src/components/*` 重写。
- `README.md` 引用的 `docs/phone-connection.md` 缺失，应补齐连接步骤。
