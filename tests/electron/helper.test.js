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
      { packageName: 'com.one', label: 'One', iconUrl: 'data:image/png;base64,AQID', system: false },
      { packageName: 'com.bare', label: '', iconUrl: null, system: false },
      { packageName: 'com.nolabel', label: '', iconUrl: null, system: false },
    ])
  })

  it('tolerates noise around the JSON object (linker/ART warnings)', () => {
    const noisy = `WARNING: linker: foo\n${listJson([{ packageName: 'com.a', label: 'A' }])}\n[art] bar`
    expect(normalizeListOutput(noisy)).toEqual([
      { packageName: 'com.a', label: 'A', iconUrl: null, system: false },
    ])
  })

  it('rejects non-JSON and malformed envelopes with a raw-output preview', () => {
    for (const bad of ['', 'no braces at all', '{}', '{"apps":{}}', '{"apps":"x"}']) {
      expect(() => normalizeListOutput(bad)).toThrow(/Invalid helper output/)
    }
  })
})

  it('带上 helper 报的 system 标志（桌面端用它禁掉卸载 / 清除数据）', () => {
    const [sys, user] = normalizeListOutput(
      listJson([
        { packageName: 'com.android.settings', label: '设置', system: true },
        { packageName: 'com.miui.calculator', label: '计算器', system: false },
      ]),
    )
    expect(sys.system).toBe(true)
    expect(user.system).toBe(false)
    // 旧 helper 没这个字段时按「不是系统应用」处理，不要冒然禁掉用户的操作
    expect(normalizeListOutput(listJson([{ packageName: 'x', label: 'X' }]))[0].system).toBe(false)
  })
