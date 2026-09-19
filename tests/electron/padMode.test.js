import { describe, expect, it } from 'vitest'

import { createPadMode, PAD_PROBE_DISPLAY } from '../../electron/mirror/padMode.js'

/**
 * 假设备：记录调用顺序，几何状态在第 `padAtAttempt` 次轮询时才变成 pad 横屏铺满。
 * 轮询预算压到 3 次（probeTimeoutMs 3 / probeIntervalMs 1），sleep 瞬时，测试不真等。
 */
function createHarness({ compatOk = true, padAtAttempt = 1 } = {}) {
  const calls = []
  const timers = new Map()
  const state = { probes: 0 }
  let seq = 0

  const padMode = createPadMode({
    setCompat: async (_serial, _pkg, enabled) => {
      calls.push(`compat:${enabled ? 'enable' : 'reset'}`)
      return compatOk ? { ok: true } : { ok: false, message: 'Unknown or invalid change' }
    },
    overrideGeometry: async (_serial, box) => {
      calls.push(`wm:${box.width}x${box.height}/${box.dpi}`)
    },
    resetGeometry: async () => {
      calls.push('wm:reset')
    },
    forceStop: async () => {
      calls.push('force-stop')
    },
    launch: async () => {
      calls.push('launch')
    },
    geometry: async () => {
      state.probes += 1
      calls.push('probe')
      return state.probes >= padAtAttempt
        ? { full: true, landscape: true }
        : { full: false, landscape: false }
    },
    sleep: async () => {},
    setTimer: (callback, ms) => {
      seq += 1
      timers.set(seq, callback)
      return seq
    },
    clearTimer: (id) => timers.delete(id),
    log: () => {},
    probeIntervalMs: 1,
    probeTimeoutMs: 3,
  })

  return { calls, timers, padMode }
}

describe('createPadMode', () => {
  it('enter 按配方顺序跑，成功后先不还原物理屏（等渲染层 settle）', async () => {
    const { calls, padMode } = createHarness()

    await expect(padMode.enter('serial-a', 'com.ss.android.ugc.aweme')).resolves.toBe(true)
    expect(calls).toEqual([
      'compat:enable',
      `wm:${PAD_PROBE_DISPLAY.width}x${PAD_PROBE_DISPLAY.height}/${PAD_PROBE_DISPLAY.dpi}`,
      'force-stop',
      'launch',
      'probe',
    ])
    expect(padMode.pendingSettle()).toBe(1)
  })

  it('settle 还原物理屏，且幂等', async () => {
    const { calls, padMode } = createHarness()
    await padMode.enter('serial-a', 'p')

    padMode.settle('serial-a')
    padMode.settle('serial-a')
    expect(calls.filter((c) => c === 'wm:reset')).toHaveLength(1)
    expect(padMode.pendingSettle()).toBe(0)
  })

  it('渲染层没来 settle 时，超时兜底自己还原物理屏', async () => {
    const { calls, timers, padMode } = createHarness()
    await padMode.enter('serial-a', 'p')

    for (const fire of timers.values()) fire()
    expect(calls).toContain('wm:reset')
    expect(padMode.pendingSettle()).toBe(0)
  })

  it('设备不认识这条 compat 时直接放弃，不碰物理屏也不重启 app', async () => {
    const { calls, padMode } = createHarness({ compatOk: false })

    await expect(padMode.enter('serial-a', 'p')).resolves.toBe(false)
    expect(calls).toEqual(['compat:enable'])
    expect(padMode.tracked()).toBe(0)
  })

  it('等不到 app 进 pad 就回滚：还原物理屏 + compat', async () => {
    const { calls, padMode } = createHarness({ padAtAttempt: 99 })

    await expect(padMode.enter('serial-a', 'p')).resolves.toBe(false)
    expect(calls).toContain('wm:reset')
    expect(calls).toContain('compat:reset')
    expect(calls.filter((c) => c === 'probe')).toHaveLength(3)
    expect(padMode.pendingSettle()).toBe(0)
  })

  it('同设备同包按会话引用计数，最后一个 exit 才还原 compat', async () => {
    const { calls, padMode } = createHarness()

    expect(await padMode.enter('serial-a', 'p')).toBe(true)
    expect(await padMode.enter('serial-a', 'p')).toBe(true)
    expect(calls.filter((c) => c === 'compat:enable')).toHaveLength(1)

    await padMode.exit('serial-a', 'p')
    expect(calls).not.toContain('compat:reset')
    await padMode.exit('serial-a', 'p')
    expect(calls).toContain('compat:reset')
    expect(padMode.tracked()).toBe(0)
  })

  it('没进过大屏模式的包，exit 不会多发一次 reset', async () => {
    const { calls, padMode } = createHarness()

    await padMode.exit('serial-a', 'p')
    expect(calls).toEqual([])
  })
})
