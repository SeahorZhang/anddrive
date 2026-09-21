import { describe, expect, it, vi } from 'vitest'

const fsState = vi.hoisted(() => ({
  /** 收藏文件内容；null 表示文件不存在。 */
  raw: null,
  writeFails: false,
  /** writeFile 写好、还没 rename 的临时内容。 */
  pending: undefined,
  /** 最后一次成功写入的内容。 */
  written: null,
}))

vi.mock('node:fs', () => ({
  promises: {
    readFile: () =>
      fsState.raw === null
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(Buffer.from(fsState.raw)),
    mkdir: () => Promise.resolve(),
    writeFile: (_file, data) => {
      if (fsState.writeFails) return Promise.reject(new Error('ENOSPC: no space left on device'))
      fsState.written = JSON.parse(data)
      fsState.pending = data
      return Promise.resolve()
    },
    // 真实实现是「写临时文件 → rename 覆盖」，这里让 rename 才把内容落到 raw，
    // 顺带保证下一次读取读到的是上一笔真正落盘的数据。
    rename: () => {
      if (fsState.pending !== undefined) {
        fsState.raw = fsState.pending
        fsState.pending = undefined
      }
      return Promise.resolve()
    },
  },
  copyFile: () => Promise.resolve(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

// 稳定标识解析要真 adb；测试里让它原样返回，走的还是同一条代码路径。
vi.mock('../../electron/adb.js', () => ({
  resolveDeviceStableId: async (serial) => serial,
}))

const { sanitizePackage, sanitizeFavoriteList, sanitizeStore, toggleFavorite } = await import(
  '../../electron/favorites.js'
)

describe('sanitizePackage', () => {
  it('trims valid package names', () => {
    expect(sanitizePackage('  com.example.app  ')).toBe('com.example.app')
  })

  it('rejects empty, non-string and overlong values', () => {
    expect(sanitizePackage('')).toBeNull()
    expect(sanitizePackage('   ')).toBeNull()
    expect(sanitizePackage(42)).toBeNull()
    expect(sanitizePackage(null)).toBeNull()
    expect(sanitizePackage('a'.repeat(513))).toBeNull()
  })
})

describe('sanitizeFavoriteList', () => {
  it('drops invalid entries and de-duplicates', () => {
    expect(sanitizeFavoriteList(['com.a', 'com.a', '', 7, 'com.b'])).toEqual(['com.a', 'com.b'])
  })

  it('returns an empty list for non-arrays', () => {
    expect(sanitizeFavoriteList(undefined)).toEqual([])
    expect(sanitizeFavoriteList('com.a')).toEqual([])
  })

  it('caps the list length', () => {
    const many = Array.from({ length: 600 }, (_, index) => `com.app${index}`)
    expect(sanitizeFavoriteList(many)).toHaveLength(500)
  })
})

describe('sanitizeStore', () => {
  it('keeps only serials with a non-empty favorite list', () => {
    expect(
      sanitizeStore({
        serialA: ['com.a'],
        serialB: [],
        serialC: ['com.c', 'com.c'],
        serialD: 'not-a-list',
      }),
    ).toEqual({ serialA: ['com.a'], serialC: ['com.c'] })
  })

  it('ignores non-object stores', () => {
    expect(sanitizeStore(null)).toEqual({})
    expect(sanitizeStore('nope')).toEqual({})
  })
})

describe('toggleFavorite', () => {
  it('写入失败时抛出可读错误（渲染层靠它回滚星标）', async () => {
    fsState.raw = null
    fsState.writeFails = true
    await expect(toggleFavorite('af3d7abd', 'com.example.app')).rejects.toThrow('收藏没能保存')
    fsState.writeFails = false
  })

  it('写入成功时返回该设备的收藏', async () => {
    fsState.raw = JSON.stringify({ af3d7abd: ['com.exist.app'] })
    fsState.writeFails = false
    fsState.written = null

    expect(await toggleFavorite('af3d7abd', 'com.example.app')).toEqual([
      'com.exist.app',
      'com.example.app',
    ])
    expect(fsState.written).toEqual({ af3d7abd: ['com.exist.app', 'com.example.app'] })

    // 再点一次取消收藏：写回的是去掉该项后的列表。
    expect(await toggleFavorite('af3d7abd', 'com.example.app')).toEqual(['com.exist.app'])
  })

  it('拒绝非法入参且不写盘', async () => {
    fsState.written = null
    expect(await toggleFavorite('', 'com.example.app')).toBeNull()
    expect(await toggleFavorite('af3d7abd', '  ')).toBeNull()
    expect(fsState.written).toBeNull()
  })
})
