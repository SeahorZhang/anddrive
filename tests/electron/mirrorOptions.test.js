import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const {
  buildMirrorOptions,
  parseBitRate,
  mapNewDisplay,
  resolveNativeCodec,
  resolveRuntimePrefs,
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

describe('mapNewDisplay', () => {
  it('maps off to undefined and device to the empty value', () => {
    expect(mapNewDisplay('off')).toBeUndefined()
    expect(mapNewDisplay('device')).toBe('')
    expect(mapNewDisplay('1920x1080/320')).toBe('1920x1080/320')
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
      newDisplay: '1920x1080/320',
      keepActive: true,
    })
  })

  it('drops newDisplay when disabled and maps screen modes', () => {
    const off = buildMirrorOptions({ newDisplay: 'off', screenMode: 'normal' })
    expect('newDisplay' in off).toBe(false)
    expect('keepActive' in off).toBe(false)
    expect('stayAwake' in off).toBe(false)

    const turnOff = buildMirrorOptions({ screenMode: 'turnOff' })
    expect(turnOff.stayAwake).toBe(true)
    expect('keepActive' in turnOff).toBe(false)
  })

  it('keeps the device-sized virtual display as an empty option', () => {
    expect(buildMirrorOptions({ newDisplay: 'device' }).newDisplay).toBe('')
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
