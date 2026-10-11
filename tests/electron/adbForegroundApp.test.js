import { beforeEach, describe, expect, it, vi } from 'vitest'

// 镜像窗口悬浮栏那颗「桌面模式」要的是**手机主屏上正在用的那个应用**：
// 主进程按包名建一块虚拟显示，渲染层再把那个 task 搬过去（不重启应用）。
// 判据全落在输出文本上，而 `dumpsys` 的行形态各 ROM 略有出入 —— 认不出来必须回 null（不猜），
// 更要紧的是「停在桌面」那一档必须认出来：前台就是 launcher 自己时，把它的 task 搬走
// 会把手机主屏一起搞乱。launcher 包名按 HOME intent 现问，不写死任何 ROM 的包名。

const state = vi.hoisted(() => ({
  /** @type {string[][]} */
  calls: [],
  /** 按命令关键字决定回什么；没匹配上的回空输出。 */
  /** @type {Array<[RegExp, { err?: unknown, stdout?: string, stderr?: string }]>} */
  responses: [],
}))

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

vi.mock('node:child_process', () => ({
  execFile: (_file, args, _options, callback) => {
    state.calls.push(args)
    if (args[0] === 'start-server') return callback(null, '', '')
    const command = String(args.at(-1) ?? '')
    const hit = state.responses.find(([pattern]) => pattern.test(command))
    const { err = null, stdout = '', stderr = '' } = hit?.[1] ?? {}
    callback(err, stdout, stderr)
  },
}))

const { getForegroundApp, parseForegroundPackage, parseHomePackage } = await import('../../electron/adb.js')

const serial = 'fb637d72'
const FRONT = /dumpsys activity/
const HOME = /resolve-activity/
const LAUNCHER = 'com.miui.home/.launcher.Launcher'

/** 两条命令各自回什么（`getForegroundApp` 是并发发的，所以按内容分发而不是按顺序）。 */
const reply = (foreground, home = { stdout: LAUNCHER }) => {
  state.responses = [
    [FRONT, typeof foreground === 'string' ? { stdout: foreground } : foreground],
    [HOME, home],
  ]
}

const commandFor = (pattern) => String(state.calls.find((args) => pattern.test(String(args.at(-1))))?.at(-1) ?? '')

beforeEach(() => {
  state.calls.length = 0
  state.responses = []
})

describe('getForegroundApp（手机主屏上正在用的应用）', () => {
  it('取到顶层 Activity 的包名，并把它带给调用方', async () => {
    reply('  topResumedActivity=ActivityRecord{c8d1e2 u0 com.example.app/.MainActivity t42}')
    await expect(getForegroundApp(serial)).resolves.toBe('com.example.app')
  })

  /** 只 grep 需要的那几行：整份 `dumpsys activity` 是几百 KB，不能拖回本机（同 `getAppTask`）。 */
  it('前台那条命令在设备侧就 grep 掉，不把整份 dumpsys 拖回来', async () => {
    reply('  ResumedActivity: ActivityRecord{abc u0 com.example.app/.Main t42}')
    await getForegroundApp(serial)
    const command = commandFor(FRONT)
    expect(command).toContain('grep')
    expect(command).toContain('ResumedActivity')
  })

  /** 停在桌面：前台是 launcher 自己 ⇒ 没有可搬的应用。搬 launcher 的 task 会连手机主屏一起搞乱。 */
  it('前台就是桌面（launcher）时回 null', async () => {
    reply(`  topResumedActivity=ActivityRecord{abc u0 ${LAUNCHER} t1}`)
    await expect(getForegroundApp(serial)).resolves.toBeNull()
  })

  /** launcher 包名按 HOME intent 现问，不写死 ROM 的包名（仓库不留机型特判）。 */
  it('桌面包名问的是 HOME intent', async () => {
    reply(`  topResumedActivity=ActivityRecord{abc u0 ${LAUNCHER} t1}`)
    await getForegroundApp(serial)
    const command = commandFor(HOME)
    expect(command).toContain('resolve-activity')
    expect(command).toContain('android.intent.category.HOME')
  })

  /** 问不到桌面是谁时不做守卫（少一道闸，也不冤枉前台那个应用）。 */
  it('桌面包名问不到（命令失败）时照样回前台应用', async () => {
    reply('  topResumedActivity=ActivityRecord{abc u0 com.example.app/.Main t42}', {
      err: Object.assign(new Error('Command failed'), { code: 1 }),
    })
    await expect(getForegroundApp(serial)).resolves.toBe('com.example.app')
  })

  /** 认不出来就是「不知道」：给一个猜的包名会让按钮搬错应用。 */
  it('读不到前台行时回 null', async () => {
    reply('')
    await expect(getForegroundApp(serial)).resolves.toBeNull()
  })

  it('两条命令并发发，不为一次点击多等一个来回', async () => {
    reply('  topResumedActivity=ActivityRecord{abc u0 com.example.app/.Main t42}')
    await getForegroundApp(serial)
    // 一条前台、一条桌面（外加 ensureServer 的 start-server）。
    expect(state.calls.filter((args) => FRONT.test(String(args.at(-1))) || HOME.test(String(args.at(-1))))).toHaveLength(2)
  })
})

describe('parseForegroundPackage（三种 dumpsys 行形态）', () => {
  it('`dumpsys activity activities` 的 topResumedActivity / ResumedActivity', () => {
    expect(parseForegroundPackage('topResumedActivity=ActivityRecord{1 u0 com.a.b/.Main t3}')).toBe('com.a.b')
    expect(parseForegroundPackage('  ResumedActivity: ActivityRecord{2 u0 com.c.d/.E t4}')).toBe('com.c.d')
  })

  /** `dumpsys window` 那两条是备选信源，同一种「u<userId> 包名/Activity」排版。 */
  it('`dumpsys window` 的 mCurrentFocus / mFocusedApp', () => {
    expect(parseForegroundPackage('  mCurrentFocus=Window{a u0 com.e.f/com.e.f.G}')).toBe('com.e.f')
    expect(parseForegroundPackage('  mFocusedApp=ActivityRecord{b u0 com.g.h/.I t9}')).toBe('com.g.h')
  })

  /** 非默认用户（u10）也要认：只钉 `u<数字>` 后面那个 token。 */
  it('多用户设备上的 userId 不影响取值', () => {
    expect(parseForegroundPackage('topResumedActivity=ActivityRecord{1 u10 com.x.y/.Z t3}')).toBe('com.x.y')
  })

  it('没有前台行 / 行里没有 `包名/Activity` 时回 null', () => {
    expect(parseForegroundPackage('')).toBeNull()
    expect(parseForegroundPackage(undefined)).toBeNull()
    expect(parseForegroundPackage('Display #0 (activities from top to bottom):')).toBeNull()
    expect(parseForegroundPackage('mCurrentFocus=null')).toBeNull()
  })
})

describe('parseHomePackage（`cmd package resolve-activity --brief`）', () => {
  it('跳过优先级统计行，取最后那行 `包名/Activity`', () => {
    expect(
      parseHomePackage(
        'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n' +
          'com.miui.home/.launcher.Launcher\n',
      ),
    ).toBe('com.miui.home')
    expect(parseHomePackage('  com.android.launcher3/.Launcher  \n')).toBe('com.android.launcher3')
  })

  it('认不出来时回 null（调用方据此跳过那道守卫）', () => {
    expect(parseHomePackage('')).toBeNull()
    expect(parseHomePackage(undefined)).toBeNull()
    expect(parseHomePackage('No activity found')).toBeNull()
  })
})
