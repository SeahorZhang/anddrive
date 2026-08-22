# Android 无线连接

AndDrive 当前支持 macOS 上连接一台 Android 11+ 设备。连接链路如下：

```text
Vue renderer
  → preload IPC bridge
  → Electron main
  → electron/adb|helper|cache|scrcpy 分组模块
  → ADB forward
  → Android HelperService
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
5. 配对成功后，应用等待手机确认连接（部分机型会弹授权提示），建立无线传输并按需安装 Helper App，随后进入主界面。

配对记录会由 Android 保留。重新打开 AndDrive 时会主动恢复已配对设备的连接；但点击"断开连接"后设备会保持离线，直到你再次扫码连接。

## 应用列表和 Helper

连接后主进程会：

1. 检查并安装 `resources/helper-app.apk`（如需要）。
2. 启动 `com.andrive.helper/.HelperService`。
3. 执行 `adb -s <serial> forward tcp:18923 tcp:18923`。
4. 通过本机 HTTP 请求 `/ping`、`/apps` 和 `/icons-bin` 获取数据。
5. 先显示有效缓存，再以设备返回的权威列表替换，并渐进更新图标。
6. 加载结束或取消时移除 forward。

Helper 协议和构建方式见 [`../helper-app/README.md`](../helper-app/README.md)。

## 启动应用

应用卡片需要图标才能启动。图标晚到时，点击会暂存请求；图标到达后 AndDrive 调用 scrcpy，并把当前设备 serial、应用包名和图标传给主进程。scrcpy 使用项目内的 macOS 资源运行。

## 断开连接

确认断开后，主进程按以下顺序清理：

1. 终止后台恢复任务，确保不会静默重连。
2. 停止关联的 scrcpy 进程。
3. 取消该设备的应用加载，阻止旧的列表/图标事件污染页面。
4. 等待现有 Helper forward 的清理并移除 `tcp:18923`。
5. 执行 `adb disconnect <serial>`。
6. 成功后回到“添加设备”页面。

这只结束当前无线 ADB transport，不会删除 Android 的配对记录。若目标已经因为网络中断而不再连接，断开仍视为成功。真正的 ADB、权限或 daemon 错误会留在当前设备页，并允许重试。

如果要彻底撤销电脑授权，请在手机上进入“无线调试 → 已配对的设备”，移除对应电脑。

## 故障排查

### 打包安装后扫码无反应（开发模式正常）

macOS 15+ 的"本地网络"权限按代码签名身份授权。ad-hoc 签名的包（无稳定身份，每次重新打包
cdhash 都变）会出现：系统设置里开关显示已打开，但应用实际仍收不到 mDNS 组播。

验证方法：

```sh
# 用已安装的二进制跑组播监听，同时手机打开配对弹窗；收不到广播即中招
ELECTRON_RUN_AS_NODE=1 /Applications/AndDrive.app/Contents/MacOS/AndDrive -e "
const {Bonjour}=require('bonjour-service');const b=new Bonjour();
b.find({type:'adb-tls-pairing'},s=>console.log('收到',s.addresses,s.port));
setTimeout(()=>process.exit(0),15000)"
```

修复：构建配置已固定 `mac.identity: "AndDrive Dev Cert"`（登录钥匙串中的自签代码签名证书，
有效期至 2036 年）。证书丢失时重建步骤：

```sh
openssl req -newkey rsa:2048 -nodes -keyout anddrive.key -x509 -days 3650 \
  -out anddrive.crt -subj "/CN=AndDrive Dev Cert" \
  -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=codeSigning"
openssl pkcs12 -export -out anddrive.p12 -inkey anddrive.key -in anddrive.crt -passout pass:临时密码
security import anddrive.p12 -k ~/Library/Keychains/login.keychain-db -P 临时密码 -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign anddrive.crt
```

重装后首次启动会弹"本地网络"授权，允许一次后因身份稳定而长期有效。

### 找不到二维码配对服务

确认手机和 Mac 在同一网络，关闭会阻断 UDP 5353 的访客网络隔离或防火墙规则，然后重新打开添加设备对话框。

### 配对成功但没有设备

保持无线调试页面开启，确认设备没有显示 `unauthorized` 或 `offline`。必要时重启 ADB server 后重新配对。

### Helper 无法读取应用

确认 `resources/helper-app.apk` 存在，并运行：

```sh
pnpm build-helper
```

查看 Helper 的 `/ping` 能力协商是否成功。首次连接可能需要等待安装和前台服务启动。

### scrcpy 无法启动

确认 macOS 资源目录包含 `resources/scrcpy/scrcpy` 和 `scrcpy-server`，并且二进制可执行。应用图标缺失时，先等待图标加载完成再重试。
