# Android 无线连接

AndDrive 当前支持 macOS 上连接一台 Android 11+ 设备。连接链路如下：

```text
Vue renderer
  → preload IPC bridge
  → Electron main（组装层）
  → electron/adb/* · electron/helper/*
  → ADB exec-out（shell uid 2000）
  → app_process: com.anddrive.helper.ListMain（一次性执行）
```

## 前置条件

- Android 11 或更新版本
- 手机与 Mac 连接同一局域网
- 手机已开启“开发者选项 → 无线调试”
- macOS 防火墙允许本机 mDNS/ADB 通信

无线调试配对不会删除手机上的数据。AndDrive 的二维码只承载本次配对所需的临时 SSID 和配对码。

## 配对步骤

1. 打开 AndDrive，点击“添加设备”。
2. 在手机的“无线调试”中选择“使用二维码配对设备”。
3. 扫描 AndDrive 显示的二维码。
4. AndDrive 通过 Bonjour/mDNS 发现 `_adb-tls-pairing` 服务并执行 `adb pair`。
5. 配对成功后，应用轮询 ADB 设备列表，选择状态为 `device` 的设备。

配对记录会由 Android 保留。之后只要无线调试重新可用，AndDrive 可以恢复该设备的连接；这与点击“断开连接”不同。

## 应用列表和 Helper

连接后主进程会：

1. 检查并安装 `resources/helper-app.apk`（如需要）。
2. 通过 `pm path` 解析设备上的 base.apk 路径。
3. 以 shell 身份一次性执行 `app_process ... com.anddrive.helper.ListMain`，stdout 返回应用列表 JSON（标签与图标内联），进程随即退出。
4. 先显示有效缓存，再以设备返回的权威列表替换。
5. 不授予 Helper 权限、不占用任何端口；桌面上仅有一个点击即关的图标占位。

Helper 协议和构建方式见 [`../helper-app/README.md`](../helper-app/README.md)。

## 启动应用

应用卡片需要图标才能启动。图标晚到时，点击会暂存请求；图标到达后 AndDrive 调用 scrcpy，并把当前设备 serial、应用包名和图标传给主进程。scrcpy 使用项目内的 macOS 资源运行。

## 断开连接

确认断开后，主进程按以下顺序清理：

1. 取消该设备的应用加载，阻止旧的列表事件污染页面。
2. 停止关联的 scrcpy 进程。
3. 执行 `adb disconnect <serial>`。
4. 成功后回到“添加设备”页面。

这只结束当前无线 ADB transport，不会删除 Android 的配对记录。若目标已经因为网络中断而不再连接，断开仍视为成功。真正的 ADB、权限或 daemon 错误会留在当前设备页，并允许重试。

如果要彻底撤销电脑授权，请在手机上进入“无线调试 → 已配对的设备”，移除对应电脑。

## 故障排查

### 找不到二维码配对服务

确认手机和 Mac 在同一网络，关闭会阻断 UDP 5353 的访客网络隔离或防火墙规则，然后重新打开添加设备对话框。

### 配对成功但没有设备

保持无线调试页面开启，确认设备没有显示 `unauthorized` 或 `offline`。必要时重启 ADB server 后重新配对。

### Helper 无法读取应用

确认 `resources/helper-app.apk` 存在，并运行：

```sh
pnpm build-helper
```

首次连接可能需要等待安装提交；若手机弹出「USB 安装」确认框，请在手机上允许。

### scrcpy 无法启动

确认 macOS 资源目录包含 `resources/scrcpy/scrcpy` 和 `scrcpy-server`，并且二进制可执行。应用图标缺失时，先等待图标加载完成再重试。
