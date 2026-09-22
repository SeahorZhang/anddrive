import { describe, expect, it } from 'vitest'

import {
  RESIZE_SETTLE_MS,
  aspectDiffers,
  createDisplayFollower,
  createReflowGate,
  displaySizeKey,
} from '../../src/mirror/displayFollow.js'

/** 让真实定时器 + promise 回调跑完（coalesceMs 为 0 的场景用）。 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

/** 手动时钟 + 定时器，便于断言合并窗口。 */
function createHarness({ settleMs = RESIZE_SETTLE_MS, lastSent = null } = {}) {
  const sent = []
  const intents = []
  const sents = []
  const skips = []
  const timers = new Map()
  let seq = 0
  let clock = 0

  const follower = createDisplayFollower({
    send: (size) => {
      sent.push(`${size.width}x${size.height}`)
    },
    onIntent: (size) => intents.push(`${size.width}x${size.height}`),
    onSent: (size) => sents.push(`${size.width}x${size.height}`),
    onSkip: () => skips.push(clock),
    settleMs,
    setTimer: (callback, ms) => {
      const id = ++seq
      timers.set(id, { callback, at: clock + ms })
      return id
    },
    clearTimer: (id) => timers.delete(id),
  })
  if (lastSent) follower.seed(lastSent)

  function advance(ms) {
    clock += ms
    const due = []
    for (const [id, timer] of timers) {
      if (timer.at <= clock) due.push(id)
    }
    for (const id of due) {
      const timer = timers.get(id)
      timers.delete(id)
      timer.callback()
    }
  }

  return { follower, sent, intents, sents, skips, advance, pendingTimers: () => timers.size }
}

describe('displaySizeKey', () => {
  it('formats a size and tolerates empty values', () => {
    expect(displaySizeKey({ width: 920, height: 1800 })).toBe('920x1800')
    expect(displaySizeKey(null)).toBe('')
    expect(displaySizeKey(undefined)).toBe('')
  })
})

describe('createDisplayFollower', () => {
  it('does not re-send the size already used to create the virtual display', () => {
    const { follower, sent, advance } = createHarness()
    follower.seed({ width: 920, height: 1800 })

    // 启动阶段：显式跟随请求 + ResizeObserver 首次回调，尺寸都与 seed 相同。
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_SETTLE_MS)
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_SETTLE_MS)

    expect(sent).toEqual([])
    expect(follower.lastSentKey).toBe('920x1800')
  })

  it('sends once when the size actually changes', () => {
    const { follower, sent, advance } = createHarness()
    follower.seed({ width: 920, height: 1800 })

    follower.request({ width: 1000, height: 1800 })
    expect(sent).toEqual([]) // 合并窗口内不下发
    advance(RESIZE_SETTLE_MS)

    expect(sent).toEqual(['1000x1800'])
    expect(follower.lastSentKey).toBe('1000x1800')
  })

  it('coalesces a burst of window resizes into the latest size', () => {
    const { follower, sent, advance } = createHarness()
    follower.seed({ width: 920, height: 1800 })

    follower.request({ width: 940, height: 1800 })
    follower.request({ width: 980, height: 1800 })
    follower.request({ width: 1020, height: 1800 })
    advance(RESIZE_SETTLE_MS)

    expect(sent).toEqual(['1020x1800'])
  })

  it('拖拽途中持续变化时一条都不发，停手后才发（debounce 而非 throttle）', () => {
    const { follower, sent, advance } = createHarness()
    follower.seed({ width: 920, height: 1800 })

    // 每 100ms 拖一次、共 8 次：都小于稳定窗口 250ms，所以全程不该下发。
    for (let i = 1; i <= 8; i += 1) {
      follower.request({ width: 920 + i * 120, height: 1800 })
      advance(100)
    }
    expect(sent).toEqual([])

    // 停手：超过稳定窗口后只发最终尺寸一次。
    advance(RESIZE_SETTLE_MS)
    expect(sent).toEqual(['1880x1800'])
  })

  it('skips a duplicate of the last sent size', () => {
    const { follower, sent, advance } = createHarness()
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_SETTLE_MS)
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_SETTLE_MS)

    expect(sent).toEqual(['920x1800'])
  })

  it('ignores invalid sizes and lets a failed send retry', async () => {
    const sent = []
    const skips = []
    const follower = createDisplayFollower({
      send: (size) => {
        sent.push(`${size.width}x${size.height}`)
        if (sent.length === 1) return Promise.reject(new Error('socket closed'))
        return undefined
      },
      onSkip: () => skips.push(sent.length),
      settleMs: 0,
    })

    follower.request({ width: 0, height: 0 })
    await settle()
    expect(sent).toEqual([])
    expect(skips).toEqual([0]) // 非法尺寸本来就会 skip

    follower.request({ width: 920, height: 1800 })
    await settle()
    expect(sent).toEqual(['920x1800'])
    // 下发失败也要回调 onSkip：页面据此撤遮罩，别让已 arm 的重排门闩干等 3s 兜底。
    expect(skips).toEqual([0, 1])

    // 第一次下发失败后记录被清空，同样的尺寸允许重试。
    follower.request({ width: 920, height: 1800 })
    await settle()
    expect(sent).toEqual(['920x1800', '920x1800'])
    expect(skips).toEqual([0, 1])
  })

  it('onSent 先于 send：同步抛错也回滚并回调 onSkip', async () => {
    const sent = []
    const skips = []
    const sents = []
    const follower = createDisplayFollower({
      send: (size) => {
        sent.push(`${size.width}x${size.height}`)
        throw new Error('control socket gone')
      },
      onSent: (size) => sents.push(`${size.width}x${size.height}`),
      onSkip: () => skips.push(1),
      settleMs: 0,
    })

    follower.request({ width: 920, height: 1800 })
    await settle()
    expect(sents).toEqual(['920x1800'])
    expect(skips).toEqual([1])
    expect(follower.lastSentKey).toBe('')
  })

  it('reports every size change as intent, while the burst is still merging', () => {
    const { follower, sent, intents, advance } = createHarness()
    follower.seed({ width: 920, height: 1800 })

    // 遮罩要在手一拖就盖上，所以「要改尺寸」这件事必须逐次上报，不能等合并窗口结束。
    follower.request({ width: 1000, height: 1800 })
    follower.request({ width: 1100, height: 1800 })
    expect(intents).toEqual(['1000x1800', '1100x1800'])
    expect(sent).toEqual([])

    advance(RESIZE_SETTLE_MS)
    expect(sent).toEqual(['1100x1800'])
  })

  it('reports a skip when the merged burst turns out to need no resize', () => {
    // 拖出去又拖回原尺寸：盖了遮罩，但根本不会下发 resize，得告诉页面撤掉。
    const { follower, sent, skips, advance } = createHarness({ lastSent: { width: 920, height: 1800 } })

    follower.request({ width: 1100, height: 1800 })
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_SETTLE_MS)

    expect(sent).toEqual([])
    expect(skips).toHaveLength(1)
  })

  it('does not report a skip when the burst dispatches', () => {
    const { follower, sent, skips, advance } = createHarness({ lastSent: { width: 920, height: 1800 } })

    follower.request({ width: 1100, height: 1800 })
    advance(RESIZE_SETTLE_MS)

    expect(sent).toEqual(['1100x1800'])
    expect(skips).toEqual([])
  })

  it('drops pending requests on dispose', () => {
    const { follower, sent, advance, pendingTimers } = createHarness()
    follower.request({ width: 920, height: 1800 })
    follower.dispose()

    expect(pendingTimers()).toBe(0)
    advance(1000)
    expect(sent).toEqual([])
  })

  it('onSent 只在真的下发时回调，被合并/被丢弃的意图不算', () => {
    const { follower, sent, intents, sents, advance } = createHarness()
    follower.seed({ width: 920, height: 1800 })

    // 拖出去又拖回来：有意图，但最终尺寸没变 → 不该 arm 重排门闩。
    follower.request({ width: 1000, height: 1800 })
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_SETTLE_MS)
    expect(intents.length).toBe(2)
    expect(sent).toEqual([])
    expect(sents).toEqual([])

    follower.request({ width: 1100, height: 1800 })
    follower.request({ width: 1200, height: 1800 })
    advance(RESIZE_SETTLE_MS)
    expect(sents).toEqual(['1200x1800']) // 一次拖拽只发一条
  })
})

describe('createReflowGate', () => {
  it('重排后要凑齐 configuration + 关键帧这一对才算完成', () => {
    const gate = createReflowGate()
    expect(gate.isWaiting()).toBe(false)

    gate.arm()
    expect(gate.isWaiting()).toBe(true)
    // 早到的关键帧（上一个 GOP 的）不作数：必须先看到新的 configuration 包。
    expect(gate.keyFrame()).toBe(false)
    gate.configuration()
    expect(gate.keyFrame()).toBe(true)
    expect(gate.isWaiting()).toBe(false)
    // 了结之后再来的关键帧不再报告满足，避免页面反复收尾。
    expect(gate.keyFrame()).toBe(false)
  })

  it('没 arm 时收包不产生任何效果', () => {
    const gate = createReflowGate()
    gate.configuration()
    expect(gate.keyFrame()).toBe(false)
    expect(gate.isWaiting()).toBe(false)
  })

  it('reset 清账（撤遮罩 / 换会话）', () => {
    const gate = createReflowGate()
    gate.arm()
    gate.configuration()
    gate.reset()
    expect(gate.isWaiting()).toBe(false)
    expect(gate.keyFrame()).toBe(false)
  })
})

describe('aspectDiffers', () => {
  it('比例明显变了才算需要重排', () => {
    expect(aspectDiffers(1.6, 0.5)).toBe(true)
    expect(aspectDiffers(0.5, 0.5)).toBe(false)
    expect(aspectDiffers(0.505, 0.5)).toBe(false) // 容差内的抖动不值得盖一次
    expect(aspectDiffers(0.56, 0.5)).toBe(true)
  })

  it('未知比例不触发', () => {
    expect(aspectDiffers(0, 0.5)).toBe(false)
    expect(aspectDiffers(0.5, 0)).toBe(false)
    expect(aspectDiffers(NaN, 0.5)).toBe(false)
  })
})
