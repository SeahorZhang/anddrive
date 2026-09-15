/**
 * @typedef {object} InstalledApp
 * @property {string} packageName
 * @property {string} label
 * @property {string | null} iconUrl
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
 * scrcpy 启动参数（渲染层与设置页共用；主进程会再次校验并回落默认值）。
 * @typedef {object} ScrcpyConfig
 * @property {string} newDisplay `--new-display` 值，`device` 原分辨率，`off` 不建虚拟显示
 * @property {string} bitRate 视频码率，如 `24M`
 * @property {number} maxFps 帧率上限
 * @property {string} videoCodec h264 | h265 | av1
 * @property {boolean} audio 是否转发音频
 * @property {string} screenMode keepActive | turnOff | normal
 * @property {boolean} alwaysOnTop 窗口置顶
 * @property {boolean} fullscreen 全屏启动
 */

/**
 * Domain payload the renderer submits to launch an app via scrcpy.
 * CLI arguments are constructed in the main process.
 * @typedef {object} ScrcpyRequest
 * @property {string} serial
 * @property {string} packageName
 * @property {string} label
 * @property {ScrcpyConfig} [config]
 * @property {string} [iconUrl] 应用图标（PNG data URL），用作镜像窗口图标
 */

/**
 * 主进程维护的运行中镜像会话快照。
 * @typedef {object} ScrcpySession
 * @property {string} id
 * @property {number | null} pid
 * @property {string} serial
 * @property {string} packageName
 * @property {string} label
 * @property {number} startedAt
 */

/**
 * 自研客户端镜像会话快照（无独立窗口 pid，窗口由主进程持有）。
 * @typedef {object} MirrorSession
 * @property {string} id
 * @property {string} serial
 * @property {string} packageName
 * @property {string} label
 * @property {number} startedAt
 * @property {number} codec
 * @property {string} codecName
 */

export {}
