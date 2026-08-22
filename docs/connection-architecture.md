# 手机连接内部架构（开发者 / LLM 必读）

> 本文是 AndDrive 连接链路的唯一事实来源。**任何修改连接行为的代码，动手前先读完本文；改完行为后必须同步更新本文**。
> 用户视角的说明见 [`phone-connection.md`](phone-connection.md)；本文解释"为什么是这样"。

## 0. 总览

```text
Vue renderer（组件 → composables → services/desktopApi.js）
  ↓ IPC（channel 只存在于 shared/ipcContract.js、electron/main.js、electron/preload.js）
Electron main.js（组合根：IPC 注册表 + pairDevice/disconnectDevice/restoreDevice 编排）
  ├─ adb/deviceMonitor.js     adb track-devices 常驻监听 → devices-changed 事件
  ├─ adb/discoveryService.js  mDNS 浏览 pairing/connect 服务 → 即时回调
  ├─ adb/adbClient.js         全部 adb 命令封装（带超时护栏）
  ├─ adb/deviceParser.js      纯解析：devices/-l/mdns services 输出、影子传输判定
  ├─ helper/*                 Helper APK 安装、forward 会话锁、HTTP 协议、应用加载
  ├─ cache/ scrcpy/
  └─ resourceResolver.js      打包资源路径唯一来源
目标：macOS ↔ Android 11+ 无线调试（单设备模型），Helper 走 adb forward 本地 HTTP。
```

## 1. 受管 adb server —— 一切的前提

`adbClient.restartManagedServer()` 在应用启动时（`app.whenReady` 内、任何事件监听之前）执行：

1. `adb kill-server`——旧实例可能由外部工具拉起，env 不生效；
2. `adb start-server`，环境变量 **`ADB_MDNS_AUTO_CONNECT='0'`**。

**为什么必须禁用自动连接**（实测结论）：

- 配对完成瞬间存在**密钥同步竞态**：手机端 adbd 刚广播 tls-connect 服务、密钥尚未就绪，
  adb server 的自动连接抢跑 → TLS 握手失败 → transport 以 **offline 态占位**，且不会自行恢复。
- 自动连接还会在用户点"断开"后**静默重连**（手机持续广播）。
- 禁用后规则变为：**一切连接都由应用显式发起**（配对编排 / 启动恢复），断开即彻底离线。

## 2. 设备状态与传输形态（核心领域知识）

`adb devices -l` 中每条传输有三种状态与两种形态：

| 形态 | 例 | 来源 |
|---|---|---|
| ip:port | `192.168.100.91:43879` | 显式 `adb connect`（应用发起） |
| mDNS 命名 | `adb-af3d7abd-Zvci5V._adb-tls-connect._tcp` | 历史/外部工具的自动连接残留 |

| 状态 | 含义 | 处理策略 |
|---|---|---|
| `device` | 在线 | **须经 `isReachable()` 探测才算真在线**（防僵尸假在线） |
| `offline` | 握手失败或**等待手机端授权**（MIUI 每条新连接要确认） | **绝不断开**——可能是挂起授权，断开会掐掉弹窗 |
| `unauthorized` | 手机端待确认 USB 式授权 | 不碰，等用户处理 |

三个必须记住的特殊情况：

1. **僵尸传输**：`device` 态但任何 shell 命令挂起（历史会话遗留）。`isReachable(serial)` 用 4s 超时
   `shell echo` 甄别；探测失败 → `disconnect` 清理并从候选剔除。
2. **影子传输**：同一台手机同时存在 ip:port 与 mDNS 命名两条在线传输（自动连接时代的产物）。
   `splitShadowTransports()` 按 `model` 属性识别同机，命名条目判为影子 → 断开，
   否则 `selectDevice` 会误报多设备冲突。
3. **offline ≠ 垃圾**：等待授权期间就是 offline；用户在手机上点"允许"后自行翻转为 `device`，
   track-devices 事件随即推送。清理逻辑只针对 `pruneWirelessTransports`（启动恢复路径）中的
   offline 条目，配对等待期绝不触碰。

## 3. 事件系统（关键路径禁止轮询推进）

| 事件源 | 实现 | 消费方 |
|---|---|---|
| 设备增减 | `deviceMonitor`：常驻 `adb track-devices` 子进程，4 位十六进制长度前缀帧解析，订阅时回放当前快照 | main 广播 `adb:devices-changed`；`onceDeviceOnline` 成功判定 |
| mDNS 服务出现 | `discoveryService`：bonjour up 回调，`announced` 去重；`onDiscovered`=pairing 服务、`onConnectTarget`=connect 服务端口 | main 广播 discovered-target；`onceDeviceOnline` 主动重连信号 |
| 配对进度 | main 编排经 `event.sender.send` 推 `PairingEvent` | `usePairing` 映射提示文案 |

**成功判定永远走 track-devices 事件 + 可达性探测**；mDNS 只是端口来源，不是成功信号。

## 4. 四大流程逐段拆解

### 4.1 应用启动恢复（App.vue init → useDevice.connect）

```text
connect():
  attempt(): getDevices()（= pruneWirelessTransports：影子/offline/僵尸清理后返回快照）
    ├─ conflict → 抛错展示在添加设备页
    ├─ ok       → getDeviceInfo → connected → home
    └─ none     → fire-and-forget restoreDevice()（后台长任务，不阻塞 UI）→ false
idle 状态下 App.vue 订阅 devices-changed：
  任一 device 上线且扫码弹窗未打开 → 自动重新 init() 进入 home
restoreDevice(): onceDeviceOnline(null, 60s, 2s 兜底) 后台静默尝试显式重连已配对设备
```

### 4.2 扫码配对连接（usePairing → IPC pairDevice）

```text
打开弹窗 → startDiscovery()（浏览 adb-tls-pairing）
手机扫码 → pairing 服务 up → onDiscoveredTarget → doPair(address)
main.pairDevice(event, host, port, code):
  notify('pairing')  → adb.pair（protocol-fault 自动重试 ×3）
  notify('paired')
  notify('connecting') → onceDeviceOnline(host)   ← 见 4.3
  notify('connected')
  helper.isInstalled? no → notify('installing') → install(APK 180s) → notify('installed')
  resolve(serial)；任一步失败整体 reject
usePairing 仅映射 PHASE_MESSAGES 到界面文案；promise resolve → success → 800ms → 关弹窗 emit('paired')
App.vue @paired → init() → getDeviceInfo → home
```

### 4.3 连接等待核心 `onceDeviceOnline(preferHost=null, timeoutMs=30000, fallbackMs=3000, isStopped)`

并行四条路径，谁先命中谁赢：

1. **初始快照**：立即 `listDevices` 评估（订阅前可能已连上/已有 offline 残留）；
2. **track-devices 事件**：出现匹配 `preferHost`（或任意）的 `device` 态候选 → `consider()`：
   `isReachable` 探测通过才算上线；失败记入 rejected 集合并 disconnect 清理僵尸；
3. **onConnectTarget**：自家 bonjour 看到 preferHost 匹配的 tls-connect 端口 → 立即显式 connect（幂等）；
4. **兜底轮询**：每 `fallbackMs` 查一次 `adb mdns services`（解析函数 `parseMdnsConnectTargets`）→ 显式 connect。

约束：

- `isStopped()` 取消谓词贯穿所有路径，置位后安静 `resolve(null)`；
- **offline 条目不参与候选也不被清理**（可能是等授权）；
- 总护栏超时 reject `'等待设备上线超时…'`——仅防永不成功，正常路径全是事件驱动。

### 4.4 断开（彻底断开语义）

```text
PageHeader 断开按钮 → App.vue handleDisconnect（仅 connected 态可触发）→ IPC disconnect
main.disconnectDevice(rawSerial):
  restoreCancelled = true        ← 终止并抑制后台恢复任务（直到下次配对成功才复位）
  scrcpyService.stopForSerial    → appLoader.cancelForSerial → helper.releaseForSerial（持 forward 锁）
  adb.disconnect                 → idle 页面
```

之后不会有任何自发重连：自动连接已禁用 + 后台恢复已取消 + 空闲监听只对"新出现的 online 设备"
反应而不再有东西会上线。用户再次扫码 → pair 秒过（密钥互信）→ 显式连接 → home。

## 5. 超时护栏（新增 adb 命令必须带超时）

| 操作 | 超时 | 说明 |
|---|---|---|
| 常规命令（devices/shell/forward/mdns services…） | 10s | 防僵尸传输挂起 |
| `adb connect` | 15s | 失败可能退出码为 0，须检查 stdout `/connected to/i` |
| APK 安装 | 180s | 无线传输慢，单独放宽 |
| `isReachable` 探测 | 4s | 僵尸甄别专用 |
| pair 重试 | 每次 10s ×3 | protocol-fault 间隔 800ms×n 重试 |

超时错误信息包含具体命令（`adb 命令超时: ...`），是排查僵尸问题的第一线索。

## 6. IPC 契约速查

完整定义以 [`shared/ipcContract.js`](../shared/ipcContract.js) 为准，此处列连接相关：

| channel | 方向 | payload |
|---|---|---|
| `adb:pairDevice` | invoke | `(host, port, code)` → `serial`；编排配对+连接+装 Helper |
| `adb:restoreDevice` | invoke | `()` → `serial \| null`（60s 后台窗口，调用方不 await 其结果） |
| `adb:pairing-event` | event | `{ phase }`：pairing/paired/connecting/connected/installing/installed |
| `adb:startDiscovery` / `stopDiscovery` | invoke | boolean |
| `adb:discovered-target` | event | `string`（pairing 服务地址 `"ip:port"`） |
| `adb:devices-changed` | event | `AdbDevice[]`（含可选 `model`） |
| `adb:getDevices` | invoke | 先清理再返回快照 |
| `adb:disconnect` | invoke | `(serial)` → boolean |

## 7. 已知机型行为

- **MIUI/HyperOS**：每条新无线调试连接都要手机端确认，等待期间 transport 为 offline。
  这是"第二次连接提醒"现象的根源——任何自动化都只能让弹窗尽快出现，不能替用户按。
- **密钥同步竞态**：pair 返回成功后 adbd 才开始广播/就绪，首条自动连接几乎必失败。
  因此禁用自动连接、由应用在服务可见后显式 connect 是唯一稳定路径。

## 8. 开发守则（红线清单）

1. 关键路径**禁止用定时器推进流程**；成功信号只能是事件或命令 resolve。兜底 interval 仅用于
   触发主动 connect / 总护栏，不得作为"等结果"的手段。
2. **不要断开 offline 传输**（除非在 `pruneWirelessTransports` 启动清理路径中）。
3. 新增 adb 命令一律走 `exec/execWithTimeout`，禁止裸 `execFile`。
4. channel 字符串只允许出现在 `shared/ipcContract.js`、`electron/main.js`、`electron/preload.js`；
   渲染层一律 `src/services/desktopApi.js`。
5. `onceDeviceOnline` 的取消语义（`isStopped`）与 `restoreCancelled` 标志是成对的：
   改动一处必须检查另一处。
6. 改完行为必跑：`pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`，
   并更新本文档对应段落。

## 9. 真机回归清单

无线配对（含 MIUI 授权弹窗）→ 进 home → 断开后保持离线 ≥30s → 再扫码秒连 →
杀掉应用重启自动恢复 → 手机关屏期间断开不报错 → 多台手机在线时报冲突而非静默选择。
