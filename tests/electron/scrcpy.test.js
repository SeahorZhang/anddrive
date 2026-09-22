import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const { normalizeScrcpyConfig, DEFAULT_SCRCPY_CONFIG } = await import(
  '../../electron/adb.js'
)

describe('normalizeScrcpyConfig', () => {
  it('returns defaults for missing or non-object input', () => {
    expect(normalizeScrcpyConfig(undefined)).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
    expect(normalizeScrcpyConfig(null)).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
    expect(normalizeScrcpyConfig('nope')).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })

  it('keeps valid overrides', () => {
    const config = normalizeScrcpyConfig({
      bitRate: '8M',
      maxFps: 90,
      videoCodec: 'av1',
      audio: true,
      screenMode: 'turnOff',
      alwaysOnTop: true,
      fullscreen: true,
      engine: 'native',
    })
    // 用 defaults + 覆盖项做基线，而不是逐个字段抄一遍：加字段时这里不该跟着改。
    expect(config).toEqual({
      ...DEFAULT_SCRCPY_CONFIG,
      bitRate: '8M',
      maxFps: 90,
      videoCodec: 'av1',
      audio: true,
      screenMode: 'turnOff',
      alwaysOnTop: true,
      fullscreen: true,
      engine: 'native',
    })
  })

  it('falls back on malformed values', () => {
    const config = normalizeScrcpyConfig({
      bitRate: '24M; rm',
      videoCodec: 'mpeg2',
      screenMode: 'explode',
      audio: 'yes',
    })
    expect(config.bitRate).toBe(DEFAULT_SCRCPY_CONFIG.bitRate)
    expect(config.videoCodec).toBe(DEFAULT_SCRCPY_CONFIG.videoCodec)
    expect(config.screenMode).toBe(DEFAULT_SCRCPY_CONFIG.screenMode)
    expect(config.audio).toBe(false)
  })

  it('drops removed legacy fields and clamps fps', () => {
    const legacy = normalizeScrcpyConfig({ newDisplay: 'device', renderFit: 'unscaled' })
    expect('newDisplay' in legacy).toBe(false)
    expect('renderFit' in legacy).toBe(false)
    expect(normalizeScrcpyConfig({ maxFps: 0 }).maxFps).toBe(1)
    expect(normalizeScrcpyConfig({ maxFps: 999 }).maxFps).toBe(240)
    expect(normalizeScrcpyConfig({ maxFps: 59.5 }).maxFps).toBe(DEFAULT_SCRCPY_CONFIG.maxFps)
  })
})
