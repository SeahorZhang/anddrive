import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const { normalizePackageName } = await import('../../electron/adb.js')

describe('normalizePackageName', () => {
  it('trims and accepts dotted package names', () => {
    expect(normalizePackageName('  com.example.app  ')).toBe('com.example.app')
    expect(normalizePackageName('com.example_app2')).toBe('com.example_app2')
    expect(normalizePackageName('single')).toBe('single')
  })

  it('rejects malformed or out-of-range names', () => {
    expect(() => normalizePackageName('')).toThrow('应用包名无效')
    expect(() => normalizePackageName('   ')).toThrow('应用包名无效')
    expect(() => normalizePackageName('com..app')).toThrow('应用包名无效')
    expect(() => normalizePackageName('com.example.')).toThrow('应用包名无效')
    expect(() => normalizePackageName('com.example app')).toThrow('应用包名无效')
    expect(() => normalizePackageName('com.example;rm -rf /')).toThrow('应用包名无效')
    expect(() => normalizePackageName(42)).toThrow('应用包名无效')
    expect(() => normalizePackageName('a'.repeat(513))).toThrow('应用包名无效')
  })
})
