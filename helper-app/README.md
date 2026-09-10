# AndDrive Helper App

Helper App 安装在 Android 设备上，主要作为**纯代码容器**：不申请权限、不监听端口。桌面端通过 `app_process` 以 shell（uid 2000）身份一次性执行 `ListMain`，stdout 返回应用列表 JSON 后进程即退出。

此外提供一个桌面图标（`MainActivity`）：点击后直接跳转 Android 的“无线调试”页面，方便开启配对；页面打开后 Activity 立即结束。由于 Android 没有公开的无线调试深链 Intent，实现优先使用 Settings 的 QS 磁贴长按网关：

```text
com.android.settings/.qstile.QSTileLongPressGatewayActivity
  + EXTRA_COMPONENT_NAME = com.android.settings/.development.qstile.AdbWirelessDebuggingDevelopmentTile
```

该入口不可用时再依次尝试 OEM 的隐藏入口，最后回退到“开发者选项”页面。

当前实现包含 `ListMain.java` 与 `MainActivity.java` 两个类。

## 构建

前置条件：Android SDK、Java（JDK 17+）和可用的 SDK platform。项目使用 Gradle wrapper；主项目脚本会检查 `ANDROID_HOME`，并将 debug APK 复制到桌面应用需要的资源位置。

```sh
pnpm build-helper
```

等价的本地调试构建：

```sh
cd helper-app
./gradlew assembleDebug
```

APK 输出于 `helper-app/app/build/outputs/apk/debug/app-debug.apk`，`pnpm build-helper` 会复制为 `resources/helper-app.apk`，并从 `app/build.gradle` 解析版本写入 `resources/helper-app.version.json`。桌面端据此比较设备上已安装 Helper 的 `versionCode`，旧版自动重装（见 `electron/adb.js` 的 `ensureHelper`）。升级 Helper 时请同步提升 `app/build.gradle` 的 `versionCode`，否则设备不会触发升级。不要提交 `local.properties`、`build/` 或 Gradle reports。

## 运行方式

1. 主进程使用 ADB 将 `resources/helper-app.apk` 安装到设备（仅当未安装时）。
2. 通过 `adb shell pm path com.anddrive.helper` 解析设备上的 base.apk 路径。
3. 以 shell 身份执行一次：

   ```text
   adb -s <serial> exec-out CLASSPATH=<base.apk> app_process /system/bin com.anddrive.helper.ListMain
   ```

4. stdout 输出一行 JSON，进程自动退出：

   ```json
   { "apps": [{ "packageName": "com.example.app", "label": "示例应用" }] }
   ```

系统应用会被过滤；标签来自 `PackageManager`（`ResolveInfo.loadLabel`）。单个应用标签失败只降级该条目，不影响整体列表。

### 图标模式

列表默认不带图标；桌面端按需补取时追加 `--icons` 参数，只返回指定包名的图标：

```text
adb -s <serial> exec-out CLASSPATH=<base.apk> app_process /system/bin com.anddrive.helper.ListMain --icons com.a.b,com.c.d
```

```json
{ "apps": [{ "packageName": "com.a.b", "iconPng": "<base64>" }] }
```

图标渲染为 128×128 PNG 并以 base64 内联（`data:image/png;base64,...` 由主进程拼接）。缺失/失败的包名直接跳过该条目。

## 维护说明

入口逻辑位于 `app/src/main/java/com/anddrive/helper/ListMain.java`，输出契约的解析在主进程 `electron/helper/helper.js`（`normalizeListOutput`）。修改输出结构时两边同步更新，并运行：

```sh
pnpm lint && pnpm typecheck && pnpm test
pnpm build-helper
```

注意：`ActivityThread.systemMain()` 内部会构造 Handler，要求线程已准备 Looper；`ListMain.systemContext()` 中先调用 `Looper.prepareMainLooper()` 再触发，否则会抛 `Can't create handler inside thread ... that has not called Looper.prepare()`。
