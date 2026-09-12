import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

const { normalizeListOutput } = await import('../../electron/adb.js')

const listJson = (apps) => JSON.stringify({ apps })

describe('normalizeListOutput', () => {
  it('maps iconPng to a png data URL and keeps label fallback empty-safe', () => {
    expect(
      normalizeListOutput(
        listJson([
          { packageName: 'com.one', label: 'One', iconPng: 'AQID' },
          { packageName: 'com.bare' },
          { packageName: 'com.nolabel', label: '', iconPng: '' },
        ]),
      ),
    ).toEqual([
      { packageName: 'com.one', label: 'One', iconUrl: 'data:image/png;base64,AQID' },
      { packageName: 'com.bare', label: '', iconUrl: null },
      { packageName: 'com.nolabel', label: '', iconUrl: null },
    ])
  })

  it('tolerates noise around the JSON object (linker/ART warnings)', () => {
    const noisy = `WARNING: linker: foo\n${listJson([{ packageName: 'com.a', label: 'A' }])}\n[art] bar`
    expect(normalizeListOutput(noisy)).toEqual([
      { packageName: 'com.a', label: 'A', iconUrl: null },
    ])
  })

  it('rejects non-JSON and malformed envelopes with a raw-output preview', () => {
    for (const bad of ['', 'no braces at all', '{}', '{"apps":{}}', '{"apps":"x"}']) {
      expect(() => normalizeListOutput(bad)).toThrow(/Invalid helper output/)
    }
  })
})
