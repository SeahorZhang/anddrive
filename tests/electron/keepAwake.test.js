import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KEY_STAY_ON, STAY_ON_ALL, startKeepAwake } from '../../electron/mirror/keepAwake.js'

// keepAwake 动的是**用户设备上的设置**（`Settings.Global.stay_on_while_plugged_in`），
// 所以这里的判据全是「写了几次、写的是什么、还原成什么」：
// 少还原一次 = 用户的手机从此插电就不息屏，多写一次 = 撤掉别的窗口还在用的保活。

/** 一台设备一份假状态：`current` 是它现在的值，`reads/writes` 记录调用。 */
function fakeDevice({ current = 0, readOk = true, writeOk = true } = {}) {
  const calls = { reads: [], writes: [] }
  return {
    calls,
    get value() {
      return current
    },
    deps: (serial) => ({
      serial,
      read: async (key) => {
        calls.reads.push(key)
        return readOk ? current : null
      },
      write: async (key, mask) => {
        calls.writes.push([key, mask])
        if (writeOk) current = mask
        return writeOk
      },
    }),
  }
}

describe('keepAwake（镜像期间插电不休眠）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('开会话写 7（AC|USB|无线），关到最后一个会话还原成读来的原值', async () => {
    const device = fakeDevice({ current: 0 })
    const restore = await startKeepAwake(device.deps('dev-a'))
    expect(device.calls.writes).toEqual([[KEY_STAY_ON, STAY_ON_ALL]])
    expect(device.value).toBe(STAY_ON_ALL)
    await restore()
    expect(device.calls.writes).toEqual([
      [KEY_STAY_ON, STAY_ON_ALL],
      [KEY_STAY_ON, 0],
    ])
    expect(device.value).toBe(0)

    // 用户自己开着「插电不息屏」（比如 1）时不能被我们写成 0。
    const mine = fakeDevice({ current: 1 })
    const restore2 = await startKeepAwake(mine.deps('dev-b'))
    await restore2()
    expect(mine.calls.writes).toEqual([
      [KEY_STAY_ON, STAY_ON_ALL],
      [KEY_STAY_ON, 1],
    ])
    expect(mine.value).toBe(1)
  })

  it('同一台设备两个会话：第二个不重读不重写，只关第一个时不还原', async () => {
    const device = fakeDevice({ current: 0 })
    const first = await startKeepAwake(device.deps('dev-two'))
    expect(device.calls.reads).toEqual([KEY_STAY_ON])
    expect(device.calls.writes).toEqual([[KEY_STAY_ON, STAY_ON_ALL]])

    const second = await startKeepAwake(device.deps('dev-two'))
    // 关键：第二个会话既不读也不写（读会读到 7，之后还原成 7 就把用户的值钉死了）
    expect(device.calls.reads).toEqual([KEY_STAY_ON])
    expect(device.calls.writes).toEqual([[KEY_STAY_ON, STAY_ON_ALL]])

    await first()
    expect(device.calls.writes).toEqual([[KEY_STAY_ON, STAY_ON_ALL]])
    expect(device.value).toBe(STAY_ON_ALL)

    await second()
    expect(device.calls.writes.at(-1)).toEqual([KEY_STAY_ON, 0])
    expect(device.value).toBe(0)
  })

  it('还原只生效一次（关窗与断开设备都会调它，别写两遍）', async () => {
    const device = fakeDevice({ current: 0 })
    const restore = await startKeepAwake(device.deps('dev-once'))
    await restore()
    await restore()
    expect(device.calls.writes).toEqual([
      [KEY_STAY_ON, STAY_ON_ALL],
      [KEY_STAY_ON, 0],
    ])
  })

  it('读不到原值就一个字节都不写：没法还原的东西不碰', async () => {
    const device = fakeDevice({ readOk: false })
    const restore = await startKeepAwake(device.deps('dev-blind'))
    expect(device.calls.writes).toEqual([])
    expect(device.value).toBe(0)
    await restore()
    expect(device.calls.writes).toEqual([])
  })

  it('写失败时不登记还原（不会事后把设备写成 0）', async () => {
    const device = fakeDevice({ current: 3, writeOk: false })
    const restore = await startKeepAwake(device.deps('dev-refused'))
    expect(device.calls.writes).toEqual([[KEY_STAY_ON, STAY_ON_ALL]])
    await restore()
    // 只有那一次失败的写，没有事后凭空冒出的「还原」。
    expect(device.calls.writes).toEqual([[KEY_STAY_ON, STAY_ON_ALL]])
  })

  /** 第一个会话还在「读原值 + 写 7」的路上，第二个就进来了 —— 它必须挂到同一次改写后面。 */
  it('读写未完成时第二个会话进来：只读一次、只写一次，还原也只一次', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const writes = []
    const reads = []
    const deps = (serial) => ({
      serial,
      read: async (key) => {
        reads.push(key)
        await gate
        return 0
      },
      write: async (key, mask) => {
        writes.push(mask)
        return true
      },
    })

    const first = startKeepAwake(deps('dev-race'))
    const second = startKeepAwake(deps('dev-race'))
    release()
    const [restoreFirst, restoreSecond] = await Promise.all([first, second])

    expect(reads).toEqual([KEY_STAY_ON])
    expect(writes).toEqual([STAY_ON_ALL])

    await restoreFirst()
    expect(writes).toEqual([STAY_ON_ALL])
    await restoreSecond()
    expect(writes).toEqual([STAY_ON_ALL, 0])
  })
})
