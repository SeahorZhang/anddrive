import { describe, expect, it } from 'vitest'

const {
  createReadWindowCache,
  planWindowFetch,
  SMALL_WINDOW_BYTES,
  SEQUENTIAL_WINDOW_BYTES,
} = await import(
  '../../electron/readWindow.js'
)

const buf = (size, fill = 1) => Buffer.alloc(size, fill)
const MAX = 8 * 1024 * 1024

describe('planWindowFetch', () => {
  // 这条规则是为图片夹写的：以前小请求也按 2 MB 起取，开一次 24 张的相册
  // 要 3 MB 真需求却从手机上拉了 48 MB。把下限写回 WINDOW_BYTES/4 立刻红。
  it('零散的小读只取它要的，不陪葬整窗', () => {
    expect(planWindowFetch({ length: 128 * 1024, sequential: false, maxBytes: MAX })).toBe(SMALL_WINDOW_BYTES)
    expect(planWindowFetch({ length: 64 * 1024, sequential: false, maxBytes: MAX })).toBe(SMALL_WINDOW_BYTES)
  })

  it('顺序续读按 2 MB 档取（每 64 KB 回一次源比多取更贵），但仍不到大窗', () => {
    expect(planWindowFetch({ length: 64 * 1024, sequential: true, maxBytes: MAX })).toBe(SEQUENTIAL_WINDOW_BYTES)
    expect(planWindowFetch({ length: 64 * 1024, sequential: true, maxBytes: SEQUENTIAL_WINDOW_BYTES })).toBe(
      SEQUENTIAL_WINDOW_BYTES,
    )
  })

  it('请求本身就大时按请求走，但绝不超过大窗', () => {
    expect(planWindowFetch({ length: 4 * 1024 * 1024, sequential: false, maxBytes: MAX })).toBe(4 * 1024 * 1024)
    expect(planWindowFetch({ length: 20 * 1024 * 1024, sequential: true, maxBytes: MAX })).toBe(MAX)
  })

  it('没有长度时按各自的档位取', () => {
    expect(planWindowFetch({ length: undefined, sequential: false, maxBytes: MAX })).toBe(SMALL_WINDOW_BYTES)
    expect(planWindowFetch({ length: undefined, sequential: true, maxBytes: MAX })).toBe(SEQUENTIAL_WINDOW_BYTES)
  })
})

describe('createReadWindowCache', () => {
  it('窗内任意偏移都命中，且拿到的就是那一段', () => {
    const cache = createReadWindowCache({ budgetBytes: 4096 })
    cache.store('k', 100, buf(1024, 7))
    const slice = cache.hit('k', 100 + 64, 32)
    expect(slice.length).toBe(32)
    expect(slice[0]).toBe(7)
  })

  it('越过窗尾就是未命中（不能让客户端拿到错的数据）', () => {
    const cache = createReadWindowCache({ budgetBytes: 4096 })
    cache.store('k', 0, buf(1024))
    expect(cache.hit('k', 1000, 100)).toBeNull()
    expect(cache.hit('k', -100, 10)).toBeNull()
    expect(cache.hit('other', 0, 10)).toBeNull()
  })

  // 回归：这条曾经写成"只比长度"，于是换偏移量的新窗被旧窗挡下 ——
  // 越过第一窗之后每个请求都重取一整块又被丢弃，播放式读从 4.9 MB/s 掉到 0.3 MB/s。
  it('换起点的新窗必须替换旧窗，不被"更大"这条规则挡掉', () => {
    const cache = createReadWindowCache({ budgetBytes: 4096 })
    cache.store('k', 0, buf(1024, 1))
    cache.store('k', 2048, buf(1024, 2))
    expect(cache.hit('k', 0, 10)).toBeNull()
    expect(cache.hit('k', 2048, 10)[0]).toBe(2)
  })

  it('同一窗口的更小切片不许把它盖掉（物化分块会走到这条）', () => {
    const cache = createReadWindowCache({ budgetBytes: 4096 })
    cache.store('k', 0, buf(1024, 1))
    cache.store('k', 0, buf(10, 9))
    expect(cache.hit('k', 500, 10)[0]).toBe(1)
  })

  it('超出预算按最久没碰的丢，刚命中过的往后站', () => {
    const cache = createReadWindowCache({ budgetBytes: 200 })
    cache.store('a', 0, buf(100))
    cache.store('b', 0, buf(100))
    cache.hit('a', 0, 10) // a 变成最近使用
    cache.store('c', 0, buf(100))
    expect(cache.hit('b', 0, 10)).toBeNull()
    expect(cache.hit('a', 0, 10)).not.toBeNull()
    expect(cache.hit('c', 0, 10)).not.toBeNull()
    expect(cache.heldBytes).toBeLessThanOrEqual(200)
  })

  // 播放器的"接着读"就靠这个尾部判断，判断错了大窗就永远开不起来。
  it('end 给的是当前窗的尾部偏移，换窗就跟着换', () => {
    const cache = createReadWindowCache({ budgetBytes: 4096 })
    expect(cache.end('k')).toBeNull()
    cache.store('k', 100, buf(1024))
    expect(cache.end('k')).toBe(1124)
    cache.store('k', 2048, buf(512))
    expect(cache.end('k')).toBe(2560)
    cache.drop('k')
    expect(cache.end('k')).toBeNull()
  })

  it('drop 与 clear 立刻让窗口失效', () => {    const cache = createReadWindowCache({ budgetBytes: 1000 })
    cache.store('a', 0, buf(100))
    cache.drop('a')
    expect(cache.hit('a', 0, 10)).toBeNull()
    cache.store('a', 0, buf(100))
    cache.store('b', 0, buf(100))
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.heldBytes).toBe(0)
  })
})
