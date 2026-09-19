import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const {
  buildMirrorOptions,
  parseBitRate,
  resolveNativeCodec,
  resolveRuntimePrefs,
  mirrorWindowBounds,
} = await import('../../electron/mirror/options.js')

describe('parseBitRate', () => {
  it('converts decimal suffixes to bits per second', () => {
    expect(parseBitRate('24M')).toBe(24_000_000)
    expect(parseBitRate('800K')).toBe(800_000)
    expect(parseBitRate('1G')).toBe(1_000_000_000)
    expect(parseBitRate('8')).toBe(8)
  })

  it('falls back to the scrcpy default for malformed values', () => {
    expect(parseBitRate('24M; rm -rf /')).toBe(8_000_000)
    expect(parseBitRate(undefined)).toBe(8_000_000)
  })
})

describe('buildMirrorOptions', () => {
  it('maps defaults to a video+audio, control-enabled session', () => {
    const options = buildMirrorOptions(undefined)
    expect(options).toMatchObject({
      video: true,
      audio: true,
      audioCodec: 'opus',
      control: true,
      sendStreamMeta: true,
      videoCodec: 'h265',
      videoBitRate: 24_000_000,
      maxFps: 60,
      newDisplay: '1280x960/160',
      flexDisplay: true,
      keepActive: true,
    })
  })

  it('always creates a flex virtual display and maps screen modes', () => {
    const normal = buildMirrorOptions({ screenMode: 'normal' })
    expect(normal.flexDisplay).toBe(true)
    expect(normal.newDisplay).toBe('1280x960/160')
    expect('keepActive' in normal).toBe(false)
    expect('stayAwake' in normal).toBe(false)

    const turnOff = buildMirrorOptions({ screenMode: 'turnOff' })
    expect(turnOff.stayAwake).toBe(true)
    expect('keepActive' in turnOff).toBe(false)
  })

  it('uses the newDisplay override from the renderer', () => {
    const options = buildMirrorOptions(undefined, { newDisplay: '920x1800/320' })
    expect(options.newDisplay).toBe('920x1800/320')
    expect(options.flexDisplay).toBe(true)
  })

  it('always requests opus audio for scrcpy 4.0', () => {
    expect(buildMirrorOptions({ audio: false }).audio).toBe(true)
    expect(buildMirrorOptions(undefined).audioCodec).toBe('opus')
  })

  it('overrides the codec when the native engine requests it', () => {
    expect(buildMirrorOptions({ videoCodec: 'h265' }, { videoCodec: 'h264' }).videoCodec).toBe(
      'h264',
    )
  })
})

describe('resolveNativeCodec', () => {
  it('keeps H.264 and H.265 as-is', () => {
    expect(resolveNativeCodec({ videoCodec: 'h264' })).toEqual({ codec: 'h264', downgraded: false })
    expect(resolveNativeCodec({ videoCodec: 'h265' })).toEqual({ codec: 'h265', downgraded: false })
  })

  it('downgrades unsupported codecs to H.264', () => {
    expect(resolveNativeCodec({ videoCodec: 'av1' })).toEqual({ codec: 'h264', downgraded: true })
  })
})

describe('resolveRuntimePrefs', () => {
  it('reads window flags and the screen-off request', () => {
    expect(resolveRuntimePrefs({ alwaysOnTop: true, fullscreen: true, screenMode: 'turnOff' })).toEqual({
      alwaysOnTop: true,
      fullscreen: true,
      turnScreenOff: true,
    })
    expect(resolveRuntimePrefs(undefined)).toEqual({
      alwaysOnTop: false,
      fullscreen: false,
      turnScreenOff: false,
    })
  })
})

describe('mirrorWindowBounds', () => {
  it('竖形手机：长边取高度，短边按设备宽高比缩', () => {
    // 1200x2608 的 Redmi，可用区域 1440x875 → 高 = 875-80 = 795，宽 = 795×(1200/2608) ≈ 366
    expect(mirrorWindowBounds({ width: 1200, height: 2608 }, { width: 1440, height: 875 })).toEqual({
      width: 366,
      height: 795,
    })
  })

  it('横形设备：长边取宽度，并受长边上限约束', () => {
    // 长边封顶 1000（再大超出笔电），高 = 1000 / (2608/1200) ≈ 460
    expect(mirrorWindowBounds({ width: 2608, height: 1200 }, { width: 2560, height: 1400 })).toEqual({
      width: 1000,
      height: 460,
    })
  })

  it('拿不到设备分辨率时走兜底比例，不抛错', () => {
    const bounds = mirrorWindowBounds(null, { width: 1440, height: 875 })
    expect(bounds.height).toBe(795)
    expect(bounds.width).toBe(Math.round(795 * (9 / 19.5)))
  })

  it('小屏幕上长边被可用区域夹住，且不低于最小边', () => {
    const small = mirrorWindowBounds({ width: 1200, height: 2608 }, { width: 700, height: 500 })
    expect(small.height).toBe(420)
    expect(small.width).toBeGreaterThanOrEqual(280)
  })
})
