# AndDrive

AndDrive 是一个 macOS 桌面工具，通过 Android 无线调试连接单台 Android 设备，浏览已安装应用并使用 scrcpy 启动应用镜像窗口。

> 仅支持 macOS（Apple Silicon）。Windows/Linux 构建配置已移除。

## 工作方式

1. 在 Android 设备开启无线调试。
2. 在 AndDrive 扫描二维码完成 ADB 配对。
3. AndDrive 自动发现并连接设备，安装/启动 Helper App，读取应用列表和图标。
4. 点击应用启动 scrcpy 镜像窗口。
5. 点击“断开连接”会结束当前无线 ADB 传输并停止 scrcpy；Android 中保存的配对记录不会被删除。

AndDrive 遵循**单设备优先**规则：当前只维护一台活动设备，不提供设备切换器或多设备列表。

## 前置条件

- macOS（Apple Silicon）
- Node.js 22.18+（或满足 `package.json` engines 的更新版本）
- pnpm
- Android 11+ 设备，开启无线调试并与 Mac 位于同一网络
- Android SDK（构建 Helper App 时需要；仅打包已有 APK 时不需要）

详细连接步骤见 [`docs/phone-connection.md`](docs/phone-connection.md)，Helper 协议见 [`helper-app/README.md`](helper-app/README.md)。

## 开发

```sh
pnpm install
pnpm dev
```

配对二维码需要设备开启“无线调试 → 使用二维码配对设备”。如果设备已经配对，可直接启动应用并等待自动发现。

## 检查、测试与构建

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:helper
pnpm lint:helper
pnpm build-helper
pnpm build
```

`pnpm lint`、`pnpm format:check` 和测试命令只检查，不应修改工作区。需要自动修复 lint 时使用 `pnpm lint:fix`。

`pnpm build-helper` 使用 `helper-app/gradlew` 构建 APK，并复制到 `resources/helper-app.apk`。

`pnpm build` 会先运行资源校验（`pnpm run verify-resources`），确认 `resources/adb/mac/adb`、`resources/scrcpy/*`、`helper-app.apk` 与 `helper-app.version.json` 存在且非空，缺资源时快速失败。首次准备资源可运行 `pnpm run download-adb`。

## 自动更新与发布

> 完整发布步骤见 [`docs/release.md`](docs/release.md)。

应用使用自建更新器（`electron/updater.js`），不依赖 `electron-updater`/Squirrel，也因此**不需要 Apple 开发者账号或代码签名**：启动后查询 GitHub Releases API，按版本号比对，若发现新版本则后台下载对应的 macOS `.zip`；下载完成在窗口右上角出现「更新重启」，点击后保存更新内容并退出，辅助脚本替换 `.app` 后重启，重启后弹窗展示本次更新内容。

发布新版本（推荐走 GitHub Actions）：

1. 提升 `package.json` 的 `version`（必须递增，更新器按数字逐段比较 `major.minor.patch`），提交后打 tag：`git tag v0.1.1 && git push origin v0.1.1`。
2. `.github/workflows/release.yml` 会在 macOS runner 上构建 `dmg` 与 `zip`，创建对应 Release 并上传产物（更新内容取 GitHub 自动生成的提交说明）；也可在 Actions 里手动触发并输入 tag 重发。
3. 已安装的客户端下次启动即可检测到并自动下载。

> 本地手动发布：`pnpm build` 后在 GitHub 建 Release，`tag` 用 `vX.Y.Z`，上传 `release/<version>/AndDrive-Mac-arm64-X.Y.Z-Installer.zip`，更新说明填进 Release 正文。

> CI：`.github/workflows/ci.yml` 在 push / PR 时运行 `lint:oxlint`、`format:check`、`typecheck`、`test`（`lint:eslint` 因 typescript-eslint 暂不支持 TypeScript 7.0 未纳入）。

> 其他 Actions：
> - `.github/workflows/build-helper.yml`：构建手机端 Helper APK 并上传产物（改动 `helper-app/**` 时自动触发，也可手动运行）。
> - `.github/workflows/package-desktop.yml`：手动触发，跑完整桌面端打包流程（先构建 Helper APK，再跑检查并打包 macOS 产物，最后上传 Artifacts）。

> 说明：更新包通过 Electron 自身下载（不写 `com.apple.quarantine`），因此未签名也能完成替换与启动；但首次从浏览器手动下载安装仍可能被 Gatekeeper 拦截，需右键打开或执行 `xattr -dr com.apple.quarantine /Applications/AndDrive.app`。替换过程日志写入 `~/Library/Logs/AndDrive/update.log`。若日后购买 Apple 开发者账号完成签名与公证，可改为官方更新方案以获得更严格的校验。

## Todo（后续方向）

- **连接**：多设备支持与设备切换器、设备信息面板、掉线自愈、手动 `IP:端口` 兜底连接。
- **应用列表**：排序/筛选/分组、拼音搜索、常用与最近启动、右键操作（停止/卸载/复制包名）、APK 备份与拖拽安装。
- **镜像**：镜像会话面板与单独关闭、多开、每应用 scrcpy 参数记忆、录制/截图。
- **体验**：Toast 反馈、⌘K 命令面板与快捷键、设置页、深色模式、国际化。
- **性能与质量**：大列表虚拟滚动、图标缓存落盘、扩展测试与 E2E 冒烟。
- **分发**：签名与公证（可选）、Homebrew Cask、universal 构建。

## 架构

```text
Vue renderer (src/)
  → window.electronAPI（preload 桥）
  → electron/preload.js
  → electron/main.js（IPC 组装与单设备 teardown）
  → electron/adb/*      ADB 命令、设备解析、mDNS 发现
  → electron/adb/*      ADB 命令、设备解析、mDNS 发现
  → electron/helper/*   Helper 安装、app_process 一次性执行、应用加载
  → electron/cache/     按设备隔离的应用缓存
  → electron/scrcpy/    镜像进程管理
  → Android app_process: com.anddrive.helper.ListMain（shell uid 2000，stdout JSON）
```

缓存位于 Electron userData 目录，并按设备 serial 隔离。应用列表先显示有效缓存，再用设备上的权威列表（标签与图标内联）替换。Helper APK 仅作代码容器：不授予权限、不监听端口；其桌面图标点击后直接跳转 Android 的“无线调试”设置页。

## 连接与断开

断开按钮只移除当前无线 ADB transport，不会撤销 Android 配对记录；若要永久撤销配对，请在设备的无线调试设置中移除已配对电脑。设备已经因网络变化离线时，断开操作按幂等成功处理；其他 ADB 错误会保留当前页面并显示错误。

## 许可与资源

项目随包资源包括 macOS ADB、scrcpy 及 Helper APK。请按各资源自身的许可证和来源要求使用它们。
