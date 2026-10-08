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
  /** adb 层注册进来的设备清理钩子 */
  const teardownHooks = []

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options
      this.webContents = {}
      this.listeners = {}
      this.fullscreenCalls = []
      windows.push(this)
    }
    once(event, fn) {
      ;(this.listeners[event] ??= []).push(fn)
    }
    on(event, fn) {
      ;(this.listeners[event] ??= []).push(fn)
    }
    /** 测试用来把窗口推到「ready-to-show」那一步。 */
    fire(event) {
      for (const fn of this.listeners[event] ?? []) fn()
    }
    show() {
      this.shown = true
    }
    setFullScreen(value) {
      this.fullscreenCalls.push(value)
    }
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
    teardownHooks,
    FakeBrowserWindow,
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => handlers.set(channel, fn),
    },
    screen: {
      // 主进程建窗口前读这块屏的可用区，把窗口按设备画面比例开。
      getPrimaryDisplay: () => ({
        workAreaSize: { width: 1440, height: 900 },
        workArea: { width: 1440, height: 900 },
      }),
    },
    app: { getPath: () => '' },
  }
})

vi.mock('electron', () => ({
  BrowserWindow: env.FakeBrowserWindow,
  ipcMain: env.ipcMain,
  screen: env.screen,
  app: env.app,
}))

// adb 那一层不碰真设备：会话建立要的服务端路径与设备分辨率都给固定值；
// 机型判定固定回「非 MIUI」，协同投屏那条分支由 miProjection 自己的单测覆盖。
vi.mock('../../electron/adb.js', () => ({
  ensureServer: async () => {},
  scrcpyServerPath: () => '/tmp/scrcpy-server',
  // 设备物理分辨率：默认按 1200x2608 回；serial 带 `unknown` 的模拟 `wm size` 读不到（回 null）。
  getPhysicalScreenSize: async (serial) =>
    String(serial ?? '').includes('unknown') ? null : { width: 1200, height: 2608 },
  // 设备物理密度：flex 显示必须带密度，缺它渲染层就不给显示尺寸。
  getPhysicalScreenDensity: async (serial) =>
    String(serial ?? '').includes('unknown') ? null : 440,
  onDeviceTeardown: (hook) => {
    env.teardownHooks.push(hook)
    return () => {
      const i = env.teardownHooks.indexOf(hook)
      if (i >= 0) env.teardownHooks.splice(i, 1)
    }
  },
  isMiuiDevice: async () => false,
  getDeviceVideoCodecs: async () => ({ h264: true, h265: true, av1: false }),
  setSecureSetting: async () => {},
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

  /** 「镜像手机」= 不带包名的会话，判据在这里定一次再随 pendingInit 下发（渲染层不再自己猜）。 */
  it('空包名 = 整机镜像：deviceMirror 为真，label 退「手机镜像」', async () => {
    await startMirrorSession({ serial: 'dev-device-mirror', packageName: '' })
    const init = initFrom(env.windows.at(-1))
    expect(init.packageName).toBe('')
    expect(init.deviceMirror).toBe(true)
    expect(init.label).toBe('手机镜像')
    // 单应用会话这一项必须是假，否则渲染层会跳过 startApp，窗口只剩启动器。
    await startMirrorSession({ serial: 'dev-app-mirror', packageName: 'com.example.app' })
    expect(initFrom(env.windows.at(-1)).deviceMirror).toBe(false)
    // 放开空包名不能顺手放开非法包名。
    await expect(startMirrorSession({ serial: 'dev-bad', packageName: 'com.a; rm -rf /' })).rejects.toThrow(
      /应用包名无效/,
    )
  })

  it('包名只是空白也算整机镜像（trim 之后判空）', async () => {
    await startMirrorSession({ serial: 'dev-blank', packageName: '   ' })
    expect(initFrom(env.windows.at(-1)).deviceMirror).toBe(true)
  })
})

// 默认模式的虚拟显示尺寸取自「窗口画面区的物理像素」，所以窗口形状必须在建之前就对：
// 横窗会开出一块横显示，竖屏 app 立刻换版式（`mirrorWindowBounds` 照设备画面比例 fit 可用区）。
describe('镜像窗口照设备画面比例开', () => {
  it('竖屏手机 → 等比竖窗，并把设备分辨率透传给镜像页（它据此决定给不给显示尺寸）', async () => {
    await startMirrorSession({ serial: 'dev-shape', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    // adb mock 回 1200x2608；可用区 1440x900 减 80 边距 = 1360x820 → 高顶满 820，宽按比 377。
    expect({ width: win.options.width, height: win.options.height }).toEqual({
      width: 377,
      height: 820,
    })
    expect(initFrom(win).screenSize).toEqual({ width: 1200, height: 2608 })
    expect(initFrom(win).screenDpi).toBe(440)
  })

  it('读不到设备分辨率时退回 850x600，并把 screenSize=null 带给镜像页', async () => {
    await startMirrorSession({ serial: 'dev-shape-unknown', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    expect({ width: win.options.width, height: win.options.height }).toEqual({
      width: 850,
      height: 600,
    })
    expect(initFrom(win).screenSize).toBeNull()
    expect(initFrom(win).screenDpi).toBeNull()
  })
})


// 「全屏启动」必须落在 show 之后：macOS 上构造参数 `fullscreen:true` + `show:false` 常常
// 进不去全屏，而显式传 `fullscreen:false` 又会把绿色按钮打成 zoom。两头都是踩过的。
describe('镜像窗口的全屏启动', () => {
  const open = async (serial, config) => {
    await startMirrorSession({ serial, packageName: 'com.example.app', config })
    return env.windows.at(-1)
  }

  it('开着时：先 show，再 setFullScreen(true)', async () => {
    const win = await open('dev-fs-on', { fullscreen: true })
    // 构造参数里不该再有 `fullscreen`（否则又退回那条在 macOS 上不可靠的路径）。
    expect('fullscreen' in win.options).toBe(false)
    expect(win.options.fullscreenable).toBe(true)
    win.fire('ready-to-show')
    expect(win.shown).toBe(true)
    expect(win.fullscreenCalls).toEqual([true])
  })

  it('关着时：只 show，不碰全屏', async () => {
    const win = await open('dev-fs-off', { fullscreen: false })
    win.fire('ready-to-show')
    expect(win.shown).toBe(true)
    expect(win.fullscreenCalls).toEqual([])
  })

  it('没配置时默认关：不碰全屏', async () => {
    const win = await open('dev-fs-default', undefined)
    win.fire('ready-to-show')
    expect(win.fullscreenCalls).toEqual([])
  })
})

// 切换设备不该把已经开着的镜像关掉：主进程的 release 带 keepMirror，
// 会话的清理钩子见到它就原样返回。
describe('设备清理与已开镜像', () => {
  const runTeardown = (serial, options) =>
    Promise.all(env.teardownHooks.map((hook) => hook(serial, options)));

  it('keepMirror 时不动这台设备的会话，断开时才关', async () => {
    await startMirrorSession({
      serial: 'dev-switch',
      packageName: 'com.example.app',
      label: '示例',
    })
    const win = env.windows.at(-1)
    const closeSpy = vi.spyOn(win, 'close')
    expect(env.teardownHooks.length).toBeGreaterThan(0)

    await runTeardown('dev-switch', { keepMirror: true })
    expect(closeSpy).not.toHaveBeenCalled()

    // 会话还活着：同一台再开一次会拿到新窗口，说明上一条没被清掉
    await runTeardown('dev-switch')
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('清理只动这台设备的会话，别台投着的不接', async () => {
    await startMirrorSession({ serial: 'dev-a', packageName: 'com.example.app' })
    const closeA = vi.spyOn(env.windows.at(-1), 'close')
    await startMirrorSession({ serial: 'dev-b', packageName: 'com.example.app' })
    const closeB = vi.spyOn(env.windows.at(-1), 'close')

    await runTeardown('dev-a')
    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).not.toHaveBeenCalled()
  })
})
