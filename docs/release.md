# 发布流程

本文档说明如何发布 AndDrive 桌面端与手机端 Helper，并让已安装的客户端收到自动更新。

## 一、前置条件（一次性）

- 仓库 Settings → Actions → General → Workflow permissions 设为 **Read and write**（`release.yml` 需要创建 Release）。
- 不需要 Apple 开发者账号或代码签名：自建更新器不依赖 Squirrel/签名。
- 本地构建 Helper 需要 Android SDK 与 JDK 17；只发布桌面端不需要。

## 二、职责概览

| 环节 | 由谁完成 |
| --- | --- |
| 改代码、提版本、打 tag | 本地 `git` |
| 静态检查（oxlint/format/typecheck/test） | `ci.yml`（push / PR） |
| 构建手机端 Helper APK | `build-helper.yml` 或本地 `pnpm build-helper` |
| 打包桌面端 | `release.yml`（打 tag）/ `package-desktop.yml`（手动完整流程） |
| 创建 Release、上传 zip/dmg | `release.yml` |
| 客户端发现并安装更新 | 桌面端自建更新器 |

## 三、发布步骤

### 1. 开发并提交

```sh
git add -A
git commit -m "feat: ..."
git push origin main
```

推送 `main` 会触发 `ci.yml`（`lint:oxlint`、`format:check`、`typecheck`、`test`）。

### 2. 修改了手机端 Helper 时才需要

仅当改动 `helper-app/**` 时执行：

1. 提升 `helper-app/app/build.gradle` 的 `versionCode`（例如 `1` → `2`）。
   桌面端会用它判断手机上的 Helper 是否需要升级；不提升则不会触发升级。
2. 重新构建，二选一：
   - 本地：`pnpm build-helper`（需 Android SDK + JDK 17）；
   - CI：运行 `Build Helper APK` workflow，从运行页面的 Artifacts 下载 `anddrive-helper-apk`。
3. 将新的 `resources/helper-app.apk` 与 `resources/helper-app.version.json` 提交到仓库。
   > Actions 的 artifact 不会自动写回仓库，必须手动提交。

未改动 Helper 则跳过本步。

### 3. 提升桌面端版本

编辑 `package.json` 的 `version`，例如 `0.0.0` → `0.1.0`。

- 必须比线上版本大，更新器按 `major.minor.patch` 逐段比较（数字比较，非字符串）。
- 与随后的 tag 保持一致。

### 4. 提交并打 tag

```sh
git add -A
git commit -m "chore: release v0.1.0"
git tag v0.1.0
git push origin main --tags
```

便捷写法（工作区需干净）：

```sh
pnpm version patch        # 或 minor / major，会改版本 + 提交 + 打 vX.Y.Z tag
git push --follow-tags
```

### 5. 等待 Actions 自动构建发布

推送 tag 触发 `.github/workflows/release.yml`，在 `macos-14` 上：

1. 安装依赖、跑 `lint:oxlint` / `typecheck` / `test`；
2. `verify-resources` → `vite build` → `electron-builder --mac --arm64 --publish never`，产出 `dmg` 与 `zip`；
3. 创建 GitHub Release，自动生成更新说明并上传 `release/*/*.zip` 与 `*.dmg`。

失败可在 Actions 页面重跑，或手动触发该 workflow 并输入 tag。

### 6. 校验 Release

打开仓库 Releases 页面，确认：

- tag 为 `v0.1.0`，且是**已发布的正式 Release**（不能是 draft / prerelease，否则 `releases/latest` 查不到）；
- 附件包含 `AndDrive-Mac-arm64-0.1.0-Installer.zip`；
- Release 正文即在客户端「更新内容」弹窗中展示的文本，可在 GitHub 上直接编辑后生效。

### 7. 客户端如何收到更新

桌面端自建更新器（`electron/updater.js`）在**启动时**查询 GitHub Releases API（`releases/latest`），对比版本后后台下载对应 `.zip`。下载完成：

1. 窗口右上角出现「更新重启」；
2. 点击后保存更新内容、退出；
3. 辅助脚本替换 `/Applications/AndDrive.app` 并重启；
4. 重启后弹窗展示更新内容。

> 目前仅在启动时检查，已运行的旧实例需**重启 App** 才会发现新版本。

## 四、版本与产物规则

- 桌面端版本：`package.json` 的 `version`；Release tag 用 `v<version>`。
- 更新器以 Release 的 `tag_name` 判断版本，以包含 `arm64` 且以 `.zip` 结尾的资源作为更新包。
- Helper 版本：`helper-app/app/build.gradle` 的 `versionCode`，由 `scripts/build-helper.sh` 写入 `resources/helper-app.version.json`。
- 资源校验：`pnpm run verify-resources` 要求 `resources/adb/mac/adb`、`resources/scrcpy/*`、`helper-app.apk`、`helper-app.version.json` 均存在且非空。

## 五、常见问题

| 现象 | 原因 |
| --- | --- |
| 只提交不 tag | 不会发布 |
| 只 tag 不提交 | 构建的是旧代码 |
| 客户端不触发更新 | `package.json` 版本未提升，或 tag 版本不高于已安装版本 |
| 客户端查不到更新 | Release 是 draft/prerelease，或缺 `.zip` 资源 |
| 手机 Helper 不升级 | `helper-app/app/build.gradle` 的 `versionCode` 未提升，或新 APK 未提交 |
| 更新点击后无反应 | 非打包（dev）环境，或没有可用更新；查看日志 `~/Library/Logs/AndDrive/update.log` |
| 扫码后一直无反应 | macOS 未授予「本地网络」权限；在系统设置 → 隐私与安全性 → 本地网络中允许 AndDrive |
