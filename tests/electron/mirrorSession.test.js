import { describe, expect, it, vi } from 'vitest'
import { CHANNELS } from '../../electron/ipcContract.js'

// 镜像会话的「启动参数」是主进程 → 镜像页唯一的传话通道：图标、窗口 CSS 尺寸都得在这里带上，
// 否则镜像页只能自己去读整台设备的图标缓存（为取一个图标花一整轮 IO，而 .adr 冷启动时缓存还没建）。
// 这里只验这一层契约：`mirror:initGet` 回给页面的字段。

const env = vi.hoisted(() => {
  /** @type {any[]} */
  const windows = []
  /** @type {Map<string, Function>} */
  const handlers = new Map()

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options
      this.webContents = {}
      windows.push(this)
    }
    once() {}
    on() {}
    show() {}
    focus() {}
    close() {}
    isDestroyed() {
      return false
    }
    isMinimized() {
      return false
    }
    loadURL() {
      return Promise.resolve()
    }
    loadFile() {
      return Promise.resolve()
    }
    // macOS 标题栏占掉的那几十 px：内容区比窗口小，正是页面要的那个 CSS 尺寸。
    getContentBounds() {
      return { width: this.options.width, height: this.options.height - 28 }
    }
  }
  FakeBrowserWindow.getAllWindows = () => windows
  FakeBrowserWindow.fromWebContents = (wc) => windows.find((w) => w.webContents === wc) ?? null

  return {
    windows,
    handlers,
    FakeBrowserWindow,
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => handlers.set(channel, fn),
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
    app: { getPath: () => '' },
  }
})

vi.mock('electron', () => ({
  BrowserWindow: env.FakeBrowserWindow,
  ipcMain: env.ipcMain,
  screen: env.screen,
  app: env.app,
}))

// adb 那一层不碰真设备：会话建立要的服务端路径与设备分辨率都给固定值。
vi.mock('../../electron/adb.js', () => ({
  ensureServer: async () => {},
  scrcpyServerPath: () => '/tmp/scrcpy-server',
  getPhysicalScreenSize: async () => ({ width: 1200, height: 2608 }),
  onDeviceTeardown: () => {},
}))

// 镜像页的 preload 路径按 APP_ROOT 拼，测试里只要求它是个字符串。
process.env.APP_ROOT = '/tmp/anddrive-test'

const { startMirrorSession } = await import('../../electron/mirror/session.js')

/** 页面拉启动参数：`mirror:initGet` 按 sender 找到它所属的那个会话窗口。 */
const initFrom = (win) => env.handlers.get(CHANNELS.mirrorInitGet)({ sender: win.webContents })

describe('mirror session 启动参数', () => {
  it('把 request 里的图标原样带进 pendingInit', async () => {
    const iconUrl = 'data:image/png;base64,aGVsbG8='
    await startMirrorSession({
      serial: 'dev-icon',
      packageName: 'com.example.app',
      label: '示例',
      iconUrl,
    })
    const win = env.windows.at(-1)
    const init = initFrom(win)
    expect(init.iconUrl).toBe(iconUrl)
    expect(init.label).toBe('示例')
    expect(init.serverPath).toBe('/tmp/scrcpy-server')
    // 虚拟显示的初始 CSS 来自窗口内容区，不等页面布局。
    expect(init.initialCss).toEqual({
      width: win.getContentBounds().width,
      height: win.getContentBounds().height,
    })
  })

  it('非法图标不往渲染层塞（页面会把它当图片 src）', async () => {
    await startMirrorSession({
      serial: 'dev-bad-icon',
      packageName: 'com.example.app',
      iconUrl: 'javascript:alert(1)',
    })
    expect(initFrom(env.windows.at(-1)).iconUrl).toBeUndefined()
  })

  it('唤起 URL 没有图标时字段为 undefined，镜像页退化成首字母', async () => {
    await startMirrorSession({ serial: 'dev-no-icon', packageName: 'com.example.app' })
    const init = initFrom(env.windows.at(-1))
    expect(init.iconUrl).toBeUndefined()
    expect(init.label).toBe('com.example.app')
  })
})
