# AndDrive 重构计划 · 第二轮（构建收敛与边界打磨）

> 前序计划 `docs/breezy-baking-dragonfly.md` 的 Phase 1–5 已完成并提交（`31de145`）。
> 本轮只做剩余收尾：macOS-only 构建收敛、Android Helper 内部拆分（协议稳定后）、边界打磨。

## 0. 现状基线

代码量约 3000 行，模块职责已经清晰：

```text
渲染层    组件(≤130行) → composables → desktopApi.js facade → preload IPC
主进程    main.js(组合根+IPC注册) → adb/ | helper/ | cache/ | scrcpy/ → resourceResolver
共享层    shared/：types + ipcContract + 纯函数(selectDevice/appOrdering)
Android   helper-app/：HelperService 单体（协议 v6）
```

遗留问题（本轮目标）：

| # | 问题 | 位置 |
|---|---|---|
| 1 | Windows/Linux 构建入口仍存在，但无对应资源与测试 | `package.json` scripts、`electron-builder.json:44-83` |
| 2 | `vite.config.js:15` 顶层读配置即删 `dist-electron/`，副作用 | vite.config.js |
| 3 | `build-helper.sh` 优先用 Homebrew gradle@8 而非项目 gradlew | scripts/build-helper.sh:35 |
| 4 | 打包资源缺失只能在 electron-builder 半程才失败，无前置检查 | 无 verify-resources |
| 5 | README 是脚手架模板，无 macOS 准备/构建说明 | README.md |
| 6 | `jsconfig.typecheck.json` 手工枚举文件，新模块易漏 | jsconfig.typecheck.json |
| 7 | Android HelperService.java 单体（HTTP/协议/repo 混杂） | helper-app/ |

## 1. 边界原则（先立规矩，再动手）

**依赖方向单向，逐层可替换：**

```text
组件 ──→ composable ──→ desktopApi facade ──→ preload bridge
main.js(组合根) ──→ 服务模块 ──→ resourceResolver / shared 纯函数
shared/ 不 import Vue、Electron、Node —— 违反即为边界破坏
```

**防过度封装五条硬规则：**

1. **重复第三次才提取**；两处相似但语义不同的代码保持各自写法，不强行统一。
2. **不建 class 包装函数模块**。现有 `adb.*` / `helper.*` 平铺导出即终态；组合靠 main.js 参数传递（如已验证的 `createAppLoader` 工厂），不推广成 DI 框架。
3. **组件不拆展示子组件**，除非超过 ~150 行或持有独立状态；markup 复制粘贴两份以内可接受。
4. **不为测试而导出**。纯函数进 `shared/` 测试；带副作用的薄壳（IPC handler、composable 编排）靠真机冒烟，不 mock Electron。
5. **不迁移 TypeScript**。JSDoc + checkJs 只覆盖 `shared/` 与 electron 纯逻辑；`.vue` 与 composable 编排不强制类型。

## 2. Phase 6 — macOS-only 构建收敛

**目标**：干净工作区按 README 可完成 构建 Helper → 打包 → after-pack 校验 全流程；缺资源快速明确失败。

| 步骤 | 文件 | 内容 | 验证 |
|---|---|---|---|
| 6.1 | package.json | 删 `build:win:x64`、`build:linux:x64`；`build` 显式为 mac 流程并串联资源检查 | grep 无 win/linux 入口 |
| 6.2 | electron-builder.json | 删 `win/linux/nsis` 三段；`mac.target` 明确 `[dmg]` + arch 列表 | `pnpm build` 产物仅 mac |
| 6.3 | electron/main.js | 删 win32 分支（34–36 行）；`window-all-closed` 简化 | lint |
| 6.4 | electron/resourceResolver.js | `ADB_BIN` 表删 win32/linux 键，未知平台直接抛错而非 undefined 路径 | typecheck |
| 6.5 | scripts/build-helper.sh | gradlew 优先且必须可执行；增加 `test/lint/assemble` 分层参数 | `pnpm build-helper test` |
| 6.6 | scripts/verify-resources.js（新增） | 检查 `resources/helper-app.apk`、`resources/adb/mac/adb`、`resources/scrcpy/{scrcpy,scrcpy-server}` 存在且可执行；缺失时打印精确路径退出非零 | 删一个文件跑它 |
| 6.7 | vite.config.js | 移除顶层 `rmSync`，清理移入 `build` 脚本前缀（`node scripts/clean-electron.mjs &&` 或 rimraf 等价物） | 连续两次 build 成功 |
| 6.8 | scripts/after-pack.js | 保留为最终包校验，补查 scrcpy-server 与 APK 已在包内 | 打包一次 |
| 6.9 | README.md | 用途 / macOS 前置（Node、JDK、SDK）/ 无线调试流程 / 单设备规则 / 命令表 / 资源来源 | 照文档空目录走通 |

**验收**：`pnpm verify-resources && pnpm build-helper && pnpm build` 一条链通过；故意删除任一资源时在打包开始前失败并指明缺什么。

## 3. Phase 7 — Android Helper 内部拆分（协议稳定后，可与 6 并行评估）

**目标**：HelperService.java 按"先测后拆"推进，每步 ADB forward 真机回归。**不引入多 Gradle module**，单模块内分包即可。

```text
helper-app/app/src/main/java/.../
  HelperProtocol.kt|java   # 版本号、端点、帧编解码（对齐 electron/helper/helperProtocol.js）
  HttpServer               # NanoHTTPD 路由薄壳，不含业务
  AppRepository            # /apps 数据源
  IconRepository           # /icons-bin 数据源 + batch codec
  DeviceInfoProvider       # /device-info 各 shell 采集
```

| 步骤 | 内容 |
|---|---|
| 7.1 | 先补 local unit test：帧编码、参数解析（`testDebugUnitTest` 已有入口） |
| 7.2 | 提取 batch codec 与协议常量为独立类，renderer/electron 两侧对照同一 fixture |
| 7.3 | 提取 repository 层；HelperService 仅剩路由与生命周期 |
| 7.4 | 每步真机验证：配对 → 列表 → 图标批量 → scrcpy 启动 |

**验收**：`./gradlew testDebugUnitTest lintDebug` 绿；electron 侧 8 个测试文件不改一行仍然全绿（协议字节级兼容）。

## 4. 边界打磨小项（随手清单，不单开阶段）

- `jsconfig.typecheck.json`：include 改为 glob（`shared/*.js`、`electron/**/*.js`），消除手工登记漏项；若暴露存量类型错误就地修复。
- `src/App.vue` 轮询定时器（~15 行）：**保留内联，不提取 usePolling**——单一使用者，提取即违反规则 1。
- `ConfirmDialog.vue` / `PageHeader.vue` / `AddDeviceDialog.vue`（62/72/102 行）：复核一遍 props/emits 语义即可，预期零改动。
- preload `platform` 字段：确认 renderer 是否仍有消费方，无人用则从 contract 删除。

## 5. 不做清单（本轮明确不做）

- TypeScript 全面迁移、monorepo、多 Gradle module
- 多设备支持、Windows/Linux 发布、scrcpy 跨平台二进制
- CI workflow（下一轮独立工作，复用本地命令）
- E2E 自动化（真机 smoke 手工执行）

## 6. 提交切分与最终验证

```text
提交1: 6.1–6.4  macOS-only 声明与运行时一致
提交2: 6.5–6.8  构建脚本与资源校验
提交3: 6.9      README
提交4: Phase 7  Android 拆分（可按 7.x 再细分）
```

每提交前：

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
```

发布前追加：`pnpm build-helper && pnpm verify-resources && pnpm build`

**真机 smoke 清单**（Phase 4/5 未实机复核项一并覆盖）：
无线配对 → 恢复连接 → 单设备加载应用 → 缓存命中 → 图标渐进显示 → 无图标点击挂起→图标到达自动启动 → complete 后点击报错红点 → 启动成功 MRU 置顶 → 搜索过滤 → 断开后 `adb devices` 无残留 → 再次配对。
