import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FROZEN_STATES, createSleepWatcher, panelIsOff } from '../../src/mirror/sleepWatch.js'

// 「已休眠」横幅与长条上那颗「关屏使用」的唯一判据是设备上的两条一手读数：
// `mWakefulness`（睡没睡）和 SurfaceFlinger 的 `powerMode`（面板亮没亮）。这里钉三件事：
// ① **什么时候才该弹横幅**（弹错一次 = 在一幅还在动的画面上盖一块黑，比如 HyperOS 的 `Hangup`）；
// ② **两条读数任一变了都要报**（用户 10-10「关掉屏幕按钮再点一次要可以点亮」：`setDisplayPower(OFF)`
//    只灭面板，设备还 `Awake` —— 只看 `mWakefulness` 的话那颗按钮永远翻不回来）；
// ③ **点了按钮之后要多快看到结果**（10-10「不灵敏」：原来只有慢轮询，撤个横幅要等下一拍）。

/** 一次读数。缺省只给 `wakefulness`（另一条读不到＝ null）。 */
const st = (wakefulness, screen = null) => ({ wakefulness, screen })

/** 把 fake timers 的每个 tick 跑完。 */
async function tick(ms) {
  await vi.advanceTimersByTimeAsync(ms)
}

function spy(read, extra = {}) {
  const seen = []
  const handle = createSleepWatcher({
    read,
    onChange: (asleep, state) => seen.push([asleep, state]),
    intervalMs: 1000,
    fastMs: 200,
    fastWindowMs: 1000,
    ...extra,
  })
  return { seen, ...handle }
}

describe('createSleepWatcher（镜像窗口的电源状态轮询）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 开窗那一刻手机已经睡着：第一读必须报出来，否则「已休眠」永远不弹（页面上没有任何入口能唤醒）。 */
  it('第一次读就报（设备已睡时开窗也要弹横幅）', async () => {
    const { seen, stop } = spy(async () => st('Asleep', 'OFF'))
    await tick(1000)
    expect(seen).toEqual([[true, st('Asleep', 'OFF')]])
    stop()
  })

  it('读数一变就报（睡→醒各一次），中间不重复报', async () => {
    const states = ['Awake', 'Awake', 'Asleep', 'Asleep', 'Dozing', 'Awake']
    const { seen, stop } = spy(async () => st(states.shift() ?? 'Awake', 'ON'))
    for (let i = 0; i < 6; i += 1) await tick(1000)
    // Awake 报了（与页面初值相同，无副作用）→ 变 Asleep 报 → Dozing 读数变了也报（横幅状态不变）→ 醒报
    expect(seen.map(([asleep, s]) => [asleep, s.wakefulness])).toEqual([
      [false, 'Awake'],
      [true, 'Asleep'],
      [true, 'Dozing'],
      [false, 'Awake'],
    ])
    stop()
  })

  /** 「关屏使用」走的是 scrcpy 的 `setDisplayPower(OFF)`：面板灭、设备不睡，`mWakefulness` 一动不动。 */
  it('只有面板变了也报（关屏使用时设备还 Awake，靠 screen 认屏灭）', async () => {
    const states = ['ON', 'ON', 'OFF', 'OFF', 'ON']
    const { seen, stop } = spy(async () => st('Awake', states.shift()))
    for (let i = 0; i < 5; i += 1) await tick(1000)
    // 报出来的是「屏灭 / 屏亮」这两次变化，`asleep` 全程 false ⇒ 不会弹「已休眠」盖住还在合成的画面。
    expect(seen.map(([asleep, s]) => [asleep, s.screen])).toEqual([
      [false, 'ON'],
      [false, 'OFF'],
      [false, 'ON'],
    ])
    stop()
  })

  /** `Hangup` 是 HyperOS/MIUI 投屏登记过的灭屏态：面板灭着仍继续合成，画面没定住。 */
  it('Hangup 不算休眠（不弹「已休眠」），但原值照样报出去', async () => {
    const states = [st('Awake', 'ON'), st('Hangup', 'OFF')]
    const { seen, stop } = spy(async () => states.shift() ?? st('Hangup', 'OFF'))
    await tick(2000)
    // 第一个值是 false ⇒ 页面不会因此弹「已休眠」；第二个是原读数 ⇒ 那颗图标据此画「恢复亮屏」。
    expect(seen).toEqual([
      [false, st('Awake', 'ON')],
      [false, st('Hangup', 'OFF')],
    ])
    stop()
  })

  /** 一次 adb 失败不能谎报休眠：横幅弹出来却点不动更糟；也不能把轮询链打断。 */
  it('读不到状态（null 或抛错）时不报、也不打断后面的轮询', async () => {
    let n = 0
    const { seen, stop } = spy(async () => {
      n += 1
      if (n === 1) return null
      if (n === 2) throw new Error('adb offline')
      return st('Asleep', 'OFF')
    })
    for (let i = 0; i < 3; i += 1) await tick(1000)
    // 前两拍没读数 ⇒ 第一报落在第 3 拍上。
    expect(seen).toEqual([[true, st('Asleep', 'OFF')]])
    stop()
  })

  /** 两条字段全空（adb 通了但 grep 没命中）同样当「不知道」。 */
  it('读回来两条都是空时不报，下一拍有数照报', async () => {
    let n = 0
    const { seen, stop } = spy(async () => {
      n += 1
      return n === 1 ? st(null, null) : st('Dozing', 'DOZE')
    })
    for (let i = 0; i < 2; i += 1) await tick(1000)
    expect(seen).toEqual([[true, st('Dozing', 'DOZE')]])
    stop()
  })

  it('基线立起来之后的失败读数不影响，恢复后照常报', async () => {
    let n = 0
    const { seen, stop } = spy(async () => {
      n += 1
      if (n === 2) return null
      return n === 1 ? st('Awake', 'ON') : st('Asleep', 'OFF')
    })
    for (let i = 0; i < 3; i += 1) await tick(1000)
    expect(seen).toEqual([
      [false, st('Awake', 'ON')],
      [true, st('Asleep', 'OFF')],
    ])
    stop()
  })

  /** 用户点「继续使用 / 关屏使用」之后不该等下一拍慢轮询（10-10「不灵敏」）。 */
  it('kick 之后立刻读一次，并在窗口期里读得比慢档密', async () => {
    let kicked = 0
    let idle = 0
    const a = spy(async () => {
      kicked += 1
      return st('Awake', 'ON')
    })
    const b = spy(async () => {
      idle += 1
      return st('Awake', 'ON')
    })
    await tick(1000) // 两边各定一次基线
    kicked = 0
    idle = 0
    a.kick()
    await tick(600)
    expect(kicked).toBeGreaterThan(0) // 立刻那一次，不等下一拍
    expect(kicked).toBeGreaterThan(idle) // 快档明显比慢档密
    a.stop()
    b.stop()
  })

  it('快档窗口期自己过掉，回到慢档（不会一直凶地打 adb）', async () => {
    let reads = 0
    const { kick, stop } = spy(async () => {
      reads += 1
      return st('Awake', 'ON')
    })
    await tick(1000)
    reads = 0
    kick()
    await tick(2000)
    const duringFast = reads // 窗口期 1s：立刻 + 200/400/600/800 + 1000/2000 ≈ 7 次
    reads = 0
    await tick(4000) // 已经回到 1s 一档
    expect(duringFast).toBeGreaterThanOrEqual(5)
    expect(reads).toBeLessThanOrEqual(5)
    stop()
  })

  it('窗口不可见时不去打扰设备', async () => {
    let reads = 0
    const { stop } = spy(
      async () => {
        reads += 1
        return st('Asleep', 'OFF')
      },
      { shouldSkip: () => true },
    )
    await tick(3000)
    expect(reads).toBe(0)
    stop()
  })

  it('停止后不再读、kick 也不再生效（关会话要真把轮询摘掉）', async () => {
    let reads = 0
    const { kick, stop } = spy(async () => {
      reads += 1
      return st('Awake', 'ON')
    })
    await tick(1000)
    stop()
    await tick(3000)
    kick()
    await tick(3000)
    expect(reads).toBe(1)
  })

  it('判睡的是 Asleep / Dozing 这两个状态', () => {
    expect([...FROZEN_STATES].sort()).toEqual(['Asleep', 'Dozing'])
  })
})

/**
 * 长条那颗「关屏使用 / 恢复亮屏」的判据。用户 10-10 那条「关掉屏幕按钮再点一次要可以点亮」
 * 就是它只看 `mWakefulness` 造成的：`setDisplayPower(OFF)` 设备全程 `Awake`。
 */
describe('panelIsOff（那颗图标的屏灭判据）', () => {
  it('设备醒着但面板灭着 = 屏灭（关屏使用中，按钮该翻成「恢复亮屏」）', () => {
    expect(panelIsOff(st('Awake', 'OFF'))).toBe(true)
    expect(panelIsOff(st('Awake', 'DOZE'))).toBe(true)
    // MIUI 按电源键那个态：不算休眠，但屏是灭的
    expect(panelIsOff(st('Hangup', 'OFF'))).toBe(true)
  })

  it('醒着且面板亮着 = 没灭', () => {
    expect(panelIsOff(st('Awake', 'ON'))).toBe(false)
  })

  it('睡了就算屏灭（横幅与图标一起翻）', () => {
    expect(panelIsOff(st('Asleep', 'ON'))).toBe(true)
    expect(panelIsOff(st('Dozing', 'DOZE'))).toBe(true)
  })

  /** 有些 ROM 的 SurfaceFlinger 不 dump `powerMode` ⇒ 退回只按睡没睡判，不能因为缺读数就当屏亮。 */
  it('面板读数缺失时退回睡没睡', () => {
    expect(panelIsOff(st('Awake', null))).toBe(false)
    expect(panelIsOff(st('Asleep', null))).toBe(true)
  })
})
