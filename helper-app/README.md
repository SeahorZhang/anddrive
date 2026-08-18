# AndDrive Helper App

Helper App 是安装在 Android 设备上的最小前台服务，为 AndDrive 提供已安装应用和 PNG 图标。它只通过 ADB forward 暴露给本机，不是通用网络服务器。

当前实现使用 `HelperService`、`HelperProtocol` 和端口 `18923`；旧的 `app_process` 实现已删除。

## 构建

前置条件：Android SDK、Java/Gradle 环境和可用的 SDK platform。项目固定使用 Gradle wrapper；主项目脚本会检查 `ANDROID_HOME`，并将 debug APK 复制到桌面应用需要的资源位置。

```sh
pnpm build-helper
```

等价的本地调试构建：

```sh
cd helper-app
./gradlew assembleDebug
./gradlew testDebugUnitTest
./gradlew lintDebug
```

APK 输出于 `helper-app/app/build/outputs/apk/debug/app-debug.apk`，`pnpm build-helper` 会复制为 `resources/helper-app.apk`。不要提交 `local.properties`、`build/` 或 Gradle reports。

## 运行方式

1. 主进程使用 ADB 将 `resources/helper-app.apk` 安装到设备。
2. 启动 `com.andrive.helper/.HelperService`。
3. 建立 `adb -s <serial> forward tcp:18923 tcp:18923`。
4. 主机通过 `http://127.0.0.1:18923` 请求接口。
5. 应用加载完成或取消后，主进程移除 forward。

服务在 Android 端监听本地端口，接口不会直接暴露到局域网。断开设备时主进程也会清理 forward；服务进程是否立即停止不影响 ADB transport 的断开。

## HTTP 协议

### `GET /ping`

返回能力和协议版本：

```json
{"ok":true,"protocol":3,"batchIcons":true}
```

### `GET /apps`

返回应用列表 envelope，而不是裸数组：

```json
{
  "apps": [
    {"packageName":"com.example.app","label":"示例应用"}
  ],
  "count": 1
}
```

系统应用会被过滤，标签由 Android `LauncherApps` 或 `PackageManager` 提供。

### `GET /icons-bin?pkgs=...`

`pkgs` 是逗号分隔、URL 编码的包名列表。响应是二进制帧序列，每帧为：

```text
uint16 big-endian package-name byte length
UTF-8 package name
uint32 big-endian icon byte length
PNG bytes (length 为 0 表示没有图标)
```

协议最多处理 32 个包名，每个名称最多 512 字节。当前服务将图标缩放为 256×256 PNG，并限制单个图标大小。

### `GET /icon-bin?pkg=...`

这是单图标的 legacy fallback。主进程在批量接口不可用时逐个请求它。

## 维护说明

协议常量和批量帧编码位于 `app/src/main/java/com/anddrive/helper/HelperProtocol.java`，纯逻辑测试位于 `app/src/test`。修改协议时同步更新主进程 `electron/adb/parsers.js`，并运行：

```sh
pnpm test:helper
pnpm lint:helper
pnpm build-helper
```
