import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

const { normalizeListOutput } = await import('../../electron/helper/helper.js')

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

  it('tolerates CRLF-wrapped output and surrounding whitespace', () => {
    expect(
      normalizeListOutput(`\r\n${listJson([{ packageName: 'com.a', label: 'A' }])}\n`),
    ).toEqual([{ packageName: 'com.a', label: 'A', iconUrl: null }])
  })

  it('rejects non-JSON and malformed envelopes', () => {
    for (const bad of ['not json', '{}', '{"apps":{}}', '{"apps":"x"}']) {
      expect(() => normalizeListOutput(bad)).toThrow('Invalid helper output')
    }
  })
})
