import { describe, expect, it } from 'vitest'
import {
  createMacKeyboard,
  isSafeImeId,
  BRIDGE_TOKEN_SETTING,
  MAC_KEYBOARD_IME,
  REASSERT_LIMIT,
  STASH_FILE,
} from '../../electron/mirror/macKeyboard.js'

// 输入法归属这台状态机的判据，全部对着 2026-10-11 的真机实测写：
// `ime set` 会报成功但值没变、对面（AndroMeld 的常驻进程）会持续夺回、
// 而我们要能把用户原来的输入法原样还回去 —— 还不了就宁可不开。

/**
 * 假设备：`ime` 是当前默认输入法，`writes` 决定我们写下去**到底生不生效**
 * （false = 模拟对面抢得比我们快，`ime set` 那句成功是假的）。
 */
function makeDevice({ ime = 'com.sohu.inputmethod.sogou.xiaomi/.SogouIME', stash = '', writes = true, imeList = '' } = {}) {
  /** @type {Array<[string, unknown]>} */
  const calls = []
  const device = {
    calls,
    setIme: (value) => {
      ime = value
    },
    get ime() {
      return ime
    },
    writes,
  }
  device.kb = createMacKeyboard({
    readIme: async () => ime,
    writeIme: async (value) => {
      calls.push(['write', value])
      if (device.writes) ime = value
      return true
    },
    runShell: async (command) => {
      calls.push(['shell', command])
      if (command.startsWith('cat')) return { ok: true, stdout: stash }
      if (command.startsWith('ime list')) return { ok: true, stdout: imeList }
      return { ok: true, stdout: '' }
    },
    onState: (state) => calls.push(['state', state]),
    // 定时器换成手动：测试里靠直接调 `reconcile()` 推进，不睡真实时间。
    setIntervalImpl: () => 'fake-timer',
    clearIntervalImpl: () => calls.push(['clearTimer']),
  })
  return device
}

const states = (calls) => calls.filter((c) => c[0] === 'state').map((c) => c[1])
const writesOf = (calls) => calls.filter((c) => c[0] === 'write').map((c) => c[1])

describe('macKeyboard 输入法归属', () => {
  it('开启：记下用户原输入法、设备侧留一份、抢过来并落到 active', async () => {
    const d = makeDevice()
    expect(await d.kb.enable()).toBe('active')
    expect(d.kb.getOriginal()).toBe('com.sohu.inputmethod.sogou.xiaomi/.SogouIME')
    expect(d.ime).toBe(MAC_KEYBOARD_IME)
    const shells = d.calls.filter((c) => c[0] === 'shell').map((c) => c[1])
    expect(shells).toContain(`ime enable ${MAC_KEYBOARD_IME}`)
    expect(shells).toContain(`echo com.sohu.inputmethod.sogou.xiaomi/.SogouIME > ${STASH_FILE}`)
    expect(states(d.calls)).toEqual(['active'])
  })

  /** 真机实测：`ime set` 回 `selected for user #0`，但 `settings get` 仍是别人的。 */
  it('写完必须回读：命令报成功而值没变时，状态是 switched_away 而不是 active', async () => {
    const d = makeDevice({ writes: false })
    expect(await d.kb.enable()).toBe('switched_away')
    expect(d.ime).toBe('com.sohu.inputmethod.sogou.xiaomi/.SogouIME')
  })

  /** 防乒乓：抢不过就停手，不能两家无限互写。 */
  it('重断言到上限后停手，之后只读不写', async () => {
    const d = makeDevice({ writes: false })
    await d.kb.enable()
    for (let i = 0; i < 6; i += 1) await d.kb.reconcile()
    // 开启那一次 + 最多 `limit` 次重断言，之后不再写。
    expect(writesOf(d.calls).length).toBeLessThanOrEqual(REASSERT_LIMIT + 1)
    const settled = writesOf(d.calls).length
    for (let i = 0; i < 3; i += 1) await d.kb.reconcile()
    expect(writesOf(d.calls).length).toBe(settled)
    expect(d.kb.getState()).toBe('switched_away')
  })

  /** 停手是为了防乒乓，不是"这台设备从此归别人"（10-11 真机撞到的：被抢走后怎么点都不回来）。 */
  it('停手之后再点一次「开」：重装额度再抢，不是空转', async () => {
    const d = makeDevice({ writes: false })
    await d.kb.enable()
    for (let i = 0; i < 5; i += 1) await d.kb.reconcile()
    const settled = writesOf(d.calls).length
    await d.kb.reconcile()
    expect(writesOf(d.calls).length).toBe(settled)
    d.writes = true
    expect(await d.kb.enable()).toBe('active')
    expect(d.ime).toBe(MAC_KEYBOARD_IME)
  })

  it('被抢走时先重断言；抢回来就重新算成功（额度归零）', async () => {    const d = makeDevice()
    await d.kb.enable()
    d.setIme('com.baidu.input_mi/.ImeService')
    expect(await d.kb.reconcile()).toBe('active')
    expect(d.ime).toBe(MAC_KEYBOARD_IME)
    // 对面赢一次、我们抢回来一次 ⇒ 额度不该攒到停手。
    d.setIme('com.baidu.input_mi/.ImeService')
    expect(await d.kb.reconcile()).toBe('active')
    expect(d.kb.getState()).toBe('active')
  })

  it('关掉：原样还回用户输入法、删掉设备侧那份、撤掉定时器', async () => {
    const d = makeDevice()
    await d.kb.enable()
    d.calls.length = 0
    expect(await d.kb.disable()).toBe('off')
    expect(d.ime).toBe('com.sohu.inputmethod.sogou.xiaomi/.SogouIME')
    expect(d.calls).toContainEqual(['clearTimer'])
    expect(d.calls).toContainEqual(['shell', `rm -f ${STASH_FILE}`])
    // 关掉之后 reconcile 是空操作（定时器已撤，这里防的是有人手动调它）。
    d.calls.length = 0
    expect(await d.kb.reconcile()).toBe('off')
    expect(d.calls).toEqual([])
  })

  it('读不到当前输入法时不开、也不写任何东西（宁可这次没有 Mac 键盘）', async () => {
    const d = makeDevice({ ime: null })
    expect(await d.kb.enable()).toBe('unavailable')
    expect(writesOf(d.calls)).toEqual([])
  })

  /** Mac 进程被强杀的那条兜底：当前值是我们自己，原值只能从设备侧那份捡。 */
  it('上次没还原：从设备侧 stash 捡回原输入法', async () => {
    const d = makeDevice({ ime: MAC_KEYBOARD_IME, stash: 'com.iflytek.inputmethod.miui/.FlyIME\n' })
    expect(await d.kb.enable()).toBe('active')
    expect(d.kb.getOriginal()).toBe('com.iflytek.inputmethod.miui/.FlyIME')
    await d.kb.disable()
    expect(d.ime).toBe('com.iflytek.inputmethod.miui/.FlyIME')
  })

  it('捡不到原值就不开：不能把用户键盘永久留在我们手里', async () => {
    const d = makeDevice({ ime: MAC_KEYBOARD_IME, stash: '' })
    expect(await d.kb.enable()).toBe('unavailable')
    expect(writesOf(d.calls)).toEqual([])
  })

  /** 设备回读的值要拼进 `echo ... > 文件`，所以字符集必须卡死。 */
  it('当前输入法是个怪串（带 shell 元字符）时：不 stash、不开', async () => {
    const d = makeDevice({ ime: 'evil; rm -rf /' })
    expect(await d.kb.enable()).toBe('unavailable')
    expect(d.calls.some((c) => c[0] === 'shell' && String(c[1]).includes('echo'))).toBe(false)
    expect(writesOf(d.calls)).toEqual([])
  })

  /** 抽象 socket 在设备上谁都能连 ⇒ 连上要对暗号，暗号每次开启换一个。 */
  it('开启写一个握手 token 进 Settings.Global，关掉即清；每次开启都换新的', async () => {
    const d = makeDevice()
    const first = await d.kb.enable()
    expect(first).toBe('active')
    const token = d.kb.getToken()
    expect(/^[0-9a-f]{32}$/.test(token)).toBe(true)
    expect(d.calls).toContainEqual(['shell', `settings put global ${BRIDGE_TOKEN_SETTING} ${token}`])
    await d.kb.disable()
    expect(d.kb.getToken()).toBeNull()
    expect(d.calls).toContainEqual(['shell', `settings put global ${BRIDGE_TOKEN_SETTING} null`])
    await d.kb.enable()
    expect(d.kb.getToken()).not.toBe(token)
  })

  /** 让出期间不再抢：桌面那颗保持暗的，对账整轮空转（既不写也不改回 active）。 */
  it('park 之后整轮对账空转', async () => {
    const d = makeDevice()
    await d.kb.enable()
    expect(await d.kb.park()).toBe('parked')
    d.calls.length = 0
    d.setIme('com.baidu.input_mi/.ImeService')
    expect(await d.kb.reconcile()).toBe('parked')
    expect(d.calls).toEqual([])
  })

  /** ⚠️ 让出必须**把用户的输入法还回去**：我们这条没有键，占着归属不还原 = 手机上打不出字
   *  （10-11 用户原话「关不掉 mac 打字了，调不出来手机输入法」）。 */
  it('park 会把原输入法写回去并清掉 stash，同时撤掉夺回定时器', async () => {
    const d = makeDevice()
    await d.kb.enable()
    d.calls.length = 0
    expect(await d.kb.park()).toBe('parked')
    expect(d.ime).toBe('com.sohu.inputmethod.sogou.xiaomi/.SogouIME')
    expect(d.calls).toContainEqual(['write', 'com.sohu.inputmethod.sogou.xiaomi/.SogouIME'])
    expect(d.calls).toContainEqual(['shell', `rm -f ${STASH_FILE}`])
    expect(d.calls).toContainEqual(['clearTimer'])
  })

  /** 桌面再点一次 = 重新接管：抢回来、把 stash 补上、定时器也补上（否则之后被抢走没人管）。 */
  it('park 之后再 enable：重新接管并补回 stash 与定时器', async () => {
    const d = makeDevice()
    await d.kb.enable()
    await d.kb.park()
    d.calls.length = 0
    expect(await d.kb.enable()).toBe('active')
    expect(d.ime).toBe(MAC_KEYBOARD_IME)
    expect(d.calls).toContainEqual(['shell', `echo com.sohu.inputmethod.sogou.xiaomi/.SogouIME > ${STASH_FILE}`])
    await d.kb.disable()
    expect(d.ime).toBe('com.sohu.inputmethod.sogou.xiaomi/.SogouIME')
  })

  /** 10-11 用户报「关闭 mac 打字失效」的真因：dev 实例重启后内存里的归属没了，
   *  设备上却还是我们的输入法 ⇒ 页面查到 off、点一下又认不出原值 ⇒ 谁也关不掉。 */
  it('adopt：认领上一任没还原的残留，之后 disable 能还原', async () => {
    const d = makeDevice({ ime: MAC_KEYBOARD_IME, stash: 'com.iflytek.inputmethod.miui/.FlyIME' })
    expect(await d.kb.adopt()).toBe('active')
    expect(d.kb.getOriginal()).toBe('com.iflytek.inputmethod.miui/.FlyIME')
    // 认领时把原值补回设备侧那份（下一次再异常退出还有得捡）。
    expect(d.calls).toContainEqual(['shell', `echo com.iflytek.inputmethod.miui/.FlyIME > ${STASH_FILE}`])
    await d.kb.disable()
    expect(d.ime).toBe('com.iflytek.inputmethod.miui/.FlyIME')
  })

  it('adopt：设备不是我们的输入法时是空操作（不去管别人的键盘）', async () => {
    const d = makeDevice()
    expect(await d.kb.adopt()).toBe('off')
    expect(d.calls).toEqual([])
  })

  /** stash 也丢了（上一任被 kill 在写之前）：从设备上还启用的别的输入法里挑一个。 */
  it('stash 丢了就退到 `ime list` 里第一条别人的输入法，别让手机没键盘', async () => {
    const list = `${MAC_KEYBOARD_IME}\ncom.baidu.input_mi/.ImeService\ncom.sohu.inputmethod.sogou.xiaomi/.SogouIME`
    const d = makeDevice({ ime: MAC_KEYBOARD_IME, stash: '', imeList: list })
    expect(await d.kb.adopt()).toBe('active')
    expect(d.kb.getOriginal()).toBe('com.baidu.input_mi/.ImeService')
    await d.kb.disable()
    expect(d.ime).toBe('com.baidu.input_mi/.ImeService')
  })

  it('一个别的输入法都没有时不认领（不装懂，也别把设备写成没有键盘）', async () => {
    const d = makeDevice({ ime: MAC_KEYBOARD_IME, stash: '', imeList: MAC_KEYBOARD_IME })
    expect(await d.kb.adopt()).toBe('unavailable')
    expect(d.calls.filter((c) => c[0] === 'write')).toEqual([])
  })

  it('isSafeImeId：只放过包名/组件那副形状', () => {
    expect(isSafeImeId(MAC_KEYBOARD_IME)).toBe(true)
    expect(isSafeImeId('a/b')).toBe(true)
    expect(isSafeImeId(null)).toBe(false)
    expect(isSafeImeId('')).toBe(false)
    expect(isSafeImeId('a b')).toBe(false)
    expect(isSafeImeId('a;reboot')).toBe(false)
    expect(isSafeImeId('a`x`')).toBe(false)
    expect(isSafeImeId('a/../b')).toBe(true) // 路径不由它决定，字符集里没有空格/分号就进不了命令
  })
})
