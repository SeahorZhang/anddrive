# 手机连接流程

## 概述

AndDrive 使用 ADB (Android Debug Bridge) 通过 WiFi 与 Android 设备建立连接。整个流程基于 Android 11+ 的无线调试功能，采用 mDNS 服务发现 + QR 码配对的方式实现自动化连接。

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                    Vue 渲染进程                          │
│                                                         │
│  AddDeviceDialog.vue                                    │
│    └─ usePairing.js (配对业务逻辑)                       │
│        └─ useAdb.js (IPC 薄封装)                        │
└───────────────────────┬─────────────────────────────────┘
                        │ IPC (invoke/handle)
┌───────────────────────┴─────────────────────────────────┐
│                  Electron 主进程                         │
│                                                         │
│  main.js (IPC handlers)                                 │
│    └─ adb.js                                            │
│        ├─ bonjour-service (mDNS 服务发现)                │
│        └─ child_process (执行 adb pair 命令)             │
│                                                         │
│  resources/adb/                                         │
│    ├─ mac/adb      (macOS)                              │
│    ├─ win/adb.exe  (Windows)                            │
│    └─ linux/adb    (Linux)                              │
└─────────────────────────────────────────────────────────┘
```

## 连接流程

### 1. 用户触发

用户点击"添加设备"按钮，打开配对对话框。

```
App.vue: @open="deviceDialogVisible = true"
    ↓
AddDeviceDialog.vue: watch(modelValue) → start()
```

### 2. 生成 QR 码

`usePairing.js` 生成随机配对信息并编码为 QR 码：

```javascript
// 生成 6 位随机密码
password = randCode()  // 例如: "483921"

// 生成随机 SSID
ssid = `d${randCode()}`  // 例如: "d621847"

// 编码为 WiFi ADB 格式
qrContent = `WIFI:T:ADB;S:${ssid};P:${password};;`
// 例如: WIFI:T:ADB;S:d621847;P:483921;;
```

QR 码格式说明：
| 字段 | 含义 | 示例 |
|------|------|------|
| `T` | 类型 | `ADB` (固定) |
| `S` | SSID (标识符) | `d` + 6位随机数字 |
| `P` | 配对密码 | 6位随机数字 |

### 3. 启动 mDNS 发现

`adb.js` 启动 mDNS 服务发现，监听 `_adb-tls-pairing._tcp.local.` 服务：

```javascript
// electron/adb.js
bonjour = new Bonjour()
browser = bonjour.find({ type: "adb-tls-pairing" }, (service) => {
  const ip = service.addresses?.find(a => !a.includes(":") && a !== "127.0.0.1")
  if (ip) {
    discovered.set(`${ip}:${service.port}`, { name: service.name, address: `${ip}:${service.port}` })
  }
})
```

### 4. 手机扫码

用户在 Android 手机上：
1. 打开 **设置** → **开发者选项**
2. 开启 **无线调试**
3. 点击 **使用配对码配对设备**
4. 选择 **扫描二维码**
5. 扫描电脑上显示的二维码

手机扫码后会：
- 解析 QR 码中的密码和 SSID
- 启动 ADB 配对服务
- 通过 mDNS 广播 `_adb-tls-pairing._tcp.local.` 服务

### 5. 设备发现与自动配对

`usePairing.js` 每秒轮询一次已发现的设备：

```javascript
pollTimer = setInterval(async () => {
  const devices = await getDiscoveredDevices()
  if (devices.length > 0) {
    clearInterval(pollTimer)
    await doPair(devices[0].address)
  }
}, 1000)
```

发现设备后自动执行配对：

```javascript
const doPair = async (address) => {
  const [host, port] = address.split(':')
  await pair(host, port, password)  // 执行 adb pair <host>:<port> <password>
}
```

### 6. 执行 ADB 配对命令

`adb.js` 执行 `adb pair` 命令：

```javascript
// electron/adb.js
export function pair(host, port, code) {
  return ensureServer().then(() => new Promise((resolve, reject) => {
    execFile(getAdbPath(), ["pair", `${host}:${port}`, code], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout.trim())
    })
  }))
}
```

### 7. 配对完成

配对成功后：
- 显示"配对成功！"状态
- 1.5 秒后自动关闭对话框
- 清理 mDNS 发现和轮询定时器

## 文件结构

```
anddrive_next/
├── electron/
│   ├── adb.js              # ADB 核心逻辑 (mDNS 发现 + 配对命令)
│   ├── main.js             # Electron 主进程 (IPC handlers)
│   └── preload.js          # 暴露 ADB API 到渲染进程
├── src/
│   ├── composables/
│   │   ├── useAdb.js       # ADB IPC 薄封装
│   │   └── usePairing.js   # 配对业务逻辑
│   └── components/
│       └── AddDeviceDialog.vue  # 配对对话框 UI
├── resources/
│   └── adb/                # 内置 ADB 二进制文件
│       ├── mac/adb
│       ├── win/adb.exe
│       └── linux/adb
└── scripts/
    └── download-adb.sh     # 下载 ADB 二进制文件脚本
```

## 依赖说明

| 依赖 | 用途 |
|------|------|
| `bonjour-service` | mDNS 服务发现，用于发现 Android 设备的配对服务 |
| `uqr` | QR 码生成，将配对信息编码为二维码 |

## 状态流转

```
idle → waiting → pairing → success
                    ↓
                  error
```

| 状态 | 说明 |
|------|------|
| `idle` | 初始状态，未开始配对 |
| `waiting` | 已生成 QR 码，等待设备扫码 |
| `pairing` | 已发现设备，正在执行配对 |
| `success` | 配对成功 |
| `error` | 配对失败 |

## 故障排查

### 1. 无法发现设备

- 确保手机和电脑在同一局域网
- 确保手机已开启无线调试
- 检查防火墙是否阻止 mDNS 流量 (端口 5353/UDP)

### 2. 配对失败

- 确保手机已升级至 Android 11+
- 确保手机已开启 USB 调试
- 尝试重启 ADB 服务器：`adb kill-server && adb start-server`

### 3. ADB 二进制文件问题

重新下载 ADB 二进制文件：

```bash
pnpm download-adb
```

## 更新 ADB 版本

```bash
pnpm download-adb
```

此命令会下载最新版本的 ADB 二进制文件到 `resources/adb/` 目录。
