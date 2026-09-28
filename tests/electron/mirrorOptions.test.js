import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const {
  buildMirrorOptions,
  formatNewDisplay,
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
  /** newDisplay 已改成必填（调用方按窗口 CSS × 画质档位算），测试里统一给一个。 */
  const NEW_DISPLAY = { newDisplay: '1080x2400/320' }
  const optionsFor = (config, overrides = {}) =>
    buildMirrorOptions(config, { ...NEW_DISPLAY, ...overrides })

  it('默认转视频 + 控制，音频按设置默认关', () => {
    expect(optionsFor(undefined)).toMatchObject({
      video: true,
      audio: false,
      control: true,
      sendStreamMeta: true,
      videoCodec: 'h265',
      videoBitRate: 24_000_000,
      maxFps: 60,
      newDisplay: '1080x2400/320',
      flexDisplay: true,
      // 镜像里不显示手机的状态栏（整块显示留给应用）。
      vdSystemDecorations: false,
    })
  })

  it('任何配置组合都不把系统装饰打开', () => {
    for (const config of [undefined, { audio: true }, { maxFps: 120 }, { videoCodec: 'av1' }]) {
      expect(optionsFor(config).vdSystemDecorations).toBe(false)
    }
  })

  it('打开音频转发时才有音频参数', () => {
    expect(optionsFor({ audio: true })).toMatchObject({
      video: true,
      audio: true,
      audioCodec: 'opus',
    })
  })

  it('缺少 newDisplay 直接抛错（不能有兜底尺寸：dpi 与任何档位都不一致）', () => {
    expect(() => buildMirrorOptions(undefined, {})).toThrow(/newDisplay/)
    expect(() => buildMirrorOptions(undefined)).toThrow(/newDisplay/)
  })

  it('转发音频时才请求 Opus；关掉就完全不建音频采集', () => {
    // 抓系统音频会抢设备侧音频焦点（在播的 app 会暂停、会话结束时又自动续播），
    // 所以设置里的音频开关必须是真的开关 —— 早先这里写死 audio: true。
    expect(optionsFor({ audio: true }).audio).toBe(true)
    expect(optionsFor({ audio: true }).audioCodec).toBe('opus')
    // 用户 2026-09-21 明确要「投屏时手机不出声」= scrcpy 默认（不开 --audio-dup）。
    expect(optionsFor({ audio: true }).audioDup).toBeUndefined()

    expect(optionsFor({ audio: false }).audio).toBe(false)
    expect(optionsFor({ audio: false }).audioCodec).toBeUndefined()
    expect(optionsFor({ audio: false }).audioDup).toBeUndefined()

    expect(optionsFor(undefined).audio).toBe(false)
  })

  it('overrides the codec when the native engine requests it', () => {
    expect(optionsFor({ videoCodec: 'h265' }, { videoCodec: 'h264' }).videoCodec).toBe('h264')
  })

  it('不再对设备屏幕做任何干预', () => {
    // 「保持亮屏 / 启动后息屏」这一整类偏好于 2026-09-29 删除：keepActive / stayAwake
    // 都不能出现（turnOff 曾被错映射成 stayAwake，语义正好相反）。
    const options = optionsFor({ screenMode: 'keepActive' })
    expect(options.keepActive).toBeUndefined()
    expect(options.stayAwake).toBeUndefined()
  })
})

describe('formatNewDisplay', () => {
  it('拼成 scrcpy 的 <宽>x<高>/<dpi>，小数取整', () => {
    expect(formatNewDisplay({ width: 1080, height: 2400, dpi: 320 })).toBe('1080x2400/320')
    expect(formatNewDisplay({ width: 1080.4, height: 2400.6, dpi: 319.5 })).toBe('1080x2401/320')
  })

  it('非法尺寸抛错：宁可不建显示，也不静默开出一块错密度的', () => {
    for (const bad of [undefined, {}, { width: 0, height: 100, dpi: 100 }]) {
      expect(() => formatNewDisplay(bad)).toThrow(/虚拟显示/)
    }
    expect(() => formatNewDisplay({ width: 100, height: 100, dpi: 0 })).toThrow(/虚拟显示/)
    expect(() => formatNewDisplay({ width: 100, height: NaN, dpi: 160 })).toThrow(/虚拟显示/)
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
  it('运行时偏好只剩窗口行为', () => {
    expect(resolveRuntimePrefs({ alwaysOnTop: true, fullscreen: true })).toEqual({
      alwaysOnTop: true,
      fullscreen: true,
    })
    expect(resolveRuntimePrefs(undefined)).toEqual({ alwaysOnTop: false, fullscreen: false })
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
