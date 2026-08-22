/**
 * @typedef {object} DeviceInfo
 * @property {string} serial
 * @property {string} model
 * @property {string} deviceName
 * @property {number} battery
 * @property {boolean} isCharging
 * @property {string} storage
 * @property {number} storagePercent
 */

/**
 * @typedef {object} AdbDevice
 * @property {string} serial
 * @property {string} state
 */

/**
 * @typedef {object} InstalledApp
 * @property {string} packageName
 * @property {string} label
 * @property {string | null} iconUrl
 */

/**
 * 图标渐进加载阶段的增量更新（仅含包名与新图标）。
 * @typedef {object} IconUpdate
 * @property {string} packageName
 * @property {string} iconUrl
 */

/**
 * @typedef {InstalledApp & { iconUpdatedAt: number | null }} CachedInstalledApp
 */

/**
 * @typedef {object} AppCacheSnapshotInput
 * @property {number} authoritativeAt
 * @property {number} writtenAt
 * @property {CachedInstalledApp[]} apps
 */

/**
 * @typedef {AppCacheSnapshotInput & { version: number }} AppCacheSnapshot
 */

/**
 * @typedef {object} HelperCapabilities
 * @property {boolean=} ok
 * @property {number=} protocol
 * @property {boolean=} batchIcons
 */

/**
 * @typedef {'authoritative' | 'icons' | 'complete' | 'error'} AppLoadPhase
 */

/**
 * App 加载进度事件：
 * - authoritative：完整权威列表
 * - icons：图标增量更新（InstalledApp | IconUpdate）
 * - complete / error：无 apps 字段
 *
 * @typedef {object} AppLoadEvent
 * @property {number} loadId
 * @property {AppLoadPhase} phase
 * @property {(InstalledApp | IconUpdate)[]=} apps
 * @property {string=} message
 */

/**
 * 单设备选择结果：
 * - none：没有在线设备
 * - ok：恰好一台在线设备
 * - conflict：多台在线，禁止静默取第一台
 *
 * @typedef {{ status: 'none' }} AdbSelectionNone
 * @typedef {{ status: 'ok', device: AdbDevice }} AdbSelectionOk
 * @typedef {{ status: 'conflict', devices: AdbDevice[] }} AdbSelectionConflict
 * @typedef {AdbSelectionNone | AdbSelectionOk | AdbSelectionConflict} AdbSelection
 */

/**
 * 配对服务发现事件（mDNS up 即时推送，仅 adb-tls-pairing；
 * 连接阶段不依赖本机 Bonjour，设备上线信号走 adb:devices-changed）。
 * @typedef {string} DiscoveredPairingTarget
 */

/**
 * 配对编排进度事件（main 在 pairDevice 过程中即时推送）：
 * pairing → paired → connecting → connected → (installing → installed)。
 * 编排 promise 在 connected/installed 后以 serial resolve；任一步失败整体 reject。
 *
 * @typedef {'pairing' | 'paired' | 'connecting' | 'connected' | 'installing' | 'installed'} PairingPhase
 * @typedef {object} PairingEvent
 * @property {PairingPhase} phase
 */

/**
 * Renderer 提交的 scrcpy 启动请求（纯领域数据）。
 * CLI args、码率、窗口参数与资源路径由 main 侧构建，不属于本契约。

 * @typedef {object} ScrcpyLaunchInput
 * @property {string} serial
 * @property {string} packageName
 * @property {string} label
 * @property {string} iconDataUrl
 */

export {}
