import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const { normalizeScrcpyConfig, buildScrcpyArgs, DEFAULT_SCRCPY_CONFIG } = await import(
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
      newDisplay: '1280x720/240',
      bitRate: '8M',
      maxFps: 90,
      videoCodec: 'av1',
      audio: true,
      screenMode: 'turnOff',
      alwaysOnTop: true,
      fullscreen: true,
    })
    expect(config).toEqual({
      newDisplay: '1280x720/240',
      bitRate: '8M',
      maxFps: 90,
      videoCodec: 'av1',
      audio: true,
      screenMode: 'turnOff',
      alwaysOnTop: true,
      fullscreen: true,
    })
  })

  it('falls back on malformed values', () => {
    const config = normalizeScrcpyConfig({
      newDisplay: 'wide; rm -rf /',
      bitRate: '24M; rm',
      videoCodec: 'mpeg2',
      screenMode: 'explode',
      audio: 'yes',
    })
    expect(config.newDisplay).toBe(DEFAULT_SCRCPY_CONFIG.newDisplay)
    expect(config.bitRate).toBe(DEFAULT_SCRCPY_CONFIG.bitRate)
    expect(config.videoCodec).toBe(DEFAULT_SCRCPY_CONFIG.videoCodec)
    expect(config.screenMode).toBe(DEFAULT_SCRCPY_CONFIG.screenMode)
    expect(config.audio).toBe(false)
  })

  it('accepts special display modes and clamps fps', () => {
    expect(normalizeScrcpyConfig({ newDisplay: 'device' }).newDisplay).toBe('device')
    expect(normalizeScrcpyConfig({ newDisplay: 'off' }).newDisplay).toBe('off')
    expect(normalizeScrcpyConfig({ maxFps: 0 }).maxFps).toBe(1)
    expect(normalizeScrcpyConfig({ maxFps: 999 }).maxFps).toBe(240)
    expect(normalizeScrcpyConfig({ maxFps: 59.5 }).maxFps).toBe(DEFAULT_SCRCPY_CONFIG.maxFps)
  })
})

describe('buildScrcpyArgs', () => {
  const base = {
    serial: '192.168.1.5:5555',
    packageName: 'com.example.app',
    label: '示例应用',
    config: { audio: true },
  }

  it('builds a default command line', () => {
    const args = buildScrcpyArgs(base)
    expect(args.slice(0, 2)).toEqual(['-s', '192.168.1.5:5555'])
    expect(args).toContain('--new-display=1920x1080/320')
    expect(args).toContain('--start-app=com.example.app')
    expect(args).toContain('--keep-active')
    expect(args).toContain('--video-codec=h265')
    expect(args).toContain('-b')
    expect(args).toContain('24M')
    expect(args).toContain('--window-title=示例应用')
    expect(args).not.toContain('--no-audio')
    expect(args).not.toContain('--always-on-top')
    expect(args).not.toContain('--fullscreen')
  })

  it('maps display, screen, audio and window flags', () => {
    const args = buildScrcpyArgs({
      ...base,
      config: {
        newDisplay: 'off',
        screenMode: 'turnOff',
        audio: false,
        alwaysOnTop: true,
        fullscreen: true,
      },
    })
    expect(args.some((arg) => arg.startsWith('--new-display'))).toBe(false)
    expect(args).toContain('--stay-awake')
    expect(args).toContain('--turn-screen-off')
    expect(args).not.toContain('--keep-active')
    expect(args).toContain('--no-audio')
    expect(args).toContain('--always-on-top')
    expect(args).toContain('--fullscreen')
  })

  it('supports device-sized virtual display', () => {
    const args = buildScrcpyArgs({ ...base, config: { newDisplay: 'device' } })
    expect(args).toContain('--new-display')
    expect(args).not.toContain('--new-display=1920x1080/320')
  })

  it('rejects unsafe serial and package names', () => {
    expect(() => buildScrcpyArgs({ ...base, packageName: 'com.a; rm -rf /' })).toThrow('应用包名无效')
    expect(() => buildScrcpyArgs({ ...base, serial: '' })).toThrow('设备序列号无效')
  })
})
