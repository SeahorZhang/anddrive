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
      this.webContents = {
        /** 主进程推给页面的事件轨迹（`[channel, payload]`），用来验全屏那一条有没有落地。 */
        sent: [],
        send: (channel, payload) => this.webContents.sent.push([channel, payload]),
      }
      this.listeners = {}
      this.fullscreenCalls = []
      /** `maximize()` 的调用次数（满屏 = zoom 撑满，不再是 macOS 全屏）。 */
      this.maximizeCalls = 0
      /** `setWindowButtonVisibility` 收到过的值。红绿灯已归系统（10-11），这里只用来证明"一次都没调"。 */
      this.buttonCalls = []
      /** `setWindowButtonPosition` 收到过的落点。同上：谁再去挪三颗，这里就留痕。 */
      this.buttonPositionCalls = []
      /** 红绿灯两类调用的**先后**轨迹：放出来之后必须紧跟一次设位（见 session.js 那条实测）。 */
      this.lightTrace = []
      /** `setContentSize` 收到过的尺寸（dev 调试边栏撑宽/收宽窗口的轨迹）。 */
      this.sizeCalls = []
      /** `setAspectRatio` 收到过的 `[比例, 不参与比例的余量]`（拖拽只能按手机比例）。 */
      this.aspectCalls = []
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
    maximize() {
      this.maximizeCalls += 1
    }
    /** 真全屏时 dev 调试边栏不撑宽窗口（守卫读的就是这个）。 */
    isMaximized() {
      return this.maximized === true
    }
    /** macOS 红绿灯：记录调用。10-11 起我们一个都不该调（见「红绿灯零定制」）。 */
    setWindowButtonVisibility(value) {
      this.buttonCalls.push(value)
      this.lightTrace.push({ kind: 'visibility', value })
    }
    /** macOS 红绿灯只能整组平移（间距/大小动不了）—— 现在压根不平移。 */
    setWindowButtonPosition(position) {
      this.buttonPositionCalls.push(position)
      this.lightTrace.push({ kind: 'position', value: position })
    }
    /** dev 调试边栏撑宽/收宽窗口（`mirror:windowHud`）的调用轨迹。 */
    setContentSize(width, height) {
      this.sizeCalls.push([width, height])
      this.options.width = width
      this.options.height = height
    }
    /** 拖拽锁比例（= AppKit 的 `contentAspectRatio`）：记 `[比例, 余量]` 两件事。 */
    setAspectRatio(ratio, extraSize) {
      this.aspectCalls.push([ratio, extraSize])
    }
    getContentSize() {
      return [this.options.width, this.options.height - 28]
    }
    isFullScreen() {
      return this.fullscreen === true
    }
    focus() {}
    minimize() {
      this.minimized = true
    }
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
    /** `scrcpyServerPath` 收到过的 config 参数（选哪份 server 产物就靠它）。 */
    serverPathArgs: [],
    /** keepAwake 对设备设置的读写轨迹，与「设备当前值」。 */
    settingReads: [],
    settingWrites: [],
    stayOn: {},
    /** 关会话时回过桌面的设备（`goHome` 的调用序列号）。 */
    homeCalls: [],
    /** 设备 secure 设置（Mac 键盘要抢要还的那一格）与设备 shell 调用轨迹。 */
    secure: { default_input_method: 'com.sohu.inputmethod.sogou.xiaomi/.SogouIME' },
    shellCalls: [],
    /** 「桌面模式」要读的手机前台应用（null = 手机停在桌面）。 */
    foregroundApp: 'com.example.fg',
    /** 本机那份应用缓存（`getCachedApps`）：新窗口的名称与图标从这里取，不碰设备。 */
    cachedApps: [],
    /** `/data/local/tmp/` 里那份「用户原输入法」备份文件的内容（`echo`/`rm -f` 会改它）。 */
    stash: '',
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
  scrcpyServerPath: (...args) => {
    env.serverPathArgs.push(args[0])
    return '/tmp/scrcpy-server'
  },
  // 设备物理分辨率：默认按 1200x2608 回；serial 带 `unknown` 的模拟 `wm size` 读不到（回 null）。
  getPhysicalScreenSize: async (serial) =>
    String(serial ?? '').includes('unknown') ? null : { width: 1200, height: 2608 },
  // 设备物理密度：flex 显示必须带密度，缺它渲染层就不给显示尺寸。
  getPhysicalScreenDensity: async (serial) =>
    String(serial ?? '').includes('unknown') ? null : 440,
  // 设备展示名（标题栏那行「app - 设备名」用）：serial 带 `dev-xxx` 时回一个固定名，其余读不到。
  deviceDisplayName: async (serial) => (String(serial ?? '').includes('named') ? 'Mi 10' : null),
  // 设备 API 级别：serial 里带 `sdk<数字>` 的按那个数字回，其余模拟读不到（null）。
  getDeviceSdk: async (serial) => {
    const match = /sdk(\d+)/.exec(String(serial ?? ''))
    return match ? Number(match[1]) : null
  },
  // 「插电不休眠」这个设备设置：keepAwake 开之前读原值、最后一个会话关掉时写回。
  getGlobalNumberSetting: async (_serial, key) => {
    env.settingReads.push(key)
    return env.stayOn[key] ?? 0
  },
  setGlobalNumberSetting: async (_serial, key, value) => {
    env.settingWrites.push([key, value])
    env.stayOn[key] = value
    return true
  },
  getPowerState: async () => ({ wakefulness: 'Awake', screen: 'ON' }),
  wakeDevice: async () => true,
  goHome: async (serial) => {
    env.homeCalls.push(serial)
    return true
  },
  onDeviceTeardown: (hook) => {
    env.teardownHooks.push(hook)
    return () => {
      const i = env.teardownHooks.indexOf(hook)
      if (i >= 0) env.teardownHooks.splice(i, 1)
    }
  },
  isMiuiDevice: async () => false,
  getDeviceVideoCodecs: async () => ({ h264: true, h265: true, av1: false }),
  // 「桌面模式」：手机主屏上正在用的应用，以及本机那份应用缓存（新窗口的名称/图标从它取）。
  getForegroundApp: async () => env.foregroundApp,
  getCachedApps: async () => env.cachedApps,
  setSecureSetting: async (_serial, key, value) => {
    env.secure[key] = value
    env.settingWrites.push(['secure', key, value])
    return { code: 0, stdout: '', stderr: '' }
  },
  // Mac 键盘那三条设备操作：读 secure 设置、跑我们拼好的 shell（`ime enable` 与那份 stash 文件）。
  getSecureSetting: async (_serial, key) => env.secure[key] ?? null,
  runDeviceShell: async (_serial, command) => {
    env.shellCalls.push(command)
    if (command.startsWith('cat ')) return { ok: true, stdout: env.stash }
    const echo = /^echo (\S+) > \S+$/.exec(command)
    if (echo) env.stash = echo[1]
    if (command.startsWith('rm -f')) env.stash = ''
    return { ok: true, stdout: '' }
  },
}))

// 镜像页的 preload 路径按 APP_ROOT 拼，测试里只要求它是个字符串。
process.env.APP_ROOT = '/tmp/anddrive-test'

const { startMirrorSession, stopMirrorSession } = await import('../../electron/mirror/session.js')
// 黑框与长条那几档数只有一个出处；窗口尺寸、`initialCss`、红绿灯落点都由它推出来，
// 测试按同一份数算期望（改了 `options.js` 而这里没跟着红，说明断言写死了数、没钉住关系）。
const { mirrorScreenInsets, mirrorContentExtraSize, mirrorTrafficLightPosition, MIRROR_TITLEBAR } = await import(
  '../../electron/mirror/options.js'
)
const { MAC_KEYBOARD_IME } = await import('../../electron/mirror/macKeyboard.js')

/** `keepAwake` 是在会话返回后异步落地的（置位不能拖慢开窗口），测试里把微任务跑干净。 */
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

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
    // 虚拟显示的初始 CSS 来自**画面那块矩形**（内容区减掉外扩那一圈），不等页面布局。
    const insets = mirrorScreenInsets()
    expect(init.initialCss).toEqual({
      width: win.getContentBounds().width - insets.left - insets.right,
      height: win.getContentBounds().height - insets.top - insets.bottom,
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
    // 单应用会话（读不到版本 = 按 14+ 处理）这一项必须是假，否则渲染层跳过「接回画面」那条归属逻辑。
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

// Android 13（API 33）及以下的设备不建虚拟显示：点应用 = 在手机屏幕上打开它 + 镜像这块屏。
// 分流必须在主进程定一次（渲染层只认 `deviceMirror` 与 `packageName` 两个字段）。
describe('Android 13 及以下点应用 = 采主屏', () => {
  const open = async (serial, packageName = 'com.example.app') => {
    await startMirrorSession({
      serial,
      packageName,
      // 整机镜像那一档不给 label，看它退成什么。
      label: packageName ? '示例' : undefined,
    })
    return initFrom(env.windows.at(-1))
  }

  it('API 33：deviceMirror 为真，但包名与标签照原样带着（渲染层据此把 app 开到主屏）', async () => {
    const init = await open('dev-sdk33')
    expect(init.deviceMirror).toBe(true)
    expect(init.packageName).toBe('com.example.app')
    expect(init.label).toBe('示例')
  })

  it('API 33 走官方那份 server：补丁产物的效果只在建显示上', async () => {
    await open('dev-sdk33-official')
    expect(env.serverPathArgs.at(-1)).toEqual({ largeScreenDisplay: false })
  })

  it('API 34 仍然建虚拟显示（33 是上限，不是「有版本就走主屏」）', async () => {
    const init = await open('dev-sdk34')
    expect(init.deviceMirror).toBe(false)
    expect(env.serverPathArgs.at(-1)).toBeUndefined()
  })

  it('读不到版本时维持建虚拟显示：形态不靠猜', async () => {
    expect((await open('dev-sdk-unknown')).deviceMirror).toBe(false)
  })

  it('空包名不管什么版本都是整机镜像，label 仍退「手机镜像」', async () => {
    const init = await open('dev-sdk33', '')
    expect(init.deviceMirror).toBe(true)
    expect(init.label).toBe('手机镜像')
  })
})

// 用户 2026-10-11 点单：「安卓 14 往上加一个桌面模式（= 点应用建虚拟屏那套）；
// 如果是直接手机镜像，则在悬浮栏加一个桌面模式打开按钮」。
// 于是入口只有一处：**采主屏的会话（整机镜像）+ Android 14+** 才在悬浮栏出那颗按钮，
// 点了把手机主屏上正在用的应用抽到一块新的虚拟屏窗口里（与首页点应用同一条路）。
describe('桌面模式入口（mirror:desktopMode）', () => {
  const openDesktopMode = (win) => env.handlers.get(CHANNELS.mirrorDesktopMode)({ sender: win.webContents })

  /** 这颗按钮出不出的判据在主进程定一次（渲染层不自己判版本），所以断言落在 pendingInit 上。 */
  it('只有整机镜像 + Android 14 才出这颗按钮', async () => {
    await startMirrorSession({ serial: 'dev-dm-sdk34', packageName: '' })
    expect(initFrom(env.windows.at(-1)).desktopModeAvailable).toBe(true)

    // 单应用那条路本身就是桌面模式（虚拟显示），不需要这个入口。
    await startMirrorSession({ serial: 'dev-dm-app-sdk34', packageName: 'com.example.app' })
    expect(initFrom(env.windows.at(-1)).desktopModeAvailable).toBe(false)

    // Android 13 及以下建出来的显示拿不到焦点（`supportsDesktopMode` 的门槛）。
    await startMirrorSession({ serial: 'dev-dm-sdk33', packageName: '' })
    expect(initFrom(env.windows.at(-1)).desktopModeAvailable).toBe(false)

    // 版本读不到 = 先不给入口（与 `mirrorsMainDisplay` 读不到时「照旧建显示」正好相反）。
    await startMirrorSession({ serial: 'dev-dm-unknown', packageName: '' })
    expect(initFrom(env.windows.at(-1)).desktopModeAvailable).toBe(false)
  })

  it('点了就把手机前台应用抽到一块新的虚拟屏窗口里（名称与图标取本机缓存）', async () => {
    env.foregroundApp = 'com.example.fg'
    env.cachedApps = [
      { packageName: 'com.example.fg', label: '前台应用', iconUrl: 'data:image/png;base64,aGk=' },
    ]
    await startMirrorSession({ serial: 'dev-dm-open', packageName: '' })
    const deviceWin = env.windows.at(-1)

    const result = await openDesktopMode(deviceWin)
    const appWin = env.windows.at(-1)
    expect(appWin).not.toBe(deviceWin)
    const init = initFrom(appWin)
    expect(init.packageName).toBe('com.example.fg')
    // 新窗口走的是虚拟显示那条路 —— 这才是「桌面模式」，不是又一扇采主屏的窗。
    expect(init.deviceMirror).toBe(false)
    expect(init.label).toBe('前台应用')
    expect(init.iconUrl).toBe('data:image/png;base64,aGk=')
    expect(init.desktopModeAvailable).toBe(false)
    expect(result.reused).toBeUndefined()
    expect(result.label).toBe('前台应用')
  })

  /** 手机上停在桌面（launcher 自己就是前台）时没有可搬的应用：不开窗，给一句能读的原因。 */
  it('手机停在桌面时不开窗，抛出可读原因', async () => {
    env.foregroundApp = null
    await startMirrorSession({ serial: 'dev-dm-none', packageName: '' })
    const win = env.windows.at(-1)
    const before = env.windows.length
    await expect(openDesktopMode(win)).rejects.toThrow(/没有打开的应用/)
    expect(env.windows.length).toBe(before)
  })

  /** 一个会话 = 一块虚拟显示：这个应用已经有窗口时只能复用，再建一块会把应用从旧显示上搬走。 */
  it('这个应用已经单独开着窗口时复用那个，不再建第二块显示', async () => {
    env.foregroundApp = 'com.example.dup'
    env.cachedApps = []
    await startMirrorSession({ serial: 'dev-dm-dup', packageName: '' })
    const deviceWin = env.windows.at(-1)
    await startMirrorSession({ serial: 'dev-dm-dup', packageName: 'com.example.dup' })
    const appWin = env.windows.at(-1)

    const result = await openDesktopMode(deviceWin)
    expect(result.reused).toBe(true)
    expect(env.windows.at(-1)).toBe(appWin)
    // 缓存里没有这个包名时名称退回包名本身（接回横幅会退化成首字母方块）。
    expect(result.label).toBe('com.example.dup')
  })

  /** 换个入口不该换掉用户配好的规格：新窗口沿用这个窗口的参数。 */
  it('新窗口沿用当前窗口的投屏参数', async () => {
    env.foregroundApp = 'com.example.cfg'
    env.cachedApps = []
    await startMirrorSession({
      serial: 'dev-dm-cfg',
      packageName: '',
      config: { maxFps: 30, audio: false },
    })
    await openDesktopMode(env.windows.at(-1))
    expect(initFrom(env.windows.at(-1)).config).toEqual({ maxFps: 30, audio: false })
  })
})

// 低版本没有 HyperOS 那扇 `Hangup` 门（灭屏仍合成），而这一档镜像的就是手机那块屏 ——
// 面板灭了就没帧可采。所以开会话时把「插电不休眠」打开，关会话时还原成**它原来的值**。
describe('Android 13 及以下开会话时 keepAwake', () => {
  const KEY = 'stay_on_while_plugged_in'

  it('API 33：写 7，用户自己开着的原值（1）在关会话时还回去', async () => {
    env.settingReads.length = 0
    env.settingWrites.length = 0
    env.stayOn[KEY] = 1
    const started = await startMirrorSession({ serial: 'dev-sdk33-awake', packageName: 'com.example.app' })
    await flush()
    expect(env.settingReads).toEqual([KEY])
    expect(env.settingWrites).toEqual([[KEY, 7]])

    await stopMirrorSession(started.id)
    expect(env.settingWrites).toEqual([
      [KEY, 7],
      [KEY, 1],
    ])
  })

  it('API 34 不碰这个设置（那一档灭屏仍合成，不该占用用户的电源偏好）', async () => {
    env.settingReads.length = 0
    env.settingWrites.length = 0
    const started = await startMirrorSession({ serial: 'dev-sdk34-awake', packageName: 'com.example.app' })
    await flush()
    expect(env.settingReads).toEqual([])
    expect(env.settingWrites).toEqual([])
    await stopMirrorSession(started.id)
    expect(env.settingWrites).toEqual([])
  })

  /** 读不到版本 = 不知道版本，那就别动用户设备上的东西。 */
  it('版本读不到时也不碰', async () => {
    env.settingReads.length = 0
    env.settingWrites.length = 0
    const started = await startMirrorSession({ serial: 'dev-sdk-unknown-awake', packageName: 'com.example.app' })
    await flush()
    expect(env.settingWrites).toEqual([])
    await stopMirrorSession(started.id)
  })

  it('空包名的整机镜像在 API 33 上同样开（采的都是那块屏）', async () => {
    env.settingWrites.length = 0
    env.stayOn[KEY] = 0
    const started = await startMirrorSession({ serial: 'dev-phone-sdk33', packageName: '' })
    await flush()
    expect(env.settingWrites).toEqual([[KEY, 7]])
    await stopMirrorSession(started.id)
    expect(env.settingWrites.at(-1)).toEqual([KEY, 0])
  })
})

// scrcpy server 意外退出 / 设备断开时，渲染层报一条 `mirror:state` 的 `exit`。
// ⚠️ 这条路径**不能只删会话记录** —— 设备的 `stay_on_while_plugged_in`、`synergy_mode` 与 Mac 键盘的归属
// 都是挂在会话记录上的还原函数，记录一丢就再也还不回去（真机看到 `stay_on_while_plugged_in` 停在 7）。
describe('server 意外退出（mirror:state exit）', () => {
  const KEY = 'stay_on_while_plugged_in'
  /** 收摊链上全是 async，微任务多跑几轮再断言。 */
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  const exitFrom = (win, id) =>
    env.handlers.get(CHANNELS.mirrorState)(
      { sender: win.webContents },
      { id, kind: 'exit', message: 'server 挂了' },
    )

  it('走完整收摊：设备侧的「插电不休眠」还回原值，窗口也关掉', async () => {
    env.settingWrites.length = 0
    env.stayOn[KEY] = 0
    const started = await startMirrorSession({ serial: 'dev-exit-sdk33', packageName: 'com.example.app' })
    await flush()
    expect(env.settingWrites).toEqual([[KEY, 7]])
    const win = env.windows.at(-1)
    const closeSpy = vi.spyOn(win, 'close')

    exitFrom(win, started.id)
    await settle()
    expect(env.settingWrites).toEqual([
      [KEY, 7],
      [KEY, 0],
    ])
    expect(closeSpy).toHaveBeenCalled()
  })

  /** 断开设备那条路也会调 `stopMirrorSession`；两条路撞上时只该还原一次，后到的那个拿不到记录、空转。 */
  it('与设备清理撞上时只还原一次', async () => {
    env.settingWrites.length = 0
    env.stayOn[KEY] = 1
    const serial = 'dev-exit-race-sdk33'
    const started = await startMirrorSession({ serial, packageName: 'com.example.app' })
    await flush()
    const win = env.windows.at(-1)

    exitFrom(win, started.id)
    await Promise.all(env.teardownHooks.map((hook) => hook(serial)))
    await settle()
    expect(env.settingWrites.filter(([, value]) => value === 1)).toEqual([[KEY, 1]])
  })
})

// 关掉镜像窗口时把手机放回桌面：只有「app 是我们 startApp 到主屏上」那一档才该动手机。
describe('关会话回桌面（goHome）', () => {
  it('Android 13 及以下点应用：关会话时回一次桌面', async () => {
    env.homeCalls.length = 0
    const started = await startMirrorSession({
      serial: 'dev-home-sdk33',
      packageName: 'com.example.app',
    })
    await stopMirrorSession(started.id)
    expect(env.homeCalls).toEqual(['dev-home-sdk33'])
  })

  it('Android 14+（app 在我们那块虚拟显示上）不动手机', async () => {
    env.homeCalls.length = 0
    const started = await startMirrorSession({
      serial: 'dev-home-sdk34',
      packageName: 'com.example.app',
    })
    await stopMirrorSession(started.id)
    expect(env.homeCalls).toEqual([])
  })

  /** 整机镜像没有「我们打开的 app」—— 手机上停着什么是他自己操作的，别替他回桌面。 */
  it('整机镜像（空包名）不动手机', async () => {
    env.homeCalls.length = 0
    const started = await startMirrorSession({ serial: 'dev-home-sdk33-phone', packageName: '' })
    await stopMirrorSession(started.id)
    expect(env.homeCalls).toEqual([])
  })

  /** 复用旧会话（再点一次同一个 app）只唤前台，不新建登记 ⇒ 关一次只会回一次桌面。 */
  it('复用旧会话时不会重复回桌面', async () => {
    env.homeCalls.length = 0
    const started = await startMirrorSession({
      serial: 'dev-home-twice-sdk33',
      packageName: 'com.example.app',
    })
    const again = await startMirrorSession({
      serial: 'dev-home-twice-sdk33',
      packageName: 'com.example.app',
    })
    expect(again.reused).toBe(true)
    await stopMirrorSession(started.id)
    expect(env.homeCalls).toEqual(['dev-home-twice-sdk33'])
  })
})

// 画面外面平时什么都不画：窗口本体必须透明（否则那是一条不透明的底压在桌面上），红绿灯也得跟着藏 ——
// 那三颗圆点是系统画的，CSS 盖不住，浮在透明窗口上就不像手机了。
describe('镜像窗口的透明本体与红绿灯', () => {
  it('设备名读得到时，窗口标题与 pendingInit 都写「app - 设备名」', async () => {
    await startMirrorSession({ serial: 'dev-named', packageName: 'com.example.app', label: '日历' })
    const win = env.windows.at(-1)
    expect(win.options.title).toBe('日历 - Mi 10')
    expect(initFrom(win).windowTitle).toBe('日历 - Mi 10')
  })

  it('设备名读不到时只留 app 名，不留一个孤零零的 " - "', async () => {
    await startMirrorSession({ serial: 'dev-noname', packageName: 'com.example.app', label: '日历' })
    expect(env.windows.at(-1).options.title).toBe('日历')
  })

  it('本体透明、底色全透明（平时"就是个手机样子"），三颗先藏起来', async () => {
    await startMirrorSession({ serial: 'dev-transparent', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    expect(win.options.transparent).toBe(true)
    expect(win.options.backgroundColor).toBe('#00000000')
    // ⚠️ 墓碑：**别加 `roundedCorners: false`**（10-12 加过一整轮）。它确实能让那层浅灰铺到窗口尖角，
    // 但同一刻 macOS 那三颗彩虹键整组不画了（用户当场报「mac的三个彩虹按钮没了」）—— 窗角与标准按钮
    // 是同一套窗口外形。圆角归系统，臂只要把灰铺到边（`border-radius` 也别写，见 `App.vue`）。
    expect('roundedCorners' in win.options).toBe(false)
    // 10-12 竞品口径：浅灰那层 chrome 是**涂装**，鼠标贴边才浮出 ⇒ 本体一个字节不改，
    // 但三颗必须平时藏着（不然圆点会浮在桌面上）。
    expect(win.buttonCalls).toEqual([false])
  })

  /** 放出来之后必须紧跟一次设位：`setWindowButtonVisibility(true)` 会把三颗打回默认左上角。 */
  it('chrome 显形放出三颗并补设落点，收起时再藏掉', async () => {
    await startMirrorSession({ serial: 'dev-chrome', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    env.handlers.get(CHANNELS.mirrorWindowButtons)({ sender: win.webContents }, true)
    env.handlers.get(CHANNELS.mirrorWindowButtons)({ sender: win.webContents }, false)
    expect(win.buttonCalls).toEqual([false, true, false])
    expect(win.lightTrace.map((c) => c.kind)).toEqual([
      'visibility',
      'visibility',
      'position',
      'visibility',
    ])
    expect(win.lightTrace[2].value).toEqual(mirrorTrafficLightPosition())
  })

  /**
   * 用户 2026-10-12：「试试 a 的变体，上边加一条专门放三个按钮和 app 名称」⇒ 三颗**只挪进顶部那条**：
   * 落点是个与窗口宽无关的常量（10-10 贴右侧长条那套要跟着窗口宽跑，那条坑从根上没了），
   * **显隐照样一次都不调** —— 常驻，不跟长条 hover 走（10-11 那条"不要藏不要放"仍然算数）。
   */
  it('红绿灯落点在顶部标题栏里、与窗口宽无关；显隐一次都不调', async () => {
    await startMirrorSession({ serial: 'dev-lights-bar', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    expect(win.options.trafficLightPosition).toEqual(mirrorTrafficLightPosition())
    // 建窗口那一次「先藏」是 chrome 涂装的一部分，不算"去管三颗"。
    expect(win.lightTrace.map((c) => c.kind)).toEqual(['visibility'])
    // 落点不依赖窗口宽：换个宽度再算还是同一个数（所以 resize 里没有任何重算代码）。
    expect(mirrorTrafficLightPosition()).toEqual({ x: MIRROR_TITLEBAR.lightX, y: 7 })
    win.fire('resize')
    win.fire('enter-full-screen')
    win.fire('leave-full-screen')
    expect(win.lightTrace.map((c) => c.kind)).toEqual(['visibility'])
  })
})

// dev 调试边栏（`tools` 那一格）展开时撑宽的是**窗口**，不是从画面里切一块 ——
// 画面尺寸一旦变了就会发 `resizeDisplay`，手机上当场重排一次，那是 dev 面板不该有的副作用。
describe('调试边栏撑宽窗口（mirror:windowHud）', () => {
  const open = (win, px) => env.handlers.get(CHANNELS.mirrorWindowHud)({ sender: win.webContents }, px)

  it('展开撑宽同样的量、收起再收回去；重复报同一个值不再动窗口', async () => {
    await startMirrorSession({ serial: 'dev-hud', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    const base = win.getContentSize()[0]
    open(win, 240)
    expect(win.getContentSize()[0]).toBe(base + 240)
    // 页面 HMR 重载后又报一次 240：状态自己纠正，不该再撑一遍。
    open(win, 240)
    expect(win.getContentSize()[0]).toBe(base + 240)
    open(win, 0)
    expect(win.getContentSize()[0]).toBe(base)
    expect(win.sizeCalls.length).toBe(2)
  })

  it('全屏时不动窗口尺寸；报非法值当没发生', async () => {
    await startMirrorSession({ serial: 'dev-hud-fs', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    win.fullscreen = true
    open(win, 240)
    expect(win.sizeCalls).toEqual([])
    win.fullscreen = false
    open(win, 'x')
    expect(win.sizeCalls).toEqual([])
  })
})

// 横窗会开出一块横显示，竖屏 app 立刻换版式（`mirrorWindowBounds` 照设备画面比例 fit 可用区）。
describe('镜像窗口照设备画面比例开', () => {
  it('竖屏手机 → 等比竖窗，并把设备分辨率透传给镜像页（它据此决定给不给显示尺寸）', async () => {
    await startMirrorSession({ serial: 'dev-shape', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    // adb mock 回 1200x2608；可用区 1440x900 减 80 系统余量再减内缩（横 94、纵 (4+28)+4=36）
    // → 画面可用 1266x784，高顶满 784、宽按比 361；窗口 = 361+94 x 784+36。
    expect({ width: win.options.width, height: win.options.height }).toEqual({
      width: 455,
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

// 拖拽锁不锁**按那一档分流**（用户 2026-10-11 两条点单）：
// - 采主屏那档（整机镜像 / 13 及以下点应用）：「不可以随意更改，只能按手机比例拖拽宽度和高度」⇒ 锁。
// - 桌面模式那档（点应用建的 flex 显示）：「宽度高度可以自定义拖拽」⇒ 不锁，画面区一变走
//   `resizeDisplay`，设备重排出那个形状。
describe('镜像窗口的拖拽比例：采主屏锁、桌面模式放开', () => {
  /** 采主屏那档：包名为空 = 整机镜像。 */
  it('整机镜像：建窗口就按设备画面比例锁，不参与比例的余量 = 黑框 + 右侧长条', async () => {
    await startMirrorSession({ serial: 'dev-ratio', packageName: '' })
    // adb mock 回 1200x2608。
    expect(env.windows.at(-1).aspectCalls).toEqual([[1200 / 2608, mirrorContentExtraSize()]])
  })

  it('13 及以下点应用也采主屏 ⇒ 一样锁', async () => {
    await startMirrorSession({ serial: 'dev-ratio-sdk33', packageName: 'com.example.app' })
    expect(env.windows.at(-1).aspectCalls).toEqual([[1200 / 2608, mirrorContentExtraSize()]])
  })

  it('桌面模式那档（14+ 点应用建虚拟显示）**不锁**，宽高随意拖', async () => {
    await startMirrorSession({ serial: 'dev-ratio-sdk34', packageName: 'com.example.app' })
    expect(env.windows.at(-1).aspectCalls).toEqual([])
  })

  it('读不到设备分辨率时不锁（不自己编一个比例）', async () => {
    await startMirrorSession({ serial: 'dev-ratio-unknown', packageName: '' })
    expect(env.windows.at(-1).aspectCalls).toEqual([])
  })

  /** dev 边栏撑宽的是窗口：那一截不进画面，所以必须算成余量，否则拖一次边就把边栏挤没。 */
  it('dev 边栏开合会把那一截算进余量（锁着的那档）', async () => {
    await startMirrorSession({ serial: 'dev-ratio-hud', packageName: '' })
    const win = env.windows.at(-1)
    const hud = (px) => env.handlers.get(CHANNELS.mirrorWindowHud)({ sender: win.webContents }, px)
    hud(240)
    hud(0)
    expect(win.aspectCalls.map((c) => c[1])).toEqual([
      mirrorContentExtraSize(),
      mirrorContentExtraSize(240),
      mirrorContentExtraSize(0),
    ])
    // 比例始终是画面那一个，不随边栏变。
    expect(win.aspectCalls.map((c) => c[0])).toEqual([1200 / 2608, 1200 / 2608, 1200 / 2608])
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
    // 构造参数里不该有 `fullscreen`（那条在 macOS 上不可靠）；`fullscreenable` 要**开**着 ——
    // 用户 10-11 明确「我要的是全屏，不是放大按钮」，zoom 撑满那一版试过并已回退。
    expect('fullscreen' in win.options).toBe(false)
    expect(win.options.fullscreenable).toBe(true)
    win.fire('ready-to-show')
    expect(win.shown).toBe(true)
    expect(win.fullscreenCalls).toEqual([true])
    expect(win.maximizeCalls).toBe(0)
    // 页面拿启动参数就能知道自己一开是不是全屏（等事件会晚一拍，长条先按常态排一遍）。
    expect(initFrom(win).prefs.fullscreen).toBe(true)
  })

  /**
   * 全屏那一屏是另一种形态（手机在整块屏幕正中、长条常驻、画面收成手机那块）⇒ 进/出都要推给页面。
   * ⚠️ 这里**不碰红绿灯**：用户 10-11 定了「恢复默认，不要有任何修改」，那三颗全归系统。
   */
  it('进/出全屏各推一条 mirror:fullscreen，并且不动红绿灯', async () => {
    const win = await open('dev-fs-push', undefined)
    win.fire('enter-full-screen')
    expect(win.webContents.sent).toEqual([[CHANNELS.mirrorFullscreen, true]])
    win.fire('leave-full-screen')
    expect(win.webContents.sent).toEqual([
      [CHANNELS.mirrorFullscreen, true],
      [CHANNELS.mirrorFullscreen, false],
    ])
    // 全屏里不许再动那三颗（归系统顶边浮出）⇒ 只有建窗口那一次「先藏」。
    expect(win.lightTrace).toEqual([{ kind: 'visibility', value: false }])
  })

  it('关着时：只 show，不碰全屏', async () => {
    const win = await open('dev-fs-off', { fullscreen: false })
    win.fire('ready-to-show')
    expect(win.shown).toBe(true)
    expect(win.maximizeCalls).toBe(0)
    expect(win.fullscreenCalls).toEqual([])
  })

  it('没配置时默认关：不碰全屏', async () => {
    const win = await open('dev-fs-default', undefined)
    win.fire('ready-to-show')
    expect(win.maximizeCalls).toBe(0)
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

// Mac 键盘（G1）：长条那颗开关走 `mirror:macKeyboard`，主进程那份归属状态机决定一切。
// 判据钉的是「抢得过来、还得回去、别替用户把键盘丢了」，状态机本身的分支在
// `tests/electron/macKeyboard.test.js` 里逐条覆盖。
describe('Mac 键盘开关（mirror:macKeyboard）', () => {
  const toggle = (win, action) =>
    env.handlers.get(CHANNELS.mirrorMacKeyboard)({ sender: win.webContents }, action)

  it('开着：抢成我们的输入法、原值存进设备侧那份；关掉时原样还回去', async () => {
    await startMirrorSession({ serial: 'dev-mk', packageName: 'com.example.app' })
    const win = env.windows.at(-1)
    expect((await toggle(win, 'state')).state).toBe('off')
    expect((await toggle(win, 'on')).state).toBe('active')
    expect(env.secure.default_input_method).toBe(MAC_KEYBOARD_IME)
    expect(env.stash).toBe('com.sohu.inputmethod.sogou.xiaomi/.SogouIME')
    expect((await toggle(win, 'state')).state).toBe('active')
    expect((await toggle(win, 'off')).state).toBe('off')
    expect(env.secure.default_input_method).toBe('com.sohu.inputmethod.sogou.xiaomi/.SogouIME')
    expect(env.stash).toBe('')
  })

  /** 用户不该因为我们没退干净就丢掉自己的键盘：最后一个窗口关掉即还原。 */
  it('最后一个镜像窗口关掉时自动还原', async () => {
    const { id } = await startMirrorSession({ serial: 'dev-mk-stop', packageName: 'com.example.app' })
    await toggle(env.windows.at(-1), 'on')
    expect(env.secure.default_input_method).toBe(MAC_KEYBOARD_IME)
    await stopMirrorSession(id)
    expect(env.secure.default_input_method).toBe('com.sohu.inputmethod.sogou.xiaomi/.SogouIME')
  })

  /** 输入法是**设备级**的：一台手机一份归属，第二个窗口不该再抢一遍、更不该把我们的 id 当原值存下来。 */
  it('同一台设备第二个窗口复用同一份归属，不重复夺回', async () => {
    await startMirrorSession({ serial: 'dev-mk-two', packageName: 'com.example.a' })
    const first = env.windows.at(-1)
    await startMirrorSession({ serial: 'dev-mk-two', packageName: 'com.example.b' })
    const second = env.windows.at(-1)
    await toggle(first, 'on')
    const stashes = env.shellCalls.filter((c) => c.startsWith('echo ')).length
    expect((await toggle(second, 'state')).state).toBe('active')
    expect(env.shellCalls.filter((c) => c.startsWith('echo ')).length).toBe(stashes)
  })
})
