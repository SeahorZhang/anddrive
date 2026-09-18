import { describe, expect, it } from 'vitest'

import { RESIZE_COALESCE_MS, createDisplayFollower, displaySizeKey } from '../../src/mirror/displayFollow.js'

/** 让真实定时器 + promise 回调跑完（coalesceMs 为 0 的场景用）。 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

/** 手动时钟 + 定时器，便于断言合并窗口。 */
function createHarness({ coalesceMs = RESIZE_COALESCE_MS } = {}) {
  const sent = []
  const timers = new Map()
  let seq = 0
  let clock = 0

  const follower = createDisplayFollower({
    send: (size) => {
      sent.push(`${size.width}x${size.height}`)
    },
    coalesceMs,
    setTimer: (callback, ms) => {
      const id = ++seq
      timers.set(id, { callback, at: clock + ms })
      return id
    },
    clearTimer: (id) => timers.delete(id),
  })

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

  return { follower, sent, advance, pendingTimers: () => timers.size }
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
    advance(RESIZE_COALESCE_MS)
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_COALESCE_MS)

    expect(sent).toEqual([])
    expect(follower.lastSentKey).toBe('920x1800')
  })

  it('sends once when the size actually changes', () => {
    const { follower, sent, advance } = createHarness()
    follower.seed({ width: 920, height: 1800 })

    follower.request({ width: 1000, height: 1800 })
    expect(sent).toEqual([]) // 合并窗口内不下发
    advance(RESIZE_COALESCE_MS)

    expect(sent).toEqual(['1000x1800'])
    expect(follower.lastSentKey).toBe('1000x1800')
  })

  it('coalesces a burst of window resizes into the latest size', () => {
    const { follower, sent, advance } = createHarness()
    follower.seed({ width: 920, height: 1800 })

    follower.request({ width: 940, height: 1800 })
    follower.request({ width: 980, height: 1800 })
    follower.request({ width: 1020, height: 1800 })
    advance(RESIZE_COALESCE_MS)

    expect(sent).toEqual(['1020x1800'])
  })

  it('skips a duplicate of the last sent size', () => {
    const { follower, sent, advance } = createHarness()
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_COALESCE_MS)
    follower.request({ width: 920, height: 1800 })
    advance(RESIZE_COALESCE_MS)

    expect(sent).toEqual(['920x1800'])
  })

  it('ignores invalid sizes and lets a failed send retry', async () => {
    const sent = []
    const follower = createDisplayFollower({
      send: (size) => {
        sent.push(`${size.width}x${size.height}`)
        if (sent.length === 1) return Promise.reject(new Error('socket closed'))
        return undefined
      },
      coalesceMs: 0,
    })

    follower.request({ width: 0, height: 0 })
    await settle()
    expect(sent).toEqual([])

    follower.request({ width: 920, height: 1800 })
    await settle()
    expect(sent).toEqual(['920x1800'])

    // 第一次下发失败后记录被清空，同样的尺寸允许重试。
    follower.request({ width: 920, height: 1800 })
    await settle()
    expect(sent).toEqual(['920x1800', '920x1800'])
  })

  it('drops pending requests on dispose', () => {
    const { follower, sent, advance, pendingTimers } = createHarness()
    follower.request({ width: 920, height: 1800 })
    follower.dispose()

    expect(pendingTimers()).toBe(0)
    advance(1000)
    expect(sent).toEqual([])
  })
})
