/**
 * @typedef {object} InstalledApp
 * @property {string} packageName
 * @property {string} label
 * @property {string | null} iconUrl
 */

/**
 * @typedef {InstalledApp & { iconUpdatedAt: number | null }} CachedInstalledApp
 *   `iconUrl` / `iconUpdatedAt` 是**给渲染层的返回值**字段：图标本体存在 `icons-v1/` 的
 *   png 文件里、时间取其 mtime，由主进程读侧补齐；落盘的快照里恒为 null。
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
 * @property {string} bitRate 视频码率，如 `24M`
 * @property {number} maxFps 帧率上限
 * @property {string} videoCodec auto | h264 | h265 | av1 | vp8 | vp9（auto 在建立会话时按能力表落地）
 * @property {boolean} audio 是否转发音频
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

export {}
