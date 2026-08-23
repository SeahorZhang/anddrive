# AndDrive Helper App

Helper App 安装在 Android 设备上，本质是一个**代码容器**：桌面端通过 `app_process` 以 shell（uid 2000）身份一次性执行其中的入口类，stdout 返回应用列表 JSON 后进程即退出。不授予任何权限、不监听端口；桌面上会显示一个图标（点击即关的空 Activity 占位），方便用户在手机上确认和卸载。

当前实现只有 `ListMain.java` 一个类；旧的 `HelperService`/HTTP 协议与更早的常驻 `app_process` 服务器均已删除。

## 构建

前置条件：Android SDK、Java/Gradle 环境和可用的 SDK platform。项目固定使用 Gradle wrapper；主项目脚本会检查 `ANDROID_HOME`，并将 debug APK 复制到桌面应用需要的资源位置。

```sh
pnpm build-helper
```

等价的本地调试构建：

```sh
cd helper-app
./gradlew assembleDebug
```

APK 输出于 `helper-app/app/build/outputs/apk/debug/app-debug.apk`，`pnpm build-helper` 会复制为 `resources/helper-app.apk`。不要提交 `local.properties`、`build/` 或 Gradle reports。

## 运行方式

1. 主进程使用 ADB 将 `resources/helper-app.apk` 安装到设备（仅当未安装时）。
2. 通过 `adb shell pm path com.andrive.helper` 解析设备上的 base.apk 路径。
3. 以 shell 身份执行一次：

   ```text
   adb -s <serial> exec-out CLASSPATH=<base.apk> app_process /system/bin com.andrive.helper.ListMain
   ```

4. stdout 输出一行 JSON，进程自动退出：

   ```json
   {"apps":[{"packageName":"com.example.app","label":"示例应用","iconPng":"<base64>"}]}
   ```

系统应用会被过滤；标签来自 `PackageManager`（`ResolveInfo.loadLabel`），图标渲染为 256×256 PNG 并以 base64 内联。单个应用的标签或图标失败只降级该条目，不影响整体列表。

## 维护说明

入口逻辑位于 `app/src/main/java/com/anddrive/helper/ListMain.java`，输出契约的解析在主进程 `electron/helper/helperList.js`（有单元测试）。修改输出结构时两边同步更新，并运行：

```sh
pnpm lint && pnpm typecheck && pnpm test
pnpm build-helper
```
