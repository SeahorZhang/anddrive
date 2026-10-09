import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FROZEN_STATES, createSleepWatcher } from '../../src/mirror/sleepWatch.js'

// 「已休眠」横幅的唯一判据是设备上的 `mWakefulness`。这里钉的是**什么时候才该弹**：
// 弹错一次（把 HyperOS 的 `Hangup` 当休眠）就是在一幅还在动的画面上盖一块黑。

/** 把 fake timers 的每个 tick 跑完。 */
async function tick(ms) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('createSleepWatcher（镜像窗口的休眠轮询）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('醒→睡报一次，中间不重复报；睡→醒再报一次', async () => {
    const states = ['Awake', 'Awake', 'Asleep', 'Asleep', 'Dozing', 'Awake']
    const seen = []
    const stop = createSleepWatcher({
      read: async () => states.shift(),
      onChange: (asleep) => seen.push(asleep),
      intervalMs: 1000,
    })
    for (let i = 0; i < 6; i += 1) await tick(1000)
    expect(seen).toEqual([true, false])
    stop()
  })

  /** `Hangup` 是 HyperOS 投屏登记过的灭屏态：面板灭着仍继续合成，画面没定住。 */
  it('Hangup 不算休眠', async () => {
    const seen = []
    const stop = createSleepWatcher({
      read: async () => 'Hangup',
      onChange: (asleep) => seen.push(asleep),
      intervalMs: 1000,
    })
    await tick(1000)
    await tick(1000)
    expect(seen).toEqual([])
    stop()
  })

  /** 一次 adb 失败不能谎报休眠：横幅弹出来却点不动更糟。 */
  it('读不到状态（null 或抛错）时不报、也不打断后面的轮询', async () => {
    let n = 0
    const seen = []
    const stop = createSleepWatcher({
      read: async () => {
        n += 1
        if (n === 1) return null
        if (n === 2) throw new Error('adb offline')
        return 'Asleep'
      },
      onChange: (asleep) => seen.push(asleep),
      intervalMs: 1000,
    })
    for (let i = 0; i < 3; i += 1) await tick(1000)
    expect(seen).toEqual([true])
    stop()
  })

  it('窗口不可见时不去打扰设备', async () => {
    let reads = 0
    const stop = createSleepWatcher({
      read: async () => {
        reads += 1
        return 'Asleep'
      },
      onChange: () => {},
      intervalMs: 1000,
      shouldSkip: () => true,
    })
    await tick(3000)
    expect(reads).toBe(0)
    stop()
  })

  it('停止后不再读（关会话要真把轮询摘掉）', async () => {
    let reads = 0
    const stop = createSleepWatcher({
      read: async () => {
        reads += 1
        return 'Awake'
      },
      onChange: () => {},
      intervalMs: 1000,
    })
    await tick(1000)
    stop()
    await tick(3000)
    expect(reads).toBe(1)
  })

  it('判睡的是 Asleep / Dozing 这两个状态', () => {
    expect([...FROZEN_STATES].sort()).toEqual(['Asleep', 'Dozing'])
  })
})
