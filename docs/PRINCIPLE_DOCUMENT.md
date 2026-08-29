# andrive_next 原理文档

## 项目概述

andrive_next 是一个基于 Vue 3 + Electron 的无线 ADB 设备管理工具。其核心目标是通过 mDNS 发现和配对实现电脑与 Android 设备的无线 ADB 连接，并提供应用列表浏览、安装Helper、应用启动等功能。

---

## 架构概览

```text
+---------------------+       +---------------------+
|   Renderer (Vue 3)  | <---->|   Electron Main     |
|   (src/)            | IPC   |   Process (electron/)|
+---------------------+       +---------------------+
        |                           |
        |   electronAPI (preload)   |
        +---------------------------+
```

---

## 核心模块详解

### 1. IPC 通信契约

所有跨进程通信通过 `electron/ipcContract.js` 中定义的统一通道名称进行：

**ADB相关通道:**
- `adb:connect` - 连接到设备地址
- `adb:pair` - 配对设备（携带 host/port/code）
- `adb:startPairingDiscovery` - 启动配对发现（mDNS 扫描 adb-tls-pairing）
- `adb:stopPairingDiscovery` - 停止配对发现
- `adb:startConnectDiscovery` - 启动连接端口发现（mDNS 扫描 adb-tls-connect）
- `adb:stopConnectDiscovery` - 停止连接发现
- `adb:disconnect` - 断开设备连接
- `adb:getDeviceInfo` - 获取设备信息
- `adb:getDevices` - 列出所有 ADB 设备
- `adb:saveDevice` - 保存设备信息
- `adb:loadInstalledApps` - 加载已安装应用列表
- `adb:getAppIcons` - 获取应用图标
- `adb:deleteAppCache` - 清除应用缓存
- `adb:installHelper` / `adb:uninstallHelper` - Helper app 管理

**Scrcpy相关通道:**
- `start_scrcpy` - 启动 scrcpy 投屏

---

### 2. ADB 客户端

`electron/adb/adbClient.js` - ADB 协议的直接封装：

- `ensureServer()` - 确保 ADB 服务器已启动（单例模式）
- `adbExec()` - 基础 ADB 命令执行
- `adbExecSafe()` - 永不 reject 的版本，返回 `{code, stdout, stderr}`
- `pair(host, port, code)` - 配对设备
- `connectDevice(address)` - 连接无线 ADB（验证输出包含 "connected to"）
- `listDevices()` - 列出设备（过滤 state='device'}
- `getDeviceInfo(serial)` - 获取设备型号/品牌/市场名
- `disconnectTransport(serial)` - 断开传输

**关键设计决策:**
- `connectDevice` 根据输出文本判断成功而非 exit code，因为 adb 即使连接失败也可能返回 exit code 0
- `ensureServer` 使用标志位防止重复启动

---

### 3. 发现服务 (Bonjour/mDNS)

`electron/adb/discoveryService.js` - 使用 `bonjour-service` 通过 mDNS 发现服务：

**配对发现:**
- 服务类型: `adb-tls-pairing`
- 流程: 发现服务 → 显示二维码 → 用户扫码配对 → 建立 TLS 连接
- 事件: `adb:onPairingDevice` 返回 `{name, address, ip, port, service}`

**连接发现:**
- 服务类型: `adb-tls-connect`
- 流程: 配对后发现连接端点 → `adb connect` → 建立连接
- 用于已配对设备的快速重连

**关键函数:**
- `startPairingDiscovery(onDevice)` - 启动配对服务发现，通过回调返回发现的设备
- `startConnectDiscovery(onDevice)` - 启动连接端点发现
- `resolveConnectAddress(serial, options)` - 根据 serial 的 guid 解析当前 connect 地址，轮询最多 6 秒
- `stopDiscovery()` - 停止所有发现，销毁 bonjour 实例

**Bonjour 服务发现机制:**
- 监听局域网中的 mDNS 服务
- 提取 IP（过滤掉 127.0.0.1 和端口信息）
- 通过服务名称中的 guid 匹配设备

---

### 4. 配对流程

`src/composables/usePairing.js` - 完整的配对流程 orchestration：

```text
startPairing()
  ↓
生成随机 SSID 和密码
  ↓
渲染 WiFi 配置二维码 (uqr + base64 SVG)
  ↓
status = "waiting" / "等待设备扫码..."
  ↓
adb.startPairingDiscovery() - 监听 adb-tls-pairing 服务
  ↓
回调中: status = "pairing" → doPair(device)
  ↓
adb.pair(device.ip, device.port, password) - 发送配对请求
  ↓
成功后: 状态消息 "配对成功！"
  ↓
discoverAndConnect()
  ↓
adb.startConnectDiscovery() - 监听 adb-tls-connect 服务
  ↓
获取连接端点地址
  ↓
adb.connect(address) - 建立连接
  ↓
status = "success" / "连接成功！"
```

**状态机:**
- `idle` - 闲置
- `waiting` - 等待扫码
- `pairing` - 配对中
- `connecting` - 连接中
- `success` - 成功
- `error` - 错误

**保存设备信息**（注释掉的):
- 配对成功后尝试获取设备信息并保存到本地缓存
- 失败不影响配对流程

---

### 5. 应用列表与图标缓存

`src/components/home/AppList.vue` - 应用网格列表实现：

**两阶段加载策略:**

1. **第一阶段 - 快速获取（无图标）:**
   - `adb.loadInstalledApps(serial)` - 获取所有应用的包名和标签
   - 速度快，无需加载图标

2. **第二阶段 - 批量图标补齐:**
   - 过滤出需要图标的应用 (`needsIcon` - 7 天缓存失效)
   - 按每组 20 个图标，3 路并发批次 补齐
   - `adb.getAppIcons(serial, group)` - 获取一批图标
   - `patchIcons()` - 合并到本地列表

**图标缓存机制:**
- 有效期: 7 天 (`ICON_REFRESH_MS = 7 * 24 * 60 * 60 * 1000`)
- 过期或缺失才重新获取
- 合并时保留现有 iconUrl（先获取的保留）

**批处理配置:**
- `ICON_BATCH_SIZE = 20` - 每批请求数量
- `ICON_BATCH_CONCURRENCY = 3` - 同时进行的批次数

**应用操作:**
- `installHelper()` - 安装 Helper APK 到手机
- `uninstallHelper()` - 从手机卸载 Helper
- `clearCache()` - 清除应用缓存并重新加载

---

### 6. 应用启动流程

`src/composables/useAppLauncher.js` - 管理应用启动（scrcpy）流程：

**核心概念:**
- **MRU (Most Recently Used)** - 最近最久未使用排序，生存期在会话内存活
- **pendingIconLaunches** - 等待图标的挂起 launches
- **launchingPackages** - 正在进行的 launches
- **launchErrors** -  launch 错误记录

**launch 流程:**
1. 检查是否已 launch 或 pending
2. 如果有 iconUrl → 直接 launch
3. 如果有 iconComplete → 显示错误 "无法加载应用图标"
4. 否则 → 设为 pending，等待 icon 加载
5. icon 加载完成后 → 触发 deferred launch

**watch 机制:**
- `apps` 变化 → 完成的 pending launches 立即 launch
- `iconComplete` 变化 → 没有完成的 pending 设为错误

**reset()** - 切换设备时清空所有 transient 状态

**orderApps()** (`src/composables/appOrdering.js`) - 按 MRU 排序:
- MRU packages 首位（按 recency 顺序）
- 剩余应用保持原始顺序
- 去重（最后出现的保留）

---

### 7. 设备会话管理

`shared/deviceSession.js` - 单设备会话规则：

**会话状态:**
- `empty` - 无在线设备
- `connected` - 唯一一台在线设备
- `conflict` - 多台在线设备（冲突，不得静默降级）

**resolveSession(devices):**
- 过滤 state='device' 的设备
- 0 台 → empty
- 1 台 → connected，携带 serial
- 2+ 台 → conflict，列出所有 serial

**核心原则:** 多台在线设备永不 silently 降级，必须用户明确选择。

---

### 8. 页面流与状态

`src/App.vue` - 主页面调度：

**pageType 状态机:**
- `loading` - 初始/连接中状态
- `home` - 主页（已连接设备）
- `addDevice` - 添加设备页面（未连接或出错）

**连接流程:**
1. 初始化时预设 device 信息（示例值）
2. `adbConnect(device.serial, device.address)` - 连接无线 ADB
3. 成功 → pageType = 'home'
4. 失败 → pageType = 'addDevice'

**首页结构:**
- 设备信息展示（设备名、序列号）
- AppList - 应用网格
- 操作按钮：安装 Helper、卸载 Helper、清除缓存

**添加设备流程:**
- `PageHeader` - 顶部工具栏，包含断开连接确认对话框
- `AddDevice` - "添加设备" 按钮
- `AddDeviceDialog` - 二维码配对对话框
- 配对成功后恢复到 home 页

---

### 9. 图标自定义

`src/icons.js` - 自定义 Iconify 图标加载：

- 定义局部图标: `smartphone`, `chevron-down`, `plus`, `unplug`, `trash-2`, `download`, `eraser`
- 设置自定义加载器，优先使用定义的图标，否则回落到 lucide
- 用于应用图标显示时的 fallback

---

### 10. 样式与布局

`src/styles/index.css` - Tailwind CSS v4 配置，使用 `@tailwind/vite` 插件。

**关键 UI 模式:**
- `-webkit-app-region: drag` - 标题栏拖拽区域
- `-webkit-app-region: no-drag` - 内容区域（禁止拖拽）
- 浮动对话框、网格布局、搜索输入、分批图标加载

---

## 数据流向总结

```text
User Action
    ↓
Vue Component (template)
    ↓
Composable (usePairing / useAppLauncher / useDeviceInfo)
    ↓
IPC invoke → electronMain handler
    ↓
ADB command / Bonjour discovery / scrcpy process
    ↓
Response → Store / State update
    ↓
Renderer re-render
```

---

## 关键设计原则

1. **单一数据源**: IPC 通道是主进程与渲染进程的唯一通信入口
2. **容错优先**: 配对失败不影响流程中断，设备信息保存失败不影响配对
3. **缓存友好**: 图标缓存 7 天，避免重复请求；分批并发提升效率
4. **会话安全**: 多设备冲突时明确告知，而非静默选择第一台
5. **渐进增强**: 应用列表先加载名称，后加载图标；启动应用先尝试有图标，无图标则等待或错误提示
6. **资源管理**: ADB 服务器单例、scrcpy 进程生命周期绑定、发现服务自动清理