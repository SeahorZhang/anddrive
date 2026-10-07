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
  /** 默认模式：只给尺寸、不给密度（上游 `scaleDpi` 按长边等比缩，长边 dp 数照主屏）。 */
  const PHYSICAL = { width: 1080, height: 2400 }
  /** 大屏模式：尺寸 = 窗口 CSS × 档位倍率，密度同倍。 */
  const TIERED = { width: 1080, height: 2400, dpi: 320 }
  const LARGE = { largeScreenDisplay: true }
  const optionsFor = (config, overrides = {}) =>
    buildMirrorOptions(config, { videoCodec: 'h265', display: PHYSICAL, ...overrides })

  it('默认（上游原生 server）：给尺寸但不给密度，也不开 flex', () => {
    const options = optionsFor(undefined)
    expect(options).toMatchObject({
      video: true,
      audio: false,
      control: true,
      sendStreamMeta: true,
      videoCodec: 'h265',
      // 默认码率跟着默认档位走：清晰档 3x 实测 ~27Mbps，默认上限 32M（见 DISPLAY_QUALITY_BIT_RATES）。
      videoBitRate: 32_000_000,
      maxFps: 60,
      // 尺寸来自窗口画面区的物理像素；不带 `/dpi` 是让 server 自己 scaleDpi。
      newDisplay: '1080x2400',
      // 镜像里不显示手机的状态栏（整块显示留给应用）。
      vdSystemDecorations: false,
    })
    // 默认模式连 `flex_display` 都不下发（上游默认 false）：没 flex 就没官方 resizeDisplay
    // （服务端对非 flex 显示直接抛错）—— 不给 flex 就等于不给「跟随窗口」。
    expect('flexDisplay' in options).toBe(false)
  })

  it('大屏模式带密度开显示，并开 flex 供窗口跟随', () => {
    expect(optionsFor(LARGE, { display: TIERED })).toMatchObject({
      newDisplay: '1080x2400/320',
      // 跟随窗口 = 官方 `resizeDisplay` 控制消息，服务端 `requestResize` 只认 flex 显示。
      flexDisplay: true,
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

  it('拿不到设备比例时不给尺寸 = 空串（上游默认主屏尺寸与密度），不自己编数字', () => {
    expect(buildMirrorOptions(undefined, { videoCodec: 'h265' }).newDisplay).toBe('')
    expect(buildMirrorOptions({}, { videoCodec: 'h265', display: null }).newDisplay).toBe('')
    // 大屏模式没有尺寸就没有密度口径，宁可抛也不猜（2026-09-28 那条教训）。
    expect(() => buildMirrorOptions(LARGE, { videoCodec: 'h265' })).toThrow(/虚拟显示/)
    expect(() => buildMirrorOptions(LARGE, { videoCodec: 'h265', display: {} })).toThrow(/虚拟显示/)
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

  it('不给密度时只写 <宽>x<高>（让上游按长边等比 scaleDpi，版式仍照主屏）', () => {
    expect(formatNewDisplay({ width: 756, height: 1640 })).toBe('756x1640')
    expect(formatNewDisplay({ width: 756, height: 1640, dpi: null })).toBe('756x1640')
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

  it('auto：H.265 优先，两头任一说「不行」就退到 H.264', () => {
    const both = { device: { h264: true, h265: true }, local: { h264: true, h265: true } }
    expect(resolveNativeCodec({ videoCodec: 'auto' }, both)).toEqual({ codec: 'h265', downgraded: false })
    expect(resolveNativeCodec({ videoCodec: 'auto' }, { ...both, local: { h264: true, h265: false } }))
      .toEqual({ codec: 'h264', downgraded: false })
    expect(resolveNativeCodec({ videoCodec: 'auto' }, { ...both, device: { h264: true, h265: false } }))
      .toEqual({ codec: 'h264', downgraded: false })
  })

  it('能力没探测到（null）就当未知，不拦用户选的编码', () => {
    expect(resolveNativeCodec({ videoCodec: 'auto' }, { device: null, local: null }))
      .toEqual({ codec: 'h265', downgraded: false })
    expect(resolveNativeCodec({ videoCodec: 'av1' }, null)).toEqual({ codec: 'av1', downgraded: false })
  })

  it('显式选了不支持的编码：回落并报告 downgraded', () => {
    const caps = { device: { h264: true, h265: false }, local: { h264: true, h265: true } }
    expect(resolveNativeCodec({ videoCodec: 'h265' }, caps)).toEqual({ codec: 'h264', downgraded: true })
  })

  it('默认值是 auto', () => {
    expect(resolveNativeCodec(undefined, { device: null, local: { h264: true, h265: false } }))
      .toEqual({ codec: 'h264', downgraded: false })
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
  const WORK = { width: 1440, height: 900 }
  const FALLBACK = { width: 850, height: 600 }

  it('照设备画面比例等比 fit 进可用区减 80 边距（竖屏手机 → 竖窗，长边先顶满）', () => {
    // 1080x2340 的手机：可用区 1360x820，高顶满 → 820，宽按比 = 378。
    expect(mirrorWindowBounds({ width: 1080, height: 2340 }, WORK)).toEqual({
      width: 378,
      height: 820,
    })
  })

  it('横屏设备改用宽为准', () => {
    expect(mirrorWindowBounds({ width: 2340, height: 1080 }, WORK)).toEqual({
      width: 1360,
      height: 628,
    })
  })

  it('任何形状都不越出可用区、也不算出 0 边', () => {
    for (const size of [
      { width: 1080, height: 2340 },
      { width: 2340, height: 1080 },
      { width: 1, height: 4000 },
      { width: 4000, height: 1 },
      { width: 1440, height: 900 },
    ]) {
      const bounds = mirrorWindowBounds(size, WORK)
      expect(bounds.width).toBeLessThanOrEqual(WORK.width - 80)
      expect(bounds.height).toBeLessThanOrEqual(WORK.height - 80)
      expect(bounds.width).toBeGreaterThanOrEqual(1)
      expect(bounds.height).toBeGreaterThanOrEqual(1)
    }
    // 正常比例下等比是准的（极端带鱼屏被 1px 下限收过，不再谈比例）。
    for (const size of [
      { width: 1080, height: 2340 },
      { width: 2340, height: 1080 },
      { width: 1440, height: 900 },
    ]) {
      const bounds = mirrorWindowBounds(size, WORK)
      expect(bounds.width / bounds.height).toBeCloseTo(size.width / size.height, 2)
    }
  })

  it('读不到设备比例或可用区不可用 → 退回既有 850x600（渲染层同时不给显示尺寸）', () => {
    for (const bad of [null, undefined, { width: 0, height: 100 }, { width: 'x', height: 100 }]) {
      expect(mirrorWindowBounds(bad, WORK)).toEqual(FALLBACK)
    }
    expect(mirrorWindowBounds({ width: 1080, height: 2340 }, null)).toEqual(FALLBACK)
    expect(mirrorWindowBounds({ width: 1080, height: 2340 }, { width: 40, height: 40 })).toEqual(
      FALLBACK,
    )
  })

  it('每次返回新对象，调用方就地改尺寸不会污染下一次（兜底那份也不能被改坏）', () => {
    const first = mirrorWindowBounds(null, WORK)
    first.width = 1
    first.height = 2
    expect(mirrorWindowBounds(null, WORK)).toEqual(FALLBACK)
  })
})
