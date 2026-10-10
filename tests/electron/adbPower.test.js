import { beforeEach, describe, expect, it, vi } from 'vitest'

// 电源与桌面这几条 adb 命令的判据都落在「输出文本」上：设备**报错时退出码常常仍是 0**，
// 而「已经在桌面/已经在最前台」是一句 Warning 却不是失败。两种都判错过一次的话，
// 前者 = 「继续使用」按钮点了没反应，后者 = 每次关会话都往日志里塞一条假故障。

const state = vi.hoisted(() => ({
  /** @type {string[][]} */
  calls: [],
  result: { err: null, stdout: '', stderr: '' },
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
    const { err, stdout, stderr } = state.result
    callback(err, stdout, stderr)
  },
}))

const { goHome, wakeDevice, parseGlobalNumberSetting, parseWakefulness, parsePanelPower, getPowerState } =
  await import('../../electron/adb.js')

const serial = 'fb637d72'

const lastArgs = () => state.calls.at(-1)
const respond = (stdout, stderr = '') => {
  state.result = { err: null, stdout, stderr }
}

beforeEach(() => {
  state.calls.length = 0
  state.result = { err: null, stdout: '', stderr: '' }
})

describe('goHome（关镜像后把手机放回桌面）', () => {
  it('发的是 `am start` 的 HOME intent，不是 keyevent（不吃 INJECT_EVENTS）', async () => {
    respond('Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.HOME] }')
    await expect(goHome(serial)).resolves.toBe(true)
    expect(lastArgs()).toEqual([
      '-s',
      serial,
      'shell',
      'am start -a android.intent.action.MAIN -c android.intent.category.HOME',
    ])
  })

  /** 已经在桌面时设备回这句 Warning —— 这正是我们要的状态，不能当失败。 */
  it('「task has been brought to the front」算成功', async () => {
    respond(
      'Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.HOME] }\n' +
        'Warning: Activity not started, its current task has been brought to the front',
    )
    await expect(goHome(serial)).resolves.toBe(true)
  })

  it('输出里有 Error 时抛（退出码 0 也不算成功）', async () => {
    respond('Error: Activity not started, unable to resolve Intent { act=android.intent.action.MAIN cat=[android.intent.category.HOME] }')
    await expect(goHome(serial)).rejects.toThrow(/unable to resolve Intent/)
  })

  it('命令非零退出时抛', async () => {
    state.result = { err: Object.assign(new Error('Command failed'), { code: 1 }), stdout: '', stderr: 'adb exited' }
    await expect(goHome(serial)).rejects.toThrow(/adb exited/)
  })
})

describe('wakeDevice（点「继续使用」点亮屏幕）', () => {
  /** MIUI「USB 调试（安全设置）」没开时 `input` 被拒，退出码仍是 0 —— 只判 code 会静默失败。 */
  it('退出码 0 但输出是 SecurityException 时抛', async () => {
    respond(
      '',
      'java.lang.SecurityException: Injecting input events requires INJECT_EVENTS permission.',
    )
    await expect(wakeDevice(serial)).rejects.toThrow(/INJECT_EVENTS/)
  })

  it('干净输出时成功', async () => {
    respond('')
    await expect(wakeDevice(serial)).resolves.toBe(true)
  })
})

describe('设备读数解析', () => {
  it('`settings get global`：没设过（字面量 null）= 默认值 0，命令失败 = 读不到', () => {
    expect(parseGlobalNumberSetting('null\n', 0)).toBe(0)
    expect(parseGlobalNumberSetting('7\n', 0)).toBe(7)
    expect(parseGlobalNumberSetting('', 1)).toBeNull()
    expect(parseGlobalNumberSetting('SecurityException', 0)).toBeNull()
  })

  it('`dumpsys power`：只取状态名，读不到回 null', () => {
    expect(parseWakefulness('  mWakefulness=Asleep')).toBe('Asleep')
    expect(parseWakefulness('  mWakefulness=Awake')).toBe('Awake')
    expect(parseWakefulness('')).toBeNull()
    expect(parseWakefulness(undefined)).toBeNull()
  })

  /** 面板状态在 SF 里是 `On` / `Off` / `Doze` / `DozeSuspend`，归成大写后页面只比一个 `'ON'`。 */
  it('`dumpsys SurfaceFlinger`：只取 powerMode 并归成大写，读不到回 null', () => {
    expect(parsePanelPower('   powerMode=On')).toBe('ON')
    expect(parsePanelPower('   powerMode=DozeSuspend')).toBe('DOZESUSPEND')
    // 只有一条读数时取第一条命中的（物理屏在 SF 的显示清单里排在最前）
    expect(parsePanelPower('powerMode=Off\npowerMode=On')).toBe('OFF')
    expect(parsePanelPower('')).toBeNull()
    expect(parsePanelPower(undefined)).toBeNull()
  })
})

/**
 * 「关屏使用」那颗按钮的翻面全靠这两条读数：`setDisplayPower(OFF)` 只灭面板，
 * 设备仍 `Awake` —— 只报 `mWakefulness` 的话页面永远翻不出「恢复亮屏」（10-10 报的那条）。
 */
describe('getPowerState（一次 adb 调用拿两条读数）', () => {
  it('两条 grep 拼在同一条 shell 里，不拆成两次 execFile', async () => {
    respond('mWakefulness=Awake\npowerMode=On\n')
    await expect(getPowerState(serial)).resolves.toEqual({ wakefulness: 'Awake', screen: 'ON' })
    const args = lastArgs()
    expect(args.slice(0, 3)).toEqual(['-s', serial, 'shell'])
    expect(args).toHaveLength(4)
    expect(args[3]).toContain('mWakefulness')
    // ⚠️ 面板那条必须问 SurfaceFlinger，不是 `dumpsys display`：上游 scrcpy 的
    // `Device.setDisplayPower()` 走 `SurfaceControl.setDisplayPowerMode()`，绕开 DisplayManagerService，
    // 所以它的 `mScreenState` 可能一直停在 `ON` —— 那样这颗按钮就又翻不回来了。
    expect(args[3]).toContain('SurfaceFlinger')
    expect(args[3]).toContain('powerMode')
    expect(args[3]).not.toContain('mScreenState')
  })

  /** 关屏使用时设备没睡：这一条就是页面区分「睡了」和「只是屏灭」的依据。 */
  it('设备 Awake 而面板 Off 时原样报回', async () => {
    respond('mWakefulness=Awake\npowerMode=Off\n')
    await expect(getPowerState(serial)).resolves.toEqual({ wakefulness: 'Awake', screen: 'OFF' })
  })

  /** 只读到一条（比如这个 ROM 的 SF 不 dump `powerMode`）时另一项是 null，页面据此回落到只看 wakefulness。 */
  it('读不到的一条是 null，命令整体失败时两条都是 null', async () => {
    respond('mWakefulness=Hangup\n')
    await expect(getPowerState(serial)).resolves.toEqual({ wakefulness: 'Hangup', screen: null })
    respond('')
    await expect(getPowerState(serial)).resolves.toEqual({ wakefulness: null, screen: null })
  })
})
