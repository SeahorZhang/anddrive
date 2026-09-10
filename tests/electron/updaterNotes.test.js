import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false, getVersion: () => '0.0.0' },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('bonjour-service', () => ({ default: class {} }))
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: vi.fn(),
      checkForUpdates: vi.fn(async () => {}),
      quitAndInstall: vi.fn(),
    },
  },
}))

const { normalizeReleaseNotes } = await import('../../electron/updater.js')

describe('normalizeReleaseNotes', () => {
  it('trims a plain string body', () => {
    expect(normalizeReleaseNotes('  - 修复问题\n- 新增功能  ')).toBe('- 修复问题\n- 新增功能')
  })

  it('flattens ReleaseNoteInfo arrays', () => {
    expect(
      normalizeReleaseNotes([
        { version: '1.2.0', note: '新功能' },
        { version: '1.1.0', note: '修复' },
      ]),
    ).toBe('1.2.0\n新功能\n\n1.1.0\n修复')
  })

  it('skips empty entries and unknown shapes', () => {
    expect(normalizeReleaseNotes([{ version: '1.0.0', note: '   ' }, null])).toBe('')
    expect(normalizeReleaseNotes(undefined)).toBe('')
    expect(normalizeReleaseNotes({})).toBe('')
  })
})
