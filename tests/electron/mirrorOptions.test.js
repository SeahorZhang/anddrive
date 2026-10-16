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
  mirrorRailTop,
  mirrorTitlebarNameLeft,
  mirrorTrafficLightPosition,
  mirrorAspectRatio,
  mirrorVirtualWindowSize,
  MIRROR_FRAME,
  MIRROR_RAIL,
  MIRROR_SCREEN_RADIUS,
  MIRROR_TITLEBAR,
  MIRROR_TRAFFIC_LIGHT_SIZE,
  MIRROR_VIRTUAL_WINDOW_WIDTH,
  MIRROR_VIRTUAL_WINDOW_HEIGHT,
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

// 窗口尺寸 = 照设备画面比例 fit 可用区。⚠️ 2026-10-16 起内缩恒为 0（黑框去掉、长条改成浮在画面上的
// 胶囊、标题栏退场）⇒ **窗口 = 画面**，不再有"把黑框与长条加回来"这一步。
describe('mirrorWindowBounds（窗口 = 画面，照设备画面比例 fit 可用区）', () => {
  const WORK = { width: 1440, height: 900 }
  const FALLBACK = { width: 850, height: 600 }
  const insets = mirrorScreenInsets()
  /** 窗口尺寸 → 画面那块矩形（渲染层真正用来放画面、算虚拟显示的矩形）。 */
  const screenOf = (b) => ({
    width: b.width - insets.left - insets.right,
    height: b.height - insets.top - insets.bottom,
  })

  it('竖屏手机：画面照设备比例把高顶满，窗口就是它（内缩恒 0）', () => {
    // 可用区 1440x900 减 80 系统余量 → 可用 1360x820；1080x2340 由高定：820 → 宽 378。
    const bounds = mirrorWindowBounds({ width: 1080, height: 2340 }, WORK)
    expect(bounds).toEqual({ width: 378, height: 820 })
    // 关键不变量：**画面**那块才是设备比例 —— 现在窗口就是画面，所以窗口本身也必须等比。
    expect(screenOf(bounds)).toEqual(bounds)
    expect(bounds.width / bounds.height).toBeCloseTo(1080 / 2340, 2)
  })

  it('横屏设备改用宽为准', () => {
    // 可用 1360x820，2340x1080 由宽定：1360 → 高 628。
    expect(mirrorWindowBounds({ width: 2340, height: 1080 }, WORK)).toEqual({
      width: 1360,
      height: 628,
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

// 2026-10-16 起**恒为 0**：黑框去掉（`MIRROR_FRAME.bezel = 0`）、长条改成浮在画面上的胶囊（不占位）、
// 标题栏随两档形态一起退场 ⇒ **画面 = 窗口**。
describe('mirrorScreenInsets（恒 0：画面 = 窗口）', () => {
  it('四边都是 0，且黑框确实归零了', () => {
    expect(MIRROR_FRAME.bezel).toBe(0)
    expect(mirrorScreenInsets()).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  })

  /**
   * ⚠️ 老参数（`railFloating`）**已经不看了** —— 两档形态退场后只剩一个形态。
   * 这条钉住"传什么都一样"，免得哪天有人以为它还能切形态。
   */
  it('传任何参数都是同一套（形态只剩一种）', () => {
    for (const arg of [undefined, false, true, 0, 1, 'x']) {
      expect(mirrorScreenInsets(arg)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
    }
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
 * 浮动态窗口没有标题栏 ⇒ 拖窗区整条没了，补的是**窗口顶边整条**的条（`floatDragHeight`）——
 * 它 2026-10-17 起还是 chrome 的**显形触发区**（用户：「鼠标移动到头部可拖拽的地方就展示出来」）。
 *
 * ⚠️ 第一版是左上角 80×28 的小方块（宽 = 三颗 + 名称让位那一截），被用户当场打回
 * （2026-10-14「app 投屏后不能拖拽了」）：那块地方**本来就盖着三颗彩虹键**，而三颗是 AppKit 画在
 * 网页内容**之上**的 ⇒ 方块中间一大块根本抓不到，剩下的只是几条缝。现在整条铺开、三颗收进画面左上角。
 *
 * ⚠️ **2026-10-17 三次加高**：`12 → 16`（「可拖拽高度再加4px」）→ `16 → 21`
 * （「可拖拽区域再加高5px」）→ `21 → 26`（「拖拽高度再加5px」）。
 * 前两次跟着三颗一起挪（守 `floatLightY === floatDragHeight`）；**第三次不守了** ——
 * 用户同一条里既要"三颗往上移"又要"这条加高 5px"，两个方向相反 ⇒ 三颗压进这条里 10px。
 *
 * ⚠️ 为什么压进去是安全的（**探针台实测，2026-10-17**，真光标 + `trafficLightPosition=(20,16)`）：
 * 三颗是 AppKit 画在网页**之上**的，但**只吃掉"按下"**（NSButton 处理 mouseDown），
 * **移动事件照常进 DOM** —— 指针从这条滑到三颗上只发 `pointermove`、**不触发 `pointerleave`**
 * （停在灯上 1.5s 也一条都不发）⇒ hover 显形不会闪断；代价只是灯本身那一小块按下是点灯。
 * 早前"三颗吃指针 ⇒ 那一列收不到 DOM 指针"的说法只对了一半，别再照它推。
 * ⚠️ 同一天它**不再写 `-webkit-app-region: drag`**（改成渲染层自己拖窗，理由见
 * `App.vue` 的 `onFloatDragDown` 那组）。
 */
describe('MIRROR_TITLEBAR.floatDragHeight（浮动态顶边那条：拖窗 + 显形触发）', () => {
  it('是个正数，三颗压在它里面，且三颗顶上仍留一截干净的带面', () => {
    expect(MIRROR_TITLEBAR.floatDragHeight).toBeGreaterThan(0)
    // 2026-10-17 第十一条起**不再是等式**（三颗正好让开），改成"三颗压在里面"。
    expect(MIRROR_TITLEBAR.floatLightY).toBeLessThan(MIRROR_TITLEBAR.floatDragHeight)
    // 压进去之后唯一要守的是：三颗**上方**还留一截干净的带面 —— 那一截没被 AppKit 吃掉，
    // 是"从窗口外滑进来"（以及在这一列按下拖窗）真正能用的落点。太薄就等于这一列没用了。
    expect(MIRROR_TITLEBAR.floatDragHeight - MIRROR_TITLEBAR.floatLightY).toBeGreaterThanOrEqual(8)
  })
})

/**
 * 三颗彩虹键的落点。窗口态那套（钉在标题栏里）现在**只剩算式** —— 判据 `mirrorRailFloats` 恒真
 * ⇒ 实际永远走"浮动态"那条：三颗落在**画面左上角**（用户 2026-10-14 第二条「mac 的 3 个按键放进投屏中」）。
 *
 * ⚠️ 判据跟着 `MIRROR_SCREEN_RADIUS` 一起换了两次口径（2026-10-16 半径 40 → 12；2026-10-17 20 → 28）：
 * 旧判据是"整组落在圆弧**内侧**"（40 的圆装得下直径 14 的三颗）；12 的圆根本装不下 ——
 * 改成"避开圆角切掉的那块"。那块只在 `x < r 且 y < r` 的方角里存在，于是当时顺手用了条捷径
 * 「落点的 x 或 y 有一个 ≥ 半径 ⇒ 整组在区外」。⚠️ **2026-10-17 半径到 28、落点又左移到 `x = 20`
 * 之后这条捷径失效**（它只是充分条件）⇒ 现在只认 `inCutCorner` 那条**按定义**算的判据
 * （落点在方角里、且到弧心 `(r,r)` 的距离 > r 才算被啃掉），再补一条"离弧心的余量 > 5px"。
 */
describe('mirrorTrafficLightPosition（三颗的落点）', () => {
  const { bezel } = MIRROR_FRAME
  const r = MIRROR_SCREEN_RADIUS
  const lightRadius = MIRROR_TRAFFIC_LIGHT_SIZE / 2
  const arcCenter = { x: bezel + r, y: bezel + r }
  /** 这个点落不落在**圆角切掉的那块**里（只在左上那个方角里、且在弧外侧）。 */
  const inCutCorner = ({ x, y }) =>
    x < arcCenter.x && y < arcCenter.y && Math.hypot(x - arcCenter.x, y - arcCenter.y) > r

  it('窗口态钉在标题栏里、垂直居中（算式仍在，实际不走这条）', () => {
    const expected = { x: MIRROR_TITLEBAR.lightX, y: 7 }
    expect(mirrorTrafficLightPosition()).toEqual(expected)
    expect(mirrorTrafficLightPosition(false)).toEqual(expected)
  })

  it('实际用的浮动态落点在画面左上角', () => {
    expect(mirrorTrafficLightPosition(true)).toEqual({
      x: MIRROR_TITLEBAR.floatLightX,
      y: MIRROR_TITLEBAR.floatLightY,
    })
  })

  /** 整组（含每颗的直径）覆盖的矩形四角都不在切掉区里 —— 有一角进去就是那颗被圆角啃掉一块。 */
  it('整组避开圆角切掉的那块', () => {
    const floating = mirrorTrafficLightPosition(true)
    const size = MIRROR_TRAFFIC_LIGHT_SIZE
    for (const corner of [
      { x: floating.x, y: floating.y },
      { x: floating.x + size, y: floating.y },
      { x: floating.x, y: floating.y + size },
      { x: floating.x + size, y: floating.y + size },
      { x: floating.x + lightRadius, y: floating.y + lightRadius },
    ]) {
      expect(inCutCorner(corner)).toBe(false)
    }
  })

  /** 余量那条：上面守的是"没被啃掉"，这条守的是"离被啃掉还有多远"。 */
  it('落点离圆弧还有余量 —— 半径再涨就得回头重算这个落点', () => {
    const floating = mirrorTrafficLightPosition(true)
    // ⚠️ 2026-10-17：半径 28 + 落点 `(20, 16)` ⇒ `x = 20 < r`，**"横或纵 ≥ 半径"那条捷径已经失效**
    // （它只是充分条件）。真正在守的是上面那条按定义算的 `inCutCorner`，这里再钉一条**余量**：
    // 整组离弧心最近的那个角（左上角）到弧心还有多远 —— 余量被吃光就是"圆角开始啃那颗灯"。
    // 现值：28 − hypot(20 − 28, 16 − 28) = 28 − hypot(8, 12) ≈ 28 − 14.42 ≈ 13.6
    // （第十一条把三颗往上挪 5px ⇒ 离弧心更远，这条是变安全的方向）。
    const clearance = r - Math.hypot(floating.x - arcCenter.x, floating.y - arcCenter.y)
    expect(clearance).toBeGreaterThan(5)
  })

  it('两档的落点不一样（翻转形态必须重设一次位置）', () => {
    expect(mirrorTrafficLightPosition(true)).not.toEqual(mirrorTrafficLightPosition(false))
  })
})

// 拖拽锁比例（`setAspectRatio`）的两个参数：比例 = 设备画面比例，余量 = 不参与比例的那几截。
describe('mirrorContentExtraSize / mirrorAspectRatio（只能按手机比例拖）', () => {
  const insets = mirrorScreenInsets()

  /** 锁的是**画面那块矩形**：内缩恒 0 ⇒ 余量恒 `{0, 0}`（窗口态没有别的占位了）。 */
  it('余量就是内缩的横竖总量（恒 0）', () => {
    expect(mirrorContentExtraSize()).toEqual({
      width: insets.left + insets.right,
      height: insets.top + insets.bottom,
    })
    expect(mirrorContentExtraSize()).toEqual({ width: 0, height: 0 })
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

// 独立虚拟屏那档的开窗尺寸：**920 x 660 两个点名值**（用户 2026-10-16：「宽度调成920px。
// 高度按 mac 屏幕比例调整」→「高度调整到660」）。采主屏那档不走这个函数（`session.js` 里按
// `deviceMirror` 分流），它照设备画面比例 fit 可用区（见上面 `mirrorWindowBounds` 那组）。
describe('mirrorVirtualWindowSize（独立虚拟屏那档：点名 920 x 660）', () => {
  const DEVICE = { width: 1200, height: 2608 }

  it('尺寸就是那两个常量，与设备分辨率无关', () => {
    expect(mirrorVirtualWindowSize(DEVICE)).toEqual({ width: 920, height: 660 })
    expect(MIRROR_VIRTUAL_WINDOW_WIDTH).toBe(920)
    expect(MIRROR_VIRTUAL_WINDOW_HEIGHT).toBe(660)
  })

  /** 换设备只影响「闸」开不开，不影响尺寸 —— 这一档的窗口形状不跟任何屏幕走。 */
  it('换一台设备还是同一对数（手机、平板、横屏都一样）', () => {
    for (const device of [
      { width: 1080, height: 2340 },
      { width: 2608, height: 1200 },
      { width: 1600, height: 2560 },
    ]) {
      expect(mirrorVirtualWindowSize(device)).toEqual({ width: 920, height: 660 })
    }
  })

  /** 设备分辨率只当闸用：读不到就不给固定尺寸（渲染层这时也不给显示尺寸），退回既有兜底。 */
  it('设备信息读不到 → 850x600（仍然与设备信息同生共死）', () => {
    for (const bad of [null, undefined, {}, { width: 0, height: 2608 }, { width: 'x', height: 2608 }]) {
      expect(mirrorVirtualWindowSize(bad)).toEqual({ width: 850, height: 600 })
    }
  })

  it('每次返回新对象，调用方就地改尺寸不会污染下一次', () => {
    const first = mirrorVirtualWindowSize(DEVICE)
    first.width = 1
    expect(mirrorVirtualWindowSize(DEVICE)).toEqual({ width: 920, height: 660 })
  })
})

// ⚠️ 2026-10-16 起**恒真**：长条从"画面右边那一条（占窗口宽、画面够宽才浮起来）"换成"浮在画面顶部
// 右侧的小胶囊"，它永远不占布局 ⇒ 两档形态的分化退场，判据失去分辨力。函数与调用链保留
// （主进程建窗那一拍、渲染层实时判、`mirror:railFloat` 报回），所以这里钉住"怎么传都是 true"。
describe('mirrorRailFloats（恒真：长条永远浮在画面上）', () => {
  it('任何宽度都返回 true —— 含 0 与非法值（两档几何现在一样，没有"安全侧"可分）', () => {
    for (const width of [0, -10, 1, 362, 640, 1000, null, undefined, Number.NaN, 'x']) {
      expect(mirrorRailFloats(width)).toBe(true)
      expect(mirrorRailFloats(width, true)).toBe(true)
      expect(mirrorRailFloats(width, false)).toBe(true)
    }
  })

  it('不传参数也是 true', () => {
    expect(mirrorRailFloats()).toBe(true)
  })
})

// 顶部那条胶囊的几何（2026-10-16）：它**不占布局**（浮在画面上），所以几何只有"落在哪"这一件事，
// 一像素都不进 `mirrorScreenInsets()` —— 这是它与前几版（右侧占一格）最根本的区别。
describe('MIRROR_RAIL / mirrorRailTop（顶部胶囊的几何）', () => {
  it('胶囊顶边由「与三颗彩虹键中线对齐」反推', () => {
    const center = MIRROR_TITLEBAR.floatLightY + MIRROR_TRAFFIC_LIGHT_SIZE / 2
    expect(mirrorRailTop()).toBe(Math.round(center - MIRROR_RAIL.height / 2))
    // 本机现值：16 + 7 − 14 = 9（三颗 2026-10-17 挪过三次 12 → 16 → 21 → 16 ⇒ 胶囊跟着走）。
    expect(mirrorRailTop()).toBe(9)
    // 与三颗中线一致（取整误差在半像素内）。
    expect(Math.abs(mirrorRailTop() + MIRROR_RAIL.height / 2 - center)).toBeLessThanOrEqual(0.5)
  })

  it('胶囊不占布局：内缩与比例锁余量里都没有它', () => {
    expect(mirrorScreenInsets()).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
    expect(mirrorContentExtraSize()).toEqual({ width: 0, height: 0 })
  })

  it('尺寸与位置都是正数（脏值会把胶囊丢到窗口外）', () => {
    expect(MIRROR_RAIL.height).toBeGreaterThan(0)
    expect(MIRROR_RAIL.right).toBeGreaterThanOrEqual(0)
    // 命中区必须比胶囊大一圈（用户这一轮要的"移入按钮区域"得有个够得着的区域）。
    expect(MIRROR_RAIL.hitPad).toBeGreaterThan(0)
    // 满屏那一档占的那一格宽还在（真全屏是「画面一格 + 长条一格」的两格排法，这一轮没动）。
    expect(MIRROR_RAIL.fullscreenWidth).toBeGreaterThan(0)
  })
})
