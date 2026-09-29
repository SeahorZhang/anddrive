import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { rangeSlice, cacheKey, createFileCache, MATERIALIZE_MAX_BYTES, MATERIALIZE_CHUNK } = await import(
  '../../electron/fileCache.js'
)

const meta = { serial: 'S1', path: '/sdcard/a.bin', size: 10, mtimeMs: 111 }
const bytesOf = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const whole = (payload) => async (start, length) => payload.subarray(start, start + length)

describe('rangeSlice', () => {
  it('把 Range 夹进文件长度内', () => {
    expect(rangeSlice(100, 0, 10)).toEqual({ start: 0, end: 9 })
    expect(rangeSlice(100, 95, 10)).toEqual({ start: 95, end: 99 })
    expect(rangeSlice(100, 50)).toEqual({ start: 50, end: 99 })
    expect(rangeSlice(100, 100, 10)).toBeNull()
    expect(rangeSlice(0, 0, 10)).toBeNull()
  })
})

describe('cacheKey', () => {
  it('大小或修改时间变了就是另一个键（手机侧改文件即自动失效）', () => {
    expect(cacheKey(meta)).toBe(cacheKey({ ...meta }))
    expect(cacheKey({ ...meta, size: 11 })).not.toBe(cacheKey(meta))
    expect(cacheKey({ ...meta, mtimeMs: 112 })).not.toBe(cacheKey(meta))
    expect(cacheKey({ ...meta, serial: 'S2' })).not.toBe(cacheKey(meta))
  })
})

describe('createFileCache', () => {
  let dir
  let cache

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anddrive-filecache-'))
    cache = createFileCache({ dir, budgetBytes: 1000 })
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('未物化前不命中，物化后命中且内容是那一段', async () => {
    expect(await cache.read({ ...meta, start: 2, length: 4 })).toBeNull()
    const payload = Buffer.from('0123456789')
    const ok = await cache.materialize(meta, whole(payload))
    expect(ok).toBe(true)
    const hit = await cache.read({ ...meta, start: 2, length: 4 })
    expect((await bytesOf(hit.stream)).toString()).toBe('2345')
  })

  it('拉回来的字节数不对就绝不落成完整条目', async () => {
    const partial = { ...meta, path: '/sdcard/partial.bin' }
    const ok = await cache.materialize(partial, async () => Buffer.from('0123'))
    expect(ok).toBe(false)
    expect(await cache.read({ ...partial, start: 0, length: 4 })).toBeNull()
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.part'))
    expect(leftovers).toEqual([])
  })

  it('同一个文件只允许一份物化在跑', async () => {
    let starts = 0
    const slow = { ...meta, path: '/sdcard/slow.bin' }
    const run = () =>
      cache.materialize(slow, async () => {
        starts += 1
        await new Promise((resolve) => setTimeout(resolve, 30))
        return Buffer.from('0123456789')
      })
    const [a, b] = await Promise.all([run(), run()])
    expect([a, b]).toEqual([true, true])
    expect(starts).toBe(1)
  })

  it('超过预算按最久没碰的先丢，刚写的那个保留', async () => {
    // 独立的目录与预算：共享目录会被前面测试留下的条目污染，淘汰顺序就不是测试要验的那个了。
    const soloDir = await mkdtemp(join(tmpdir(), 'anddrive-cache-lru-'))
    const solo = createFileCache({ dir: soloDir, budgetBytes: 1000 })
    const big = { serial: 'S1', path: '/sdcard/big.bin', size: 600, mtimeMs: 1 }
    const old = { serial: 'S1', path: '/sdcard/old.bin', size: 600, mtimeMs: 2 }
    const fresh = { serial: 'S1', path: '/sdcard/fresh.bin', size: 600, mtimeMs: 3 }
    await solo.materialize(big, whole(Buffer.alloc(600, 1)))
    await solo.materialize(old, whole(Buffer.alloc(600, 2)))
    // 把 big 的访问时间推到过去，模拟"很久没看"。
    await utimes(solo.entryPath(cacheKey(big)), new Date(0), new Date(0))
    await solo.materialize(fresh, whole(Buffer.alloc(600, 3)))
    expect(await solo.read({ ...big, start: 0, length: 10 })).toBeNull()
    expect(await solo.read({ ...fresh, start: 0, length: 10 })).not.toBeNull()
    await rm(soloDir, { recursive: true, force: true })
  })

  it('invalidatePath 会把该路径的所有键清掉', async () => {
    const target = { serial: 'S1', path: '/sdcard/written.bin', size: 10, mtimeMs: 1 }
    await cache.materialize(target, whole(Buffer.from('0123456789')))
    expect(await cache.read({ ...target, start: 0, length: 10 })).not.toBeNull()
    await cache.invalidatePath('S1', '/sdcard/written.bin')
    expect(await cache.read({ ...target, start: 0, length: 10 })).toBeNull()
  })

  it('太大的文件不物化', async () => {
    const huge = { ...meta, size: MATERIALIZE_MAX_BYTES + 1 }
    expect(await cache.materialize(huge, async () => Buffer.alloc(0))).toBe(false)
  })

  it('大文件分块要，每块不超过一块的大小', async () => {
    const size = 10 * 1024 * 1024
    const calls = []
    const ok = await cache.materialize(
      { serial: 'S1', path: '/sdcard/huge.bin', size, mtimeMs: 4 },
      async (start, length) => {
        calls.push([start, length])
        return Buffer.alloc(length, 5)
      },
    )
    expect(ok).toBe(true)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[0]).toEqual([0, MATERIALIZE_CHUNK])
    expect(calls.at(-1)[0] + calls.at(-1)[1]).toBe(size)
  })

  it('命中时会碰一下 atime，正在看的文件不会被 LRU 踢掉', async () => {
    const keep = { serial: 'S1', path: '/sdcard/keep.bin', size: 20, mtimeMs: 9 }
    await cache.materialize(keep, whole(Buffer.alloc(20, 7)))
    await utimes(cache.entryPath(cacheKey(keep)), new Date(0), new Date(0))
    const hit = await cache.read({ ...keep, start: 0, length: 5 })
    await bytesOf(hit.stream)
    expect((await stat(cache.entryPath(cacheKey(keep))).catch(() => null)).atimeMs).toBeGreaterThan(1000)
  })

  // 后台物化必须能在块与块之间让路给"用户正在读"，也不能把让路失败变成半截条目。
  it('每块之前都过让路点，顺序是"让路 → 取块"', async () => {
    const order = []
    const size = MATERIALIZE_CHUNK * 2 + 10
    const ok = await cache.materialize(
      { serial: 'S1', path: '/sdcard/yield.bin', size, mtimeMs: 20 },
      async (start, length) => {
        order.push(`fetch:${start}`)
        return Buffer.alloc(length, 3)
      },
      async () => {
        order.push('yield')
      },
    )
    expect(ok).toBe(true)
    expect(order).toEqual(['yield', 'fetch:0', 'yield', `fetch:${MATERIALIZE_CHUNK}`, 'yield', `fetch:${MATERIALIZE_CHUNK * 2}`])
  })

  it('让路点抛错就当这一轮放弃：不留 .part、不落条目、下次还能重跑', async () => {
    const target = { serial: 'S1', path: '/sdcard/abort.bin', size: 10, mtimeMs: 30 }
    let calls = 0
    const abort = async () => {
      calls += 1
      throw new Error('一直在让路')
    }
    expect(await cache.materialize(target, whole(Buffer.from('0123456789')), abort)).toBe(false)
    expect(calls).toBe(1)
    // 只看自己的键：这个目录是本文件共用的，按目录扫会被别的测试留下的东西干扰。
    expect(existsSync(`${cache.entryPath(cacheKey(target))}.part`)).toBe(false)
    expect(existsSync(cache.entryPath(cacheKey(target)))).toBe(false)
    expect(await cache.read({ ...target, start: 0, length: 10 })).toBeNull()
    // inflight 要清掉，否则这个键永远不再物化。
    expect(await cache.materialize(target, whole(Buffer.from('0123456789')), async () => {})).toBe(true)
  })
})
