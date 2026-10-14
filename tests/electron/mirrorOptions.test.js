import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const {
  buildMirrorOptions,
  buildAudioOnlyOptions,
  AUDIO_SERVER_PATH,
  formatNewDisplay,
  parseBitRate,
  resolveNativeCodec,
  resolveRuntimePrefs,
  mirrorWindowBounds,
  mirrorScreenInsets,
  mirrorContentExtraSize,
  mirrorRailFloats,
  mirrorTitlebarNameLeft,
  mirrorTrafficLightPosition,
  mirrorAspectRatio,
  MIRROR_FRAME,
  MIRROR_RAIL,
  MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH,
  MIRROR_SCREEN_RADIUS,
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
      // 镜像会话**恒不带音频**（2026-10-14 第三条）：音频是设备级的，单独一条会话负责，
      // 见下面 `buildAudioOnlyOptions` 那一组。
      audio: false,
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
    // 其余参数与单应用镜像同规格：编码、码率、fps 照设置走，控制通道照旧（音频两条路都不带）。
    expect(options).toMatchObject({ video: true, audio: false, control: true, videoCodec: 'h265' })
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

  it('镜像会话永远不建音频采集：设置页那一项改由设备级音频会话消费', () => {
    // 用户 2026-10-14 第三条报障：「打开两个镜像声音重叠了，关掉一个镜像，声音又从电脑回到了手机」。
    // 根因是 Android 上音频**设备级**（只有一条 `AUDIO_DEVICE_OUT_REMOTE_SUBMIX`）：
    // 两条采集同时跑拿到同一份混音（各播一遍 = 重叠），释放任意一条会让 AudioPolicy 拆掉那条输出、
    // 剩下那条从此静音（声音回到手机）。⇒ 镜像会话一律 `audio: false`，音频另起一条会话
    // （`buildAudioOnlyOptions`），由该设备最早的窗口承载、关窗时移交。
    expect(optionsFor({ audio: true }).audio).toBe(false)
    expect(optionsFor({ audio: true }).audioCodec).toBeUndefined()
    expect(optionsFor({ audio: false }).audio).toBe(false)
    expect(optionsFor(undefined).audio).toBe(false)
    expect(buildMirrorOptions(LARGE, { videoCodec: 'h265', deviceMirror: true }).audio).toBe(false)
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

describe('buildAudioOnlyOptions（设备级音频会话）', () => {
  it('只有音频：不带视频、不带控制、不报设备名', () => {
    expect(buildAudioOnlyOptions()).toEqual({
      video: false,
      audio: true,
      control: false,
      // 上游把 64 字节设备名写在**第一个 socket** 上；音频-only 时那就是音频 socket，
      // 客户端会把设备名的头 4 字节当编码号（真机报
      // `Unknown audio codec metadata value: 1298735153` = 0x4D692031 = "Mi 1"）。
      sendDeviceMeta: false,
      sendStreamMeta: true,
      audioCodec: 'opus',
      audioSource: 'output',
    })
  })

  it('采集口径与原来一致：`output` 直采、不开 audioDup（投屏期间手机静音）', () => {
    // 用户 2026-09-21 明确要「投屏时手机不出声」= scrcpy 默认。`audio_dup` 是 `playback` 源
    // 那一支的 `ROUTE_FLAG_LOOP_BACK_RENDER`，对直采源是空操作，不能出现。
    expect(buildAudioOnlyOptions().audioDup).toBeUndefined()
    // 不给显示相关字段：音频会话不建虚拟显示（那条补丁的效果只作用于新建显示）。
    expect('newDisplay' in buildAudioOnlyOptions()).toBe(false)
    expect('flexDisplay' in buildAudioOnlyOptions()).toBe(false)
  })

  it('jar 走独立路径：server 一启动就删自己那份，两条会话推同一个路径会互相踩', () => {
    expect(AUDIO_SERVER_PATH).toMatch(/^\/data\/local\/tmp\/.+\.jar$/)
    expect(AUDIO_SERVER_PATH).not.toBe('/data/local/tmp/scrcpy-server.jar')
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
  it('运行时偏好只剩窗口行为 + 「要不要起那条设备级音频会话」，全屏默认关', () => {
    expect(resolveRuntimePrefs({ alwaysOnTop: true, fullscreen: true })).toEqual({
      alwaysOnTop: true,
      fullscreen: true,
      // 设置页那一项（默认开）：现在决定的是**要不要起那条设备级音频会话**，
      // 不再进镜像会话的参数（`buildMirrorOptions` 里 `audio` 恒 false）。
      audio: true,
    })
    expect(resolveRuntimePrefs(undefined)).toEqual({ alwaysOnTop: false, fullscreen: false, audio: true })
    expect(resolveRuntimePrefs({ fullscreen: 'yes' }).fullscreen).toBe(false)
    expect(resolveRuntimePrefs({ audio: false }).audio).toBe(false)
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

  /**
   * 浮动态（用户 2026-10-14 第二条：「上边头部就去掉，mac 的 3 个按键放进投屏中，标题去掉」）：
   * 两截**一起让掉** —— 右边那 86px 与上边那 28px 都归画面，四边只剩黑框。
   */
  it('浮动态四边只剩黑框：上边那截标题栏与右边那截长条一起归画面', () => {
    const floating = mirrorScreenInsets(true)
    const outside = mirrorScreenInsets(false)
    expect(floating.top).toBe(floating.bottom)
    expect(floating.top).toBe(floating.left)
    expect(outside.top - floating.top).toBe(MIRROR_TITLEBAR.height)
    expect(outside.right - floating.right).toBe(MIRROR_RAIL.width)
  })
})

/** app 名称的左起位置：让开三颗（名称是我们画的，落点自己算）。 */
describe('mirrorTitlebarNameLeft（名称让开三颗）', () => {
  it('落在三颗的右沿之外，不会压到它们', () => {
    const lightsRight = MIRROR_TITLEBAR.lightX + MIRROR_TITLEBAR.lightGroupWidth
    expect(mirrorTitlebarNameLeft()).toBeGreaterThan(lightsRight)
    expect(mirrorTitlebarNameLeft()).toBe(lightsRight + MIRROR_TITLEBAR.nameGap)
  })
})

/**
 * 浮动态窗口没有标题栏 ⇒ 拖窗区整条没了，补的是**窗口顶边整条**看不见的条（`floatDragHeight`）。
 *
 * ⚠️ 第一版是左上角 80×28 的小方块（宽 = 三颗 + 名称让位那一截），被用户当场打回
 * （2026-10-14「app 投屏后不能拖拽了」）：那块地方**本来就盖着三颗彩虹键**，而三颗是 AppKit 画在
 * 网页内容**之上**的 ⇒ 方块中间一大块根本抓不到，剩下的只是几条缝。现在整条铺开，三颗的落点
 * 下移到这条的下沿让开它（见下面那条等式）。
 */
describe('MIRROR_TITLEBAR.floatDragHeight（浮动态顶边那条拖窗区）', () => {
  it('是个正数，且三颗的落点正好让开它（不压拖窗区）', () => {
    expect(MIRROR_TITLEBAR.floatDragHeight).toBeGreaterThan(0)
    expect(MIRROR_TITLEBAR.floatLightY).toBe(MIRROR_TITLEBAR.floatDragHeight)
  })
})

/**
 * 三颗彩虹键**两档形态两个落点**（用户 2026-10-14 第四条：「mac 3 个彩虹键往右往下点，超出屏幕了」）。
 *
 * 浮动态窗口顶就是画面顶（`mirrorScreenInsets(true).top` 只剩黑框）⇒ 三颗是"放进投屏里"的，
 * 必须落在**画面那块圆角矩形**内侧。画面在 `(bezel, bezel)`、圆角半径 `MIRROR_SCREEN_RADIUS`，
 * 那个四分之一圆的圆心在 `(bezel + r, bezel + r)`。
 */
describe('mirrorTrafficLightPosition（两档形态两个落点）', () => {
  const { bezel } = MIRROR_FRAME
  const r = MIRROR_SCREEN_RADIUS
  const cx = bezel + r
  const cy = bezel + r
  const fromArcCenter = ({ x, y }) => Math.hypot(x - cx, y - cy)

  it('窗口态钉在标题栏里、垂直居中（与窗口宽无关）', () => {
    const expected = { x: MIRROR_TITLEBAR.lightX, y: 7 }
    expect(mirrorTrafficLightPosition()).toEqual(expected)
    expect(mirrorTrafficLightPosition(false)).toEqual(expected)
  })

  /** 这条同时是**当时那个报障的复现**：窗口态那套落点直接搬到浮动态就是压在圆角上。 */
  it('旧的窗口态落点确实落在圆角切掉的那块里（报障的根因）', () => {
    expect(fromArcCenter(mirrorTrafficLightPosition(false))).toBeGreaterThan(r)
  })

  it('浮动态让开画面圆角：整组落在圆弧内侧，且留有余量', () => {
    const floating = mirrorTrafficLightPosition(true)
    // 最左那颗的**外沿**：圆心在落点右下方半个灯径处，最外沿再往外半个灯径。
    const lightRadius = 7
    const farthest = fromArcCenter({ x: floating.x + lightRadius, y: floating.y + lightRadius }) + lightRadius
    expect(farthest).toBeLessThan(r)
    expect(r - farthest).toBeGreaterThanOrEqual(5)
  })

  it('两档的落点不一样（翻转形态必须重设一次位置）', () => {
    expect(mirrorTrafficLightPosition(true)).not.toEqual(mirrorTrafficLightPosition(false))
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

// 画面够宽就把长条改成「浮在画面里」（用户 2026-10-14）：判据全项目只有这一处，
// 主进程建窗口时算一次、渲染层实时跟着窗口大小算，两边都调它。
describe('mirrorRailFloats（画面宽 ≥ 640 就把长条改成浮在画面里）', () => {
  const OUTSIDE = mirrorScreenInsets(false)
  const FLOATING = mirrorScreenInsets(true)
  /** 画面区那一格的宽（渲染层量 `.mirror-main`）= 画面 + 长条占的那一截。 */
  const areaOf = (screenWidth, floating) =>
    screenWidth + (floating ? FLOATING.left + FLOATING.right : OUTSIDE.left + OUTSIDE.right)

  it('窄画面（普通竖屏手机窗口，画面约 362）不浮；正好 640 才浮', () => {
    expect(mirrorRailFloats(areaOf(362, false))).toBe(false)
    expect(mirrorRailFloats(areaOf(MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH, false))).toBe(true)
    expect(mirrorRailFloats(areaOf(MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH - 1, false))).toBe(false)
  })

  /** 两个形态各有一条线（差一条长条宽）：否则判据会被自己的结果推着走，拖窗口经过临界点来回跳。 */
  it('迟滞：浮着的时候画面一定 ≥ 阈值，收回去之后也稳定', () => {
    const at640 = areaOf(MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH, false)
    // 在外面那套几何下画面正好 640 ⇒ 该浮；浮起来之后同一格宽度算出来的画面还是 640 ⇒ 不回跳。
    expect(mirrorRailFloats(at640, false)).toBe(true)
    expect(mirrorRailFloats(at640, true)).toBe(true)
    // 再窄 1px：浮着时画面 639 ⇒ 收回去；收回去之后按外面那套几何算是 553 ⇒ 也不会当场翻回来。
    const below = areaOf(MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH - 1, true)
    expect(mirrorRailFloats(below, true)).toBe(false)
    expect(mirrorRailFloats(below, false)).toBe(false)
    // 迟滞带里两种结论都自洽：同一条格宽，浮着的那个不会跳回去。
    const band = areaOf(MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH + 10, false)
    expect(mirrorRailFloats(band, false)).toBe(true)
    expect(mirrorRailFloats(band - MIRROR_RAIL.width, true)).toBe(true)
  })

  it('量不到宽（还没排版 / 非法值）维持「在外面」：浮起来是盖住画面的那个动作', () => {
    for (const bad of [0, -10, null, undefined, Number.NaN, 'x']) {
      expect(mirrorRailFloats(bad)).toBe(false)
      expect(mirrorRailFloats(bad, true)).toBe(false)
    }
  })
})

describe('长条浮在画面里那一档的几何（右边 86px 与上边 28px 一起归画面）', () => {
  const WORK = { width: 1440, height: 900 }
  const FLOATING = mirrorScreenInsets(true)

  it('内缩右边只剩黑框', () => {
    expect(FLOATING.right).toBe(FLOATING.left)
    expect(mirrorScreenInsets(false).right - FLOATING.right).toBe(MIRROR_RAIL.width)
  })

  /** 漏改这一项：「画面 = 设备比例」当场破掉（画面比设备比例宽一条长条、高一截标题栏）。 */
  it('比例锁的余量两截都少掉：右边一条长条宽、上边一条标题栏高', () => {
    expect(mirrorContentExtraSize(0, true).width).toBe(mirrorContentExtraSize(0).width - MIRROR_RAIL.width)
    expect(mirrorContentExtraSize(240, true).width).toBe(mirrorContentExtraSize(240).width - MIRROR_RAIL.width)
    expect(mirrorContentExtraSize(0, true).height).toBe(
      mirrorContentExtraSize(0).height - MIRROR_TITLEBAR.height,
    )
  })

  it('横形显示：宽被可用区顶住 ⇒ 窗口宽不变，那 86px 与 28px 归画面，画面仍是设备比例', () => {
    const outside = mirrorWindowBounds({ width: 2340, height: 1080 }, WORK)
    const floating = mirrorWindowBounds({ width: 2340, height: 1080 }, WORK, true)
    expect(floating.width).toBe(outside.width)
    const screen = {
      width: floating.width - FLOATING.left - FLOATING.right,
      height: floating.height - FLOATING.top - FLOATING.bottom,
    }
    const outsideInsets = mirrorScreenInsets(false)
    expect(screen.width).toBeGreaterThan(
      outside.width - outsideInsets.left - outsideInsets.right,
    )
    expect(screen.height).toBeGreaterThan(
      outside.height - outsideInsets.top - outsideInsets.bottom,
    )
    expect(screen.width / screen.height).toBeCloseTo(2340 / 1080, 2)
    expect(floating.width).toBeLessThanOrEqual(WORK.width - 80)
    expect(floating.height).toBeLessThanOrEqual(WORK.height - 80)
  })

  /**
   * 竖形显示：高顶满 ⇒ 窗口高不变（两种形态都是"可用高 + 各自内缩" = 工作区减余量），
   * 变的是**画面**：标题栏让出来的 28px 归画面 ⇒ 画面长高 28、按设备比例再宽一点，
   * 窗口宽 = 那个新画面宽 + 只剩黑框的 8px。
   */
  it('竖形显示：窗口高不变，画面长高 28 并按比例宽一点', () => {
    // 超高可用区（6K 那一类）才够得到「竖屏画面 640 宽」这条线。
    const TALL = { width: 3008, height: 1692 }
    const outside = mirrorWindowBounds({ width: 1080, height: 2340 }, TALL)
    const outsideInsets = mirrorScreenInsets(false)
    const pictureWidth = outside.width - outsideInsets.left - outsideInsets.right
    expect(pictureWidth).toBeGreaterThanOrEqual(MIRROR_RAIL_FLOAT_MIN_SCREEN_WIDTH)
    expect(mirrorRailFloats(outside.width, false)).toBe(true)
    const floating = mirrorWindowBounds({ width: 1080, height: 2340 }, TALL, true)
    // 高顶满 ⇒ 两种形态的窗口高都是「工作区高 − 余量」：让出来的 28px 落在画面上，不在窗口上。
    expect(floating.height).toBe(outside.height)
    expect(floating.width).toBeLessThan(outside.width)
    const picture = {
      width: floating.width - FLOATING.left - FLOATING.right,
      height: floating.height - FLOATING.top - FLOATING.bottom,
    }
    expect(picture.height).toBe(
      outside.height - outsideInsets.top - outsideInsets.bottom + MIRROR_TITLEBAR.height,
    )
    expect(picture.width).toBeCloseTo(pictureWidth + MIRROR_TITLEBAR.height * (1080 / 2340), 0)
    expect(picture.width / picture.height).toBeCloseTo(1080 / 2340, 2)
  })
})
