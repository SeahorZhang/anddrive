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
  mirrorScreenInsets,
  mirrorContentExtraSize,
  mirrorAspectRatio,
  MIRROR_RAIL,
  MIRROR_TITLEBAR,
  mirrorsMainDisplay,
  supportsDesktopMode,
} = await import('../../electron/mirror/options.js')

describe('mirrorsMainDisplay（Android 13 及以下点应用不建虚拟显示）', () => {
  it('API 33 是上限：33 走主屏，34 起仍然建虚拟显示', () => {
    expect(mirrorsMainDisplay(33)).toBe(true)
    expect(mirrorsMainDisplay(34)).toBe(false)
  })

  it('更老的版本一样走主屏', () => {
    expect(mirrorsMainDisplay(29)).toBe(true)
  })

  /** 读不到版本 ≠ 老设备：形态不靠猜，读不到就维持原来的虚拟显示那条路。 */
  it('版本读不到（null/undefined/非数字）时不走主屏', () => {
    expect(mirrorsMainDisplay(null)).toBe(false)
    expect(mirrorsMainDisplay(undefined)).toBe(false)
    expect(mirrorsMainDisplay(NaN)).toBe(false)
    expect(mirrorsMainDisplay('33')).toBe(false)
    expect(mirrorsMainDisplay(0)).toBe(false)
  })
})

describe('supportsDesktopMode（整机镜像里那颗「桌面模式」按钮）', () => {
  it('Android 14（API 34）起可用：33 及以下那块虚拟显示拿不到焦点', () => {
    expect(supportsDesktopMode(34)).toBe(true)
    expect(supportsDesktopMode(36)).toBe(true)
    expect(supportsDesktopMode(33)).toBe(false)
    expect(supportsDesktopMode(29)).toBe(false)
  })

  /**
   * ⚠️ 这里与 `mirrorsMainDisplay` **反过来**：那边读不到版本 = 「照旧建虚拟显示」（老行为），
   * 这边读不到版本 = 「先不给入口」。多一颗按钮的代价是让 13 及以下的用户点开一块操作不了的显示，
   * 而用户 2026-10-11 的原话就是「安卓 14 往上」。
   */
  it('版本读不到（null/undefined/非数字）时不给这个入口', () => {
    expect(supportsDesktopMode(null)).toBe(false)
    expect(supportsDesktopMode(undefined)).toBe(false)
    expect(supportsDesktopMode(NaN)).toBe(false)
    expect(supportsDesktopMode('34')).toBe(false)
    expect(supportsDesktopMode(0)).toBe(false)
  })
})

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
  /**
   * 默认模式：尺寸 = 窗口画面区的物理像素，密度按主屏长边等比（`scaleDisplayDpi`）。
   * flex 显示在上游必须带密度（`prepare()` 对 `dpi == 0` 的 flex 断言），所以给全 `{w,h,dpi}`。
   */
  const PHYSICAL = { width: 756, height: 1640, dpi: 308 }
  /** 大屏模式：尺寸 = 窗口 CSS × 档位倍率，密度同倍。 */
  const TIERED = { width: 1080, height: 2400, dpi: 320 }
  const LARGE = { largeScreenDisplay: true }
  const optionsFor = (config, overrides = {}) =>
    buildMirrorOptions(config, { videoCodec: 'h265', display: PHYSICAL, ...overrides })

  it('默认（上游原生 server）：尺寸与密度都带全，并开 flex 让显示跟着窗口', () => {
    const options = optionsFor(undefined)
    expect(options).toMatchObject({
      video: true,
      // 音频与画面在**同一条会话**里：设置页那一项（默认开）决定 `audio`。
      audio: true,
      control: true,
      sendStreamMeta: true,
      videoCodec: 'h265',
      // 默认码率跟着默认档位走：清晰档 3x 实测 ~27Mbps，默认上限 32M（见 DISPLAY_QUALITY_BIT_RATES）。
      videoBitRate: 32_000_000,
      maxFps: 60,
      newDisplay: '756x1640/308',
      // flex 与尺寸是一家的：开了 flex 才有官方 `resizeDisplay`（服务端对非 flex 显示直接抛错）。
      flexDisplay: true,
      // 镜像里不显示手机的状态栏（整块显示留给应用）。
      vdSystemDecorations: false,
    })
  })

  it('大屏模式带档位倍率的尺寸与密度，同样开 flex', () => {
    expect(optionsFor(LARGE, { display: TIERED })).toMatchObject({
      newDisplay: '1080x2400/320',
      flexDisplay: true,
    })
  })

  /**
   * 采主屏（整机镜像，以及 Android 13 及以下点应用）：上游 `Server.java:144-149` 按**这个键在不在**分叉，
   * 不发 `new_display` 才是不建虚拟显示、直接采主屏（发空串仍会新建一块）。
   */
  it('采主屏：不发 new_display，flex 与 vd_system_decorations 一起没有', () => {
    const options = buildMirrorOptions(undefined, { videoCodec: 'h265', deviceMirror: true })
    expect(options.newDisplay).toBeUndefined()
    expect(options.flexDisplay).toBeUndefined()
    expect(options.vdSystemDecorations).toBeUndefined()
    // 其余参数与单应用镜像同规格：编码、码率、fps 照设置走，控制通道与音频照旧。
    expect(options).toMatchObject({ video: true, audio: true, control: true, videoCodec: 'h265' })
    // 大屏模式那份补丁的效果只作用于新建显示，整机镜像这一档带着它也建不出显示。
    expect(buildMirrorOptions(LARGE, { videoCodec: 'h265', deviceMirror: true }).newDisplay)
      .toBeUndefined()
  })

  it('整机镜像还塞进来一块显示尺寸 = 接线错误，抛出来而不是静默忽略', () => {
    expect(() =>
      buildMirrorOptions(undefined, { videoCodec: 'h265', deviceMirror: true, display: PHYSICAL }),
    ).toThrow(/不建虚拟显示/)
  })

  it('任何配置组合都不把系统装饰打开', () => {
    for (const config of [undefined, { audio: true }, { maxFps: 120 }, { videoCodec: 'av1' }]) {
      expect(optionsFor(config).vdSystemDecorations).toBe(false)
    }
  })

  it('转发音频时才请求 Opus；显式关掉就完全不建音频采集', () => {
    // 抓系统音频（`REMOTE_SUBMIX` 直采）会抢设备侧的音频路由：投屏期间手机不出声。
    // 这一档在建会话时定死、控制协议里没有音频路由消息 ⇒ 设置页那一项只影响下次开会话，
    // 没有运行时切换（2026-10-11 试过「独立音频会话」那条绕法，代价是每条会话各推一次 jar，已删）。
    expect(optionsFor({ audio: true }).audio).toBe(true)
    expect(optionsFor({ audio: true }).audioCodec).toBe('opus')
    // 用户 2026-09-21 明确要「投屏时手机不出声」= scrcpy 默认（不开 --audio-dup）。
    expect(optionsFor({ audio: true }).audioDup).toBeUndefined()

    expect(optionsFor({ audio: false }).audio).toBe(false)
    expect(optionsFor({ audio: false }).audioCodec).toBeUndefined()
    expect(optionsFor({ audio: false }).audioDup).toBeUndefined()

    // 没配置 = 默认值 = 开（2026-10-08 翻的默认，见 `DEFAULT_SCRCPY_CONFIG.audio`）。
    expect(optionsFor(undefined).audio).toBe(true)
  })

  it('拿不到设备信息时：空串 + **不开 flex**，也不自己编数字', () => {
    const options = buildMirrorOptions(undefined, { videoCodec: 'h265' })
    expect(options.newDisplay).toBe('')
    // flex 缺尺寸会撞上游 `prepare()` 的断言，所以这一条必须跟着关。
    expect('flexDisplay' in options).toBe(false)
    expect(buildMirrorOptions({}, { videoCodec: 'h265', display: null }).newDisplay).toBe('')
    // 大屏模式没有尺寸就没有密度口径，宁可抛也不猜（2026-09-28 那条教训）。
    expect(() => buildMirrorOptions(LARGE, { videoCodec: 'h265' })).toThrow(/虚拟显示/)
    expect(() => buildMirrorOptions(LARGE, { videoCodec: 'h265', display: {} })).toThrow(/虚拟显示/)
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
  it('运行时偏好只剩窗口行为，全屏默认关', () => {
    expect(resolveRuntimePrefs({ alwaysOnTop: true, fullscreen: true })).toEqual({
      alwaysOnTop: true,
      fullscreen: true,
    })
    expect(resolveRuntimePrefs(undefined)).toEqual({ alwaysOnTop: false, fullscreen: false })
    expect(resolveRuntimePrefs({ fullscreen: 'yes' }).fullscreen).toBe(false)
  })
})

describe('mirrorWindowBounds（窗口 = 画面 + 那圈常驻黑框）', () => {
  const WORK = { width: 1440, height: 900 }
  const FALLBACK = { width: 850, height: 600 }
  const insets = mirrorScreenInsets()
  /** 窗口尺寸 → 画面那块矩形（渲染层真正用来放画面、算虚拟显示的矩形）。 */
  const screenOf = (b) => ({
    width: b.width - insets.left - insets.right,
    height: b.height - insets.top - insets.bottom,
  })

  it('竖屏手机：画面照设备比例把高顶满，窗口再把黑框与右边那条加回来', () => {
    // 可用区 1440x900 减 80 系统余量，再减内缩（横 4+(4+86)=94、纵 (4+28)+4=36 —— 上边那条标题栏）
    // → 画面可用 1266x784；1080x2340 由高定：784 → 宽 362。窗口 = 362+94 x 784+36。
    const bounds = mirrorWindowBounds({ width: 1080, height: 2340 }, WORK)
    expect(bounds).toEqual({ width: 456, height: 820 })
    // 关键不变量：**画面**那块才是设备比例。让窗口本身等比（= 不把内缩算进去）
    // 画面就会比设备比例窄，圆角里露出 letterbox 黑条。
    expect(screenOf(bounds)).toEqual({ width: 362, height: 784 })
  })

  it('横屏设备改用宽为准', () => {
    // 画面可用 1266x784，2340x1080 由宽定：1266 → 高 584。窗口 = 1266+94 x 584+36。
    expect(mirrorWindowBounds({ width: 2340, height: 1080 }, WORK)).toEqual({
      width: 1360,
      height: 620,
    })
  })

  it('任何形状都不越出可用区、画面不算出 0 边；画面区始终是设备比例', () => {
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
      expect(bounds.width - insets.left - insets.right).toBeGreaterThanOrEqual(1)
      expect(bounds.height - insets.top - insets.bottom).toBeGreaterThanOrEqual(1)
    }
    // 正常比例下等比是准的（极端带鱼屏被 1px 下限收过，不再谈比例）。
    for (const size of [
      { width: 1080, height: 2340 },
      { width: 2340, height: 1080 },
      { width: 1440, height: 900 },
    ]) {
      const screen = screenOf(mirrorWindowBounds(size, WORK))
      expect(screen.width / screen.height).toBeCloseTo(size.width / size.height, 2)
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

describe('mirrorScreenInsets（黑框四边 + 上边标题栏 + 右边长条）', () => {
  /** 长条挪到画面外边 ⇒ 它进内缩的**右边**，左边仍只有黑框。这条钉住不对称是有意为之。 */
  it('内缩右边多一条长条、上边多一条标题栏（画面才等于设备比例，键与名称才在手机外面）', () => {
    const insets = mirrorScreenInsets()
    expect(insets.right - insets.left).toBe(MIRROR_RAIL.width)
    expect(insets.top - insets.bottom).toBe(MIRROR_TITLEBAR.height)
    // 左与下仍然只有那圈黑框 —— 两条 chrome 都在另外两侧。
    expect(insets.left).toBe(insets.bottom)
  })
})

// 拖拽锁比例（`setAspectRatio`）的两个参数：比例 = 设备画面比例，余量 = 不参与比例的那几截。
describe('mirrorContentExtraSize / mirrorAspectRatio（只能按手机比例拖）', () => {
  const insets = mirrorScreenInsets()

  /** 锁的是**画面那块矩形**：窗口多出来的黑框 + 长条必须整截算余量，漏一条就等于把窗口等比锁。 */
  it('余量就是内缩的横竖总量，且只加在宽上（dev 边栏那一截同属窗口）', () => {
    expect(mirrorContentExtraSize()).toEqual({
      width: insets.left + insets.right,
      height: insets.top + insets.bottom,
    })
    expect(mirrorContentExtraSize(240)).toEqual({
      width: insets.left + insets.right + 240,
      height: insets.top + insets.bottom,
    })
    // 非法/负的宽度不该把余量算小（画面会被挤 = 发一条 resizeDisplay）。
    expect(mirrorContentExtraSize(-100)).toEqual(mirrorContentExtraSize())
    expect(mirrorContentExtraSize('x')).toEqual(mirrorContentExtraSize())
  })

  it('比例取设备画面比例（与 `mirrorWindowBounds` 同一个来源）', () => {
    expect(mirrorAspectRatio({ width: 1200, height: 2608 })).toBe(1200 / 2608)
    expect(mirrorAspectRatio({ width: 1080, height: 2340 })).toBe(1080 / 2340)
  })

  /** 读不到分辨率 = 不锁（0 是上游的「取消比例」），别拿窗口那对数反推一个假比例。 */
  it('读不到设备分辨率时回 0 = 不锁', () => {
    expect(mirrorAspectRatio(null)).toBe(0)
    expect(mirrorAspectRatio(undefined)).toBe(0)
    expect(mirrorAspectRatio({})).toBe(0)
    expect(mirrorAspectRatio({ width: 0, height: 2608 })).toBe(0)
    expect(mirrorAspectRatio({ width: 1200, height: -8 })).toBe(0)
    expect(mirrorAspectRatio({ width: 'x', height: 2608 })).toBe(0)
  })
})
