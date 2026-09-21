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
  it('默认转视频 + 控制，音频按设置默认关', () => {
    const options = buildMirrorOptions(undefined)
    expect(options).toMatchObject({
      video: true,
      audio: false,
      control: true,
      sendStreamMeta: true,
      videoCodec: 'h265',
      videoBitRate: 24_000_000,
      maxFps: 60,
      newDisplay: '1280x960/160',
      flexDisplay: true,
    })
    expect(options.audioCodec).toBeUndefined()
  })

  it('打开音频转发时才有音频参数', () => {
    expect(buildMirrorOptions({ audio: true })).toMatchObject({
      video: true,
      audio: true,
      audioCodec: 'opus',
    })
  })

  it('uses the newDisplay override from the renderer', () => {
    const options = buildMirrorOptions(undefined, { newDisplay: '920x1800/320' })
    expect(options.newDisplay).toBe('920x1800/320')
    expect(options.flexDisplay).toBe(true)
  })

  it('转发音频时才请求 Opus；关掉就完全不建音频采集', () => {
    // 抓系统音频会抢设备侧音频焦点（在播的 app 会暂停、会话结束时又自动续播），
    // 所以设置里的音频开关必须是真的开关 —— 早先这里写死 audio: true。
    expect(buildMirrorOptions({ audio: true }).audio).toBe(true)
    expect(buildMirrorOptions({ audio: true }).audioCodec).toBe('opus')
    // 用户 2026-09-21 明确要「投屏时手机不出声」= scrcpy 默认（不开 --audio-dup）。
    expect(buildMirrorOptions({ audio: true }).audioDup).toBeUndefined()

    expect(buildMirrorOptions({ audio: false }).audio).toBe(false)
    expect(buildMirrorOptions({ audio: false }).audioCodec).toBeUndefined()
    expect(buildMirrorOptions({ audio: false }).audioDup).toBeUndefined()

    expect(buildMirrorOptions(undefined).audio).toBe(false)
  })

  it('overrides the codec when the native engine requests it', () => {
    expect(buildMirrorOptions({ videoCodec: 'h265' }, { videoCodec: 'h264' }).videoCodec).toBe(
      'h264',
    )
  })

  it('屏幕策略只有「保持亮屏」进服务端选项，「启动后息屏」不进', () => {
    expect(buildMirrorOptions({ screenMode: 'keepActive' }).keepActive).toBe(true)

    // turnOff 曾被错映射成 stayAwake —— 那是「保持亮屏」的同义词，语义正好相反。
    // 息屏靠会话建立后的 setDisplayPower(false) 控制消息（resolveRuntimePrefs.turnScreenOff）。
    const turnOff = buildMirrorOptions({ screenMode: 'turnOff' })
    expect(turnOff.keepActive).toBeUndefined()
    expect(turnOff.stayAwake).toBeUndefined()
    expect(resolveRuntimePrefs({ screenMode: 'turnOff' }).turnScreenOff).toBe(true)

    const normal = buildMirrorOptions({ screenMode: 'normal' })
    expect(normal.keepActive).toBeUndefined()
    expect(normal.stayAwake).toBeUndefined()
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
