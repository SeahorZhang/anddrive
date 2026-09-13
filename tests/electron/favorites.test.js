import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

const { sanitizePackage, sanitizeFavoriteList, sanitizeStore } = await import(
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
