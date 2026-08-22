# AndDrive

AndDrive 是一个 macOS 桌面工具，通过 Android 无线调试连接单台 Android 设备，浏览已安装应用并使用 scrcpy 启动应用镜像窗口。

> 仅支持 macOS（Apple Silicon）。Windows/Linux 构建配置已移除。

## 工作方式

1. 在 Android 设备开启无线调试。
2. 在 AndDrive 扫描二维码完成 ADB 配对。
3. AndDrive 自动发现并连接设备，安装/启动 Helper App，读取应用列表和图标。
4. 点击应用启动 scrcpy 镜像窗口。
5. 点击“断开连接”会结束当前无线 ADB 传输、清理 Helper forward 和 scrcpy；Android 中保存的配对记录不会被删除。

AndDrive 遵循**单设备优先**规则：当前只维护一台活动设备，不提供设备切换器或多设备列表。

## 前置条件

- macOS
- Node.js 22.18+（或满足 `package.json` engines 的更新版本）
- pnpm
- Android 11+ 设备，开启无线调试并与 Mac 位于同一网络
- Android SDK（构建 Helper App 时需要）
- 项目资源中的 macOS ADB、scrcpy 和 `resources/helper-app.apk`

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

`pnpm build-helper` 使用 `helper-app/gradlew` 构建 APK，并复制到 `resources/helper-app.apk`。构建桌面包前确认 ADB、scrcpy 及 Helper APK 资源存在。

## 架构

```text
Vue renderer
  → electron/preload.js
  → electron/main.js (IPC 与单设备 teardown)
  → electron/adb.js (ADB、mDNS、Helper forward、应用加载)
  → Android HelperService (本地 HTTP 协议)
```

缓存位于 Electron userData 目录，并按设备 serial 隔离。应用列表先显示有效缓存，再用设备上的权威列表和渐进图标更新。

## 连接与断开

断开按钮只移除当前无线 ADB transport，不会撤销 Android 配对记录；若要永久撤销配对，请在设备的无线调试设置中移除已配对电脑。设备已经因网络变化离线时，断开操作按幂等成功处理；其他 ADB 错误会保留当前页面并显示错误。

## 许可与资源

项目随包资源包括 macOS ADB、scrcpy 及 Helper APK。请按各资源自身的许可证和来源要求使用它们。
