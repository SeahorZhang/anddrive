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
pnpm build:beta
```

`pnpm lint`、`pnpm format:check` 和测试命令只检查，不应修改工作区。需要自动修复 lint 时使用 `pnpm lint:fix`。

`pnpm build-helper` 使用 `helper-app/gradlew` 构建 APK，并复制到 `resources/helper-app.apk`。

`pnpm build` 会先运行资源校验（`pnpm run verify-resources`），确认 `resources/adb/mac/adb`、`resources/scrcpy/*` 和 `helper-app.apk` 存在且非空，缺资源时快速失败。首次准备资源可运行 `pnpm run download-adb`。

`pnpm build:beta` 构建可并存的 Beta 版（`AndDrive Beta`，独立 appId 与 userData，输出到 `release/beta/<version>`），版本自动带上 `-beta.<BETA_TAG>` 后缀。可通过 `BETA_TAG=xxx pnpm build:beta` 指定标签，默认使用 UTC 时间戳。Apple Silicon 单架构构建使用 `pnpm build:beta:mac:arm64`。

## 本地签名与分发

macOS 打包默认使用 ad-hoc 签名，cdhash 每次构建都会变化，系统会把每次构建当成新应用，「本地网络」权限无法保留，导致连接设备失败。项目用一个自签名代码签名证书解决这个问题，**不需要 Apple 开发者账号**。

证书文件：

| 文件 | 用途 | 是否入库 |
| --- | --- | --- |
| `certs/self-signed.cert.pem` | 公开证书，供接收方信任 | 是 |
| `certs/self-signed.key.pem` | 私钥，仅用于本机签名 | 否，务必自行备份 |

> 私钥一旦丢失，就无法再用同一身份签名，已分发版本后续升级需要重新分发证书；请把 `certs/self-signed.key.pem` 备份到安全位置。

首次运行：

```sh
pnpm cert    # 已存在则复用；有私钥+证书则恢复；都没有才新建，并信任
pnpm build
```

### 分发给其他人

接收方必须信任同一个证书，才能通过 Gatekeeper 并让「本地网络」权限稳定生效。

1. 拿到公开证书：直接用仓库里的 `certs/self-signed.cert.pem`，或本地导出：

   ```sh
   pnpm cert:export   # 输出 release/AndDrive-Signing.crt
   ```

2. 把证书文件和 `scripts/install-signing-cert.sh` 一起发给接收方。

3. 接收方一键安装并信任，并顺带去掉 App 的隔离属性：

   ```sh
   bash install-signing-cert.sh AndDrive-Signing.crt --app "/Applications/AndDrive Beta.app"
   ```

首次连接设备时，系统会弹出「本地网络」授权，点击允许即可。

> - 自签名证书只保证「本机信任 + 权限稳定」，不等于 Apple 公证。接收方若从浏览器或 AirDrop 下载 App，仍可能被 Gatekeeper 拦截，右键 App →「打开」即可。
> - 若接收方也要自行构建并签名，让他们各自运行 `pnpm cert` 生成自己的证书，而不是共享私钥。
> - 想要「下载即用、无需任何信任步骤」，只能使用付费的 Apple Developer ID 并公证，本方案不涉及。

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

缓存位于 Electron userData 目录，并按设备 serial 隔离。应用列表先显示有效缓存，再用设备上的权威列表（标签与图标内联）替换。Helper APK 仅作代码容器：不授予权限、不监听端口；它带有一个桌面图标，点击后跳转到系统无线调试的二维码配对界面，方便手机直接扫码配对。

## 连接与断开

断开按钮只移除当前无线 ADB transport，不会撤销 Android 配对记录；若要永久撤销配对，请在设备的无线调试设置中移除已配对电脑。设备已经因网络变化离线时，断开操作按幂等成功处理；其他 ADB 错误会保留当前页面并显示错误。

## 许可与资源

项目随包资源包括 macOS ADB、scrcpy 及 Helper APK。请按各资源自身的许可证和来源要求使用它们。
