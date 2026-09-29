import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', on: () => {} },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}))

const { resolveDevicePath, quoteShell, parseStatOutput, toDeviceEntry, createTtlCache } = await import(
  '../../electron/devfs.js'
)

describe('toDeviceEntry', () => {
  it('ls2 的 BigInt 字段收成数字', () => {
    const entry = toDeviceEntry('/sdcard/a.txt', {
      type: 1,
      mode: 0o100644,
      size: 2602102n,
      mtime: 1790651399n,
    })
    expect(entry).toEqual({
      path: '/sdcard/a.txt',
      name: 'a.txt',
      dir: false,
      size: 2602102,
      mtimeMs: 1790651399000,
    })
  })

  it('目录认 d_type，也认旧设备的 mode 位', () => {
    expect(toDeviceEntry('/sdcard/DCIM', { type: 4, size: 0n, mtime: 0n }).dir).toBe(true)
    expect(toDeviceEntry('/sdcard/DCIM', { mode: 0o40775, size: 0n, mtime: 0n }).dir).toBe(true)
    expect(toDeviceEntry('/sdcard/DCIM', { type: 4 }).dir).toBe(true)
  })

  it('缺字段不会变成 NaN', () => {
    expect(toDeviceEntry('/sdcard/x', {})).toMatchObject({ size: 0, mtimeMs: 0, dir: false })
  })
})

describe('createTtlCache', () => {
  it('TTL 内命中缓存，不再回源', async () => {
    const cache = createTtlCache(1000)
    let loads = 0
    const load = async () => (++loads, [{ name: 'a' }])
    await cache.resolve('S1', '/sdcard/Download/', load)
    await cache.resolve('S1', '/sdcard/Download/', load)
    expect(loads).toBe(1)
  })

  it('写文件后父目录清单必须作废，否则新建的文件看不见', async () => {
    const cache = createTtlCache(1000)
    let loads = 0
    const list = () => (++loads, ['x'])
    await cache.resolve('S1', '/sdcard/Download/', list)
    cache.invalidate('S1', '/sdcard/Download/new.txt')
    await cache.resolve('S1', '/sdcard/Download/', list)
    expect(loads).toBe(2)
  })

  it('失效只影响这台设备', async () => {
    const cache = createTtlCache(1000)
    let loads = 0
    await cache.resolve('S1', '/sdcard/', async () => (++loads, 1))
    await cache.resolve('S2', '/sdcard/', async () => (++loads, 1))
    cache.invalidate('S1', '/sdcard/a.txt')
    await cache.resolve('S1', '/sdcard/', async () => (++loads, 1))
    await cache.resolve('S2', '/sdcard/', async () => (++loads, 1))
    expect(loads).toBe(3)
  })

  it('超出容量丢最旧的，不会无限涨', async () => {
    const cache = createTtlCache(1000, 3)
    for (const name of ['a', 'b', 'c', 'd']) await cache.resolve('S', `/x/${name}`, async () => 1)
    expect(cache.size).toBe(3)
    expect(cache.has('S', '/x/a')).toBe(false)
    expect(cache.has('S', '/x/d')).toBe(true)
  })
})

describe('resolveDevicePath', () => {
  it('空请求路径映射回挂载根，而不是设备真根', () => {
    expect(resolveDevicePath('/storage/emulated/0', '/')).toBe('/storage/emulated/0')
    expect(resolveDevicePath('/storage/emulated/0', '')).toBe('/storage/emulated/0')
    expect(resolveDevicePath('/storage/emulated/0', '/selftest/')).toBe('/storage/emulated/0/selftest')
    expect(resolveDevicePath('/', '/')).toBe('/')
  })

  it('百分号编码与斜杠归一', () => {
    expect(resolveDevicePath('/sdcard', '/DCIM/%E7%85%A7%E7%89%87/')).toBe('/sdcard/DCIM/照片')
    expect(resolveDevicePath('/sdcard', '//a//b//')).toBe('/sdcard/a/b')
  })

  it('拒绝越界与坏编码', () => {
    expect(resolveDevicePath('/sdcard/Download', '/../etc/passwd')).toBeNull()
    expect(resolveDevicePath('/sdcard/Download', '/a/../../b')).toBeNull()
    expect(resolveDevicePath('/sdcard/Download', '/%E0%A4%A')).toBeNull()
    expect(resolveDevicePath('relative', '/x')).toBeNull()
  })
})

describe('quoteShell', () => {
  it('单引号包住并转义内部单引号', () => {
    expect(quoteShell("/sdcard/it's here")).toBe(`'/sdcard/it'\\''s here'`)
    expect(quoteShell('a;rm -rf /')).toBe("'a;rm -rf /'")
  })
})

describe('parseStatOutput', () => {
  it('从右往左取字段，路径里的竖线不算分隔', () => {
    const [entry] = parseStatOutput('/sdcard/we|ird.txt|regular file|12|1700000000')
    expect(entry).toEqual({
      path: '/sdcard/we|ird.txt',
      name: 'we|ird.txt',
      dir: false,
      size: 12,
      mtimeMs: 1700000000000,
    })
  })

  it('目录认 type，其它字段缺失的行直接丢', () => {
    const entries = parseStatOutput(
      ['/sdcard/DCIM|directory|3452|1700000000', 'garbage', '/x|regular file|0|'].join('\n'),
    )
    expect(entries.map((item) => item.dir)).toEqual([true, false])
    expect(entries[1].mtimeMs).toBe(0)
  })

  it('空输出与噪声行不炸', () => {
    expect(parseStatOutput('')).toEqual([])
    expect(parseStatOutput('stat: No such file or directory')).toEqual([])
  })
})
