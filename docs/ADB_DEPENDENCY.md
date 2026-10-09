# adb 依赖总账（用了哪些、能不能不用）

> **这份文档是什么**：全仓 adb 调用的唯一清单，以及「不用 adb 还能不能保持现在的体验」的分功能判定。
> 结论先看 §1，判定表看 §4，硬墙看 §5，可执行的减压方案看 §6。
> 引用一律用符号锚点（`electron/adb.js` 的 `adbExecSafe`），不用行号 —— 删代码会让行号集体漂移（见 `TODO.md` §2 那条）。
> 待办见 [`TODO.md`](TODO.md)，架构地图见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 1. 一句话结论

**不能。** 「不用 adb 而功能体验不变」这个命题不成立：镜像的触控注入与虚拟显示、应用管理（强停/清数据/卸载）、设备侧 helper 的执行方式、文件读写这四类是 **adb 独占**，占首页与镜像页几乎全部核心价值。

可以真正减掉的是另一件事：**把「每次 fork 一个 adb 子进程」换成已经存在的那条 adb 长连接**（见 §6）。那是内部实现换层，adb 二进制、adb server、`adb pair` 这套授权模型都还在。

## 2. adb 进入本项目的两条路

两条路共用同一个前置：**随包的 `adb` 可执行文件 + 本机 5037 上跑着的 adb server**。

| 路径 | 落点 | 怎么用 | 为什么这样分 |
| --- | --- | --- | --- |
| **A. 子进程 CLI** | `electron/adb.js` 的 `adbPath` / `ensureServer` / `adbExec` / `adbExecSafe` / `runHelperEntry` | `execFile(adbPath(), [...])`，一次命令一个进程，三级超时（15s / 45s / 5min） | 低频、一次性、要读人类可读文本的命令（`getprop`、`dumpsys`、`install`） |
| **B. 协议长连接** | `electron/devfs.js` 的 `getDeviceConnection`（`AdbServerNodeJsClient.createAdb`）、`src/mirror/connect.js` 的 `getServerClient` | TCP 连本机 adb server，走 sync / exec: 子协议，一条连接复用 | 高频热路径。实测：`createAdb` 11ms vs spawn 一次 ~300ms；895 项目录 sync 111ms vs shell 200–360ms；读 2.6 MB sync 208ms vs `exec-out cat` 1.3s（注释在 `devfs.js` 顶部） |

⚠️ B 路径**不是**「绕开 adb」：`AdbServerNodeJsClient` 连的就是 adb server，设备仍然是 adb 枚举出来的 transport。B 只是把「fork 进程」换成「socket」。

## 3. 清单：按功能域的 adb 调用

### 3.1 传输与设备生命周期（只在 adb server 侧有对应命令，无协议替代）

| 功能 | adb 命令 | 符号 | 用户能感觉到什么 |
| --- | --- | --- | --- |
| 起守护进程 | `adb start-server` | `ensureServer`（并发共用一次启动） | 所有链路的前置 |
| 配对 | `adb pair <host:port> <code>` | `CHANNELS.adbPair` | 扫码配对页 |
| 连接 / 断开 | `adb connect` / `disconnect` / `reconnect` | `adbConnect` handler、`disconnectTransport`、`reconnectDevice` | 「连接」「断开」、心跳重连 |
| 设备列表 | `adb devices` | `parseAdbDevices` / `listConnectDevices` / `getConnectedDevice` / `getDeviceState` | 右上角设备列表、状态标记（`device`/`offline`/`unauthorized`）、启动接管 |
| 无线服务发现 | `adb mdns services` | `waitForMdnsService` / `connectServicesBySerial` / `resolveReconnectAddress` | 配对时锁定同一台、重连时找回新端口 |

### 3.2 设备身份与名称（持久化键的地基）

| 功能 | adb 命令 | 符号 |
| --- | --- | --- |
| 稳定标识 | `shell getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id` | `resolveDeviceStableId` → `device-aliases.json` |
| 设备展示名 | `settings get secure bluetooth_name` / `global device_name` / `getprop ro.product.marketname` | `deviceDisplayName` |

收藏、应用缓存、`.adr` 快捷方式全部按稳定标识存（`favorites.js`、`shortcut.js` 各 import 一次 `resolveDeviceStableId`）。**这块没有 adb 就没有正确键**：无线每次重连地址就换，按地址存的键当场作废。

### 3.3 Helper 的执行方式（整条应用/存储链路的地基）

| 功能 | adb 命令 | 符号 |
| --- | --- | --- |
| 安装 / 卸载 | `install -r helper-app.apk` / `uninstall com.anddrive.helper` | `installHelper` / `uninstallHelper` / `ensureLatestHelper` / `deviceApkPath`（`pm path`） |
| 跑代码 | `exec-out CLASSPATH=<apk> app_process /system/bin <ListMain\|StorageMain>` | `runHelperEntry` |

关键点：helper 装到设备上**只是当 classpath**，不启动组件、不授予权限，代码以 **shell uid(2000)** 一次性执行。这一步是整个「零权限、零后台组件」定位的实现方式（`helper-app/README.md`），也意味着**能力上限由 adb shell 的授权表决定**，不由我们写的 Java 决定。

### 3.4 应用列表 / 图标 / 应用管理

| 功能 | adb 命令 | 符号 |
| --- | --- | --- |
| 列表与图标 | helper `ListMain`（经 §3.3） | `loadInstalledApps` / `getAppIcons` / `normalizeListOutput` |
| 强停 | `shell am force-stop` | `forceStopApp` |
| 清除数据 | `shell pm clear` | `clearAppData` |
| 卸载应用 | `adb uninstall` | `uninstallApp` |
| 应用信息 | `shell dumpsys package` + `pm path` | `getAppInfo` |
| 导出 APK | `pm path` + `adb pull` | `exportApk` |

### 3.5 设备信息面板与编码器

| 功能 | adb 命令 | 符号 |
| --- | --- | --- |
| 型号/品牌/系统/SoC | `shell getprop`（全量） | `getDeviceStats` + `parseGetprop` |
| 电量 | `shell dumpsys battery` | `parseBattery` |
| 内存 | `shell cat /proc/meminfo` | `parseMemory` |
| CPU 负载/核数 | `loadavg; nproc; grep hardware /proc/cpuinfo` | `parseCpu` |
| 网络 IP/网卡 | `shell ip -o -4 addr` | `parseNetwork` |
| 存储按卷读数 | helper `StorageMain`（经 §3.3） | `storage.js` 的 `getStorageReport` |
| 可编码格式 | grep `media_codecs*.xml` | `getDeviceVideoCodecs` + `VIDEO_ENCODER_PROBE_CMD` |

### 3.6 镜像（scrcpy）链路上的 adb 依赖

| 功能 | 走哪条路 | 符号 |
| --- | --- | --- |
| 推 server、起会话、拿视频/音频/控制三路 | B（Tango `AdbScrcpyClient`） | `connect.js` 的 `startScrcpy` |
| 启动应用 | B（scrcpy `startApp`） | `direct-session.js` 的 `startSession` |
| 查应用挂在哪个显示 | A：`dumpsys window windows \| grep …` | `getAppTask` |
| 把任务搬回本窗口显示（**不冷启**） | A：`shell am display move-stack` | `moveAppTaskToDisplay` → `reclaimApp` |
| 窗口初始形状 | A：`shell wm size` | `getPhysicalScreenSize` |
| MIUI 息屏仍继续合成 | A：`settings put secure synergy_mode` | `setSecureSetting` + `miProjection.js` |
| 插电时不休眠（Android 13 及以下那档镜像期间，**开前先读原值、关会话时还原**） | A：`settings get/put global stay_on_while_plugged_in` | `getGlobalNumberSetting` / `setGlobalNumberSetting` + `keepAwake.js` |
| 设备睡了没有（镜像窗口的「已休眠」横幅） | A：`dumpsys power \| grep -m1 -oE mWakefulness=` | `getWakefulness` + `src/mirror/sleepWatch.js` |
| 点「继续使用」点亮屏幕 | A：`input keyevent 224`（KEYCODE_WAKEUP，吃 `INJECT_EVENTS`） | `wakeDevice` → `direct-session.js` 的 `wakeScreen` |
| MIUI/HyperOS 判定 | A：`getprop ro.miui.ui.version.name` | `isMiuiDevice` |
| 虚拟显示创建/resize | B（scrcpy flex display 控制消息） | `formatNewDisplay` / `resizeDisplay` |

### 3.7 文件读写（设备存储挂到访达）

B 路径的 sync 子协议 + `exec:`，全部在 `devfs.js`：`statDevicePath`（`sync.stat`，旧设备回落 `toybox stat`）、`listDeviceDir`（`sync.readdir`）、`openDeviceFile`（`start=0` 走 `sync.createReadable`，中间偏移才 spawn 设备侧 `dd`）、`writeDeviceFile`（`sync.write` SEND 流式）、`makeDeviceDir` / `removeDevicePath` / `moveDevicePath` / `copyDevicePath`（`exec:` + `sh -c`，参数走 `quoteShell`）。上层是 `webdav.js` 的 127.0.0.1 WebDAV + `storage.js` 的 `mount_webdav`。

## 4. 逐功能判定：不用 adb 会怎样

| 功能 | adb 是否独占 | 不用 adb 的替代 | 体验代价 |
| --- | --- | --- | --- |
| 配对/连接/设备列表/重连 | **是**（授权模型本身就是 adb） | 无 | —— |
| 镜像画面（虚拟显示、画质档位、跟随窗口尺寸） | **是** | 设备侧 `MediaProjection` | 每次会话手机弹「开始录制」确认；拿不到任意尺寸的自有虚拟显示 → pad 版式、`1dp = 1 CSS px`、窗口跟随全丢 |
| 镜像触控/滚动注入 | **是**（`INJECT_EVENTS` 属 shell/系统） | `AccessibilityService`（用户手动开无障碍） | 要用户去设置里开无障碍并常驻；手势保真度与延迟都差；MIUI 会杀 |
| 强停 / 清数据 / 卸载任意应用 / 导出 APK | **是** | 无（普通 app 只能操作自己） | 应用管理那一圈右键全空 |
| 搬移任务回本显示 | **是**（`am display move-stack`） | 无 | 「接回画面」消失 |
| MIUI 息屏继续合成 | **是**（`WRITE_SECURE_SETTINGS`） | 无 | 息屏卡画面回来 |
| 镜像期间插电不休眠 | 否（设备侧 helper 持 `WAKE_LOCK` 也行，竞品就走这条） | helper 常驻服务 + `FLAG_KEEP_SCREEN_ON` | adb 这条零安装、零常驻服务，且**能读回原值再还原**；代价是只在插电时成立 |
| 点亮屏幕（「继续使用」） | **是**（`INJECT_EVENTS`） | 无（普通 app 起不了别人的唤醒） | MIUI 上这条吃「USB 调试（安全设置）」那道闸，被拒时按钮要说清为什么 |
| 应用列表与图标 | 否 | `QUERY_ALL_PACKAGES` 常驻 app 可列可取图标 | 需要装一个**有权限、常驻**的 app：Android 11+ 权限审查、ROM 后台限制、冷启动要 IPC 握手；与 helper 定位冲突（见 §7） |
| 存储按卷读数 | 否 | `StorageManager` + `StatFs` | 与手机设置/竞品口径一致性要重新验（`TODO.md` §6.1 F10） |
| 设备信息面板 | 大部分否 | 同一个常驻 app（battery/meminfo/loadavg/getprop 普通 app 大多读得到） | 个别 ROM 收紧 `/proc`；市场名等字段口径变化 |
| 文件读写（访达里的卷） | 否 | 设备侧 HTTP/WebDAV/SMB 服务 app | 要用户装并常驻监听端口的服务；权限、后台存活、端口冲突都变成用户的事 |

**读法**：上表的「否」全都需要**同一个前置**——设备上跑一个有权限、常驻、监听端口的 companion app。而这正是本项目已经明确排除的形态（§7）。

## 5. 两道硬墙（决定「能不能绕」，不是决定「麻烦不麻烦」）

1. **无线 TLS 握手要 PSK**。Android 11+ 的无线调试用 SPAKE2+ 协商出 **TLS_PSK** 会话密钥（`adb pair` 的那三位码就是给它的）。Node 的 `tls` 模块不暴露 PSK 密码套件回调，所以「自己实现一个 adb 客户端、不经 adb server」在无线侧要么引原生 SSL 层，要么把握手交给一个第三方原生库。**待实测确认到多硬**：可以先用一个 spike 验证 `node:tls` 能否吃到 PSK（预期不能），再决定是否投入。
2. **能力上限就是 adb 授权表**。`app_process` 以 shell uid 跑，拿到的是 shell 的权限集（含 `WRITE_SECURE_SETTINGS`、`INJECT_EVENTS`），**这是当前架构的承重墙而不是巧合**：它让我们既不需要向用户要权限，也不需要常驻组件（MIUI 那道「USB 调试（安全设置）」闸之所以会让登记空转、镜像点不动，正是同一张授权表的两面）。换成普通 app 身份，§4 表里「adb 独占」那一列全部从「是」变成「做不到」。
3. **USB 侧**同理：不走 adb 就要自己实现 USB 传输（macOS 上没有 WebUSB，得引 libusb 绑定 + 自写 adb USB 协议），工程量比无线侧更大，且拿不到 adb 现有的 `authorizing`/`offline` 状态语义。

## 6. 可行的减压方向：减「fork」，不是减「adb」

这一档**不改用户可见体验**，改的是实现层，收益与代价都实测得出来：

| # | 做法 | 能换掉的 adb 调用 | 代价 |
| --- | --- | --- | --- |
| T1 | §3.2 / §3.4 / §3.5 里所有 `shell` 类命令搬到 `devfs.js` 那条长连接（`adb.subprocess` / `exec:`） | `deviceDisplayName`、`resolveDeviceStableId`、`getDeviceStats` 五条、`getAppTask`、`moveAppTaskToDisplay`、`getPhysicalScreenSize`、`isMiuiDevice`、`setSecureSetting`、`getDeviceVideoCodecs`、`getAppApkPaths`、`forceStopApp` / `clearAppData`、`runHelperEntry` | 中：超时阶梯与「设备无响应」文案要在协议层重做；`pm clear` / `install` 的 `/Success/i` ROM 怪癖嗅探要重验；`ADB_TRANSFER_TIMEOUT_MS` 那套保护没有等价物 |
| T2 | `adb pull` 换 sync RECV | `exportApk` | 小：路径已知（`pm path`），RECV 已是现成能力（`openDeviceFile`） |
| T3 | `adb devices` / `connect` / `pair` 搬到 5037 的 host 命令 | `adbExec(["devices"])`、`adbExec(["connect"])`、`adbExec(["pair"])`、`adb mdns services` | 大且**收益不明**：adb server 自己还是 `adb` 二进制起的，进程还是少不掉；`mdns services` 是否能在 host 协议里拿到**未验证**（`mdns.js` 已经自带一套 DNS-SD，但 serial 匹配仍依赖 adb 的输出格式） |
| T4 | 合并同类探测（一次 `exec` 里串多条命令） | `getDeviceStats` 现在 5 次 fork 已算并行，`deviceDisplayName` 3 次 | 小：注意别一次挂太长，与 §3.7 的并发额度（`MAX_CONCURRENT_DEVICE_OPS`）抢同一条链路 |

**顺序建议**：T2（便宜）→ T1（大头，且和 `TODO.md` O1「拆 `adb.js`」是同一条刀）→ T4；T3 除非有明确目标（比如不想再随包 `adb` 二进制），否则不做。

## 7. 与既有决策的关系

- **不做常驻/监听端口的设备端服务**（`TODO.md` §8「非目标」）。§4 表里所有「否」的替代方案都要先推翻这条。
- **helper 定位 = 零权限、零后台组件的代码容器**（`TODO.md` §6.2 的前置决策）。把它变厚成有权限常驻 app 是**产品形态变更**，不是重构。
- **不做老用户兼容**（`TODO.md` §8）。若真换设备身份，`device-aliases.json`、收藏键、缓存键会全裂，但按既定口径**不写迁移**。
- `TODO.md` O1（拆 `electron/adb.js`）与本文件的分域是同一刀：§3 的小节划分可直接当拆分后的模块名。

## 8. 不靠 adb 的部分（避免误判成「全是 adb」）

`mount_webdav` / `umount`（`storage.js`）、`osascript` + `sips`（`iconImage.js`、`shortcut.js` 的图标与 Finder 图标）、`lsregister`（`shortcut.js` 的 UTI 注册）、`/usr/bin/dns-sd`（`permissions.js` 探测本地网络权限）、`electron/mdns.js` 手写的 DNS-SD 报文（读 mDNS TXT 里的 `given_name`）。WebCodecs 解码、Opus 音频、`.adr` 文件与 `anddrive://` 唤起也都不经过 adb —— 但它们的**输入**（serial、图标、包名）来自 adb 那几条链路。
