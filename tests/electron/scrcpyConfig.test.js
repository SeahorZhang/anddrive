import { describe, expect, it, vi, beforeEach } from 'vitest'
import { promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const isReadable = (file) => {
  try {
    return statSync(file).isFile() && statSync(file).size > 0
  } catch {
    return false
  }
}

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-scrcpy-config-'))

vi.mock('electron', () => ({
  app: { getPath: (name) => (name === 'userData' ? userDataDir : '') },
  ipcMain: { handle: vi.fn() },
}))

// 纯函数从它住的地方 import（shared/），不借道主进程模块的再导出。
const {
  DEFAULT_SCRCPY_CONFIG,
  normalizeScrcpyConfig,
  scaleDisplayDpi,
  scrcpyServerResource,
  computeDisplayMetrics,
  DISPLAY_BASE_DPI,
  DISPLAY_PIXEL_SCALE,
  DISPLAY_QUALITY_TIERS,
  DISPLAY_QUALITY_BIT_RATES,
  VIDEO_CODEC_CHOICES,
  VIDEO_ENCODER_PROBE_CMD,
  isCodecUsable,
  parseEncoderMimes,
  planCodecList,
  resolveVideoCodec,
} = await import('../../shared/scrcpyConfig.js')

const {
  loadScrcpyConfig,
  saveScrcpyConfig,
  currentScrcpyConfig,
  getScrcpyConfigState,
} = await import('../../electron/scrcpyConfig.js')

const configFile = path.join(userDataDir, 'scrcpy-config.json')

describe('normalizeScrcpyConfig', () => {
  it('returns defaults for missing or non-object input', () => {
    expect(normalizeScrcpyConfig(undefined)).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
    expect(normalizeScrcpyConfig(null)).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
    expect(normalizeScrcpyConfig('nope')).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })

  it('keeps valid overrides', () => {
    expect(
      normalizeScrcpyConfig({
        bitRate: '8M',
        maxFps: 90,
        videoCodec: 'av1',
        audio: true,
        alwaysOnTop: true,
        fullscreen: true,
        quality: 'native',
      }),
      // 基线 = 默认值 + 被覆盖的字段：以后加字段不用回来补这张表。
    ).toEqual({
      ...DEFAULT_SCRCPY_CONFIG,
      bitRate: '8M',
      maxFps: 90,
      videoCodec: 'av1',
      audio: true,
      alwaysOnTop: true,
      fullscreen: true,
      quality: 'native',
    })
  })

  it('未知画质档位回落到默认档（不能把任意字符串带进显示尺寸计算）', () => {
    expect(normalizeScrcpyConfig({ quality: '10G' }).quality).toBe(DEFAULT_SCRCPY_CONFIG.quality)
    expect(normalizeScrcpyConfig({ quality: 3 }).quality).toBe(DEFAULT_SCRCPY_CONFIG.quality)
  })

  it('大屏模式默认关：老存盘里没这个键时必须走上游原生那份产物', () => {
    expect(normalizeScrcpyConfig({}).largeScreenDisplay).toBe(false)
    expect(normalizeScrcpyConfig({ largeScreenDisplay: true }).largeScreenDisplay).toBe(true)
    // 只认显式 true（与 audio 那几个开关同一套判据），脏值不能把补丁版产物带起来。
    expect(normalizeScrcpyConfig({ largeScreenDisplay: 'yes' }).largeScreenDisplay).toBe(false)
  })

  it('全屏启动默认关：只有显式 true 才开', () => {
    expect(normalizeScrcpyConfig({}).fullscreen).toBe(false)
    expect(normalizeScrcpyConfig({ fullscreen: true }).fullscreen).toBe(true)
    expect(normalizeScrcpyConfig({ fullscreen: 'yes' }).fullscreen).toBe(false)
  })

  it('上次设备的 stableId 只留能用的形状（它只用来比对，永不进命令行）', () => {
    expect(normalizeScrcpyConfig({}).lastDeviceStableId).toBe('')
    expect(normalizeScrcpyConfig({ lastDeviceStableId: 'af3d7abd' }).lastDeviceStableId).toBe(
      'af3d7abd',
    )
    expect(normalizeScrcpyConfig({ lastDeviceStableId: '  af3d7abd  ' }).lastDeviceStableId).toBe(
      'af3d7abd',
    )
    expect(normalizeScrcpyConfig({ lastDeviceStableId: 42 }).lastDeviceStableId).toBe('')
    expect(normalizeScrcpyConfig({ lastDeviceStableId: 'x'.repeat(200) }).lastDeviceStableId).toHaveLength(128)
  })

  it('音频转发默认开（声音转到电脑、手机静音）', () => {
    expect(normalizeScrcpyConfig({}).audio).toBe(true)
    expect(normalizeScrcpyConfig({ audio: undefined }).audio).toBe(true)
    // 只认显式 false —— 与 fullscreen 那条一样：默认开的开关不能被脏值或缺省关掉。
    expect(normalizeScrcpyConfig({ audio: false }).audio).toBe(false)
    expect(normalizeScrcpyConfig({ audio: 'yes' }).audio).toBe(true)
  })

  // 从 scrcpy.test.js 折过来：这几条是原来那份独有的，别跟着文件一起丢。
  it('拒绝会带进命令行的畸形值', () => {
    const config = normalizeScrcpyConfig({
      bitRate: '24M; rm',
      videoCodec: 'mpeg2',
      screenMode: 'turnOff',
    })
    expect(config.bitRate).toBe(DEFAULT_SCRCPY_CONFIG.bitRate)
    expect(config.videoCodec).toBe(DEFAULT_SCRCPY_CONFIG.videoCodec)
    // 已废弃的屏幕策略：老存盘里残留的 screenMode 静默丢弃，下次保存就干净了。
    expect('screenMode' in config).toBe(false)
  })

  it('maxFps 只接受整数并夹在 1..240', () => {
    expect(normalizeScrcpyConfig({ maxFps: 0 }).maxFps).toBe(1)
    expect(normalizeScrcpyConfig({ maxFps: 999 }).maxFps).toBe(240)
    expect(normalizeScrcpyConfig({ maxFps: 59.5 }).maxFps).toBe(DEFAULT_SCRCPY_CONFIG.maxFps)
  })

  it('drops removed legacy fields (newDisplay / renderFit / flex / tablet / engine)', () => {
    expect(
      normalizeScrcpyConfig({
        newDisplay: '1920x1080/320',
        renderFit: 'unscaled',
        flex: true,
        tablet: true,
        engine: 'scrcpy',
      }),
    ).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })
})

describe('scrcpyServerResource', () => {
  it('默认指上游原生那份，大屏模式才指补丁版', () => {
    expect(scrcpyServerResource(DEFAULT_SCRCPY_CONFIG)).toBe('scrcpy/scrcpy-server')
    expect(scrcpyServerResource({ largeScreenDisplay: true })).toBe(
      'scrcpy/patched/scrcpy-server',
    )
    // 只认显式 true：没传 config / 脏值都不能把补丁版产物带起来。
    expect(scrcpyServerResource(undefined)).toBe('scrcpy/scrcpy-server')
    expect(scrcpyServerResource({ largeScreenDisplay: 'yes' })).toBe('scrcpy/scrcpy-server')
  })

  it('两个分支各自指向真实存在的随包产物（少打一份就是开关另一边白屏）', () => {
    // 返回值是**相对 resources 目录**的路径，主进程拼的就是 `resourcesBase() + 它`。
    for (const relative of new Set([
      scrcpyServerResource(DEFAULT_SCRCPY_CONFIG),
      scrcpyServerResource({ largeScreenDisplay: true }),
    ])) {
      expect(isReadable(path.join(projectRoot, 'resources', relative))).toBe(true)
    }
  })
})

describe('scaleDisplayDpi', () => {
  const MI10 = { width: 1080, height: 2340 }

  it('照上游 scaleDpi：主屏密度 × 新长边 / 主屏长边（长边取 max，横竖同值）', () => {
    expect(scaleDisplayDpi(MI10, 440, { width: 756, height: 1640 })).toBe(308)
    expect(scaleDisplayDpi(MI10, 440, { width: 1640, height: 756 })).toBe(308)
    // 长边 dp 数因此与主屏一致（版式不随窗口漂移）：1640/308 ≈ 2340/440。
    expect(1640 / 308 / (2340 / 440)).toBeCloseTo(1, 2)
  })

  it('输入不可信就回 null，让调用方退成「不给显示尺寸」而不是猜一个密度', () => {
    expect(scaleDisplayDpi(null, 440, { width: 100, height: 100 })).toBeNull()
    expect(scaleDisplayDpi(MI10, 0, { width: 100, height: 100 })).toBeNull()
    expect(scaleDisplayDpi(MI10, 440, { width: 0, height: 100 })).toBeNull()
    expect(scaleDisplayDpi(MI10, 440, undefined)).toBeNull()
  })
})

describe('computeDisplayMetrics', () => {
  it('默认档位（sharp）沿用倍率 3：像素与 dpi 同倍，1dp = 1 CSS px', () => {
    const { width, height, dpi, scale } = computeDisplayMetrics(800, 1600)
    expect(scale).toBe(DISPLAY_PIXEL_SCALE)
    expect([width, height, dpi]).toEqual([2400, 4800, 480])
    expect((height * DISPLAY_BASE_DPI) / dpi).toBe(1600)
  })

  it('每个档位都保持 1dp = 1 CSS px 与窗口比例', () => {
    for (const [tier, scale] of Object.entries(DISPLAY_QUALITY_TIERS)) {
      const m = computeDisplayMetrics(800, 1600, tier)
      expect(m.scale).toBe(scale)
      expect(m.width / m.height).toBeCloseTo(800 / 1600, 3)
      expect((m.height * DISPLAY_BASE_DPI) / m.dpi).toBeCloseTo(1600, 1)
    }
  })

  it('三档的实际显示像素（对应实测的带宽差别）', () => {
    // 2026-09-23 干净复测：三档稳态都是 60fps，差别在带宽 —— 均衡档 ~5Mbps，清晰档 ~27Mbps。
    expect(computeDisplayMetrics(800, 1600, 'compat')).toMatchObject({
      width: 1200,
      height: 2400,
      dpi: 240,
    })
    expect(computeDisplayMetrics(800, 1600, 'native')).toMatchObject({
      width: 1600,
      height: 3200,
      dpi: 320,
    })
    expect(computeDisplayMetrics(800, 1600, 'sharp')).toMatchObject({
      width: 2400,
      height: 4800,
      dpi: 480,
    })
  })

  it('未知档位与异常尺寸都不炸', () => {
    expect(computeDisplayMetrics(800, 1600, 'nope').scale).toBe(DISPLAY_PIXEL_SCALE)
    expect(computeDisplayMetrics(0, 0).width).toBeGreaterThanOrEqual(2)
    expect(computeDisplayMetrics(NaN, 300).height).toBeGreaterThan(0)
  })
})

describe('DISPLAY_QUALITY_BIT_RATES', () => {
  it('码率档位与画质档位一一对应，且默认值正好落在默认档位上', () => {
    expect(Object.keys(DISPLAY_QUALITY_BIT_RATES)).toEqual(Object.keys(DISPLAY_QUALITY_TIERS))
    // 对不上的话设置页的合并下拉默认会显示「自定义」，等于默认配置就没命中预设。
    expect(DISPLAY_QUALITY_BIT_RATES[DEFAULT_SCRCPY_CONFIG.quality]).toBe(DEFAULT_SCRCPY_CONFIG.bitRate)
  })

  it('每档的码率都要装得下该档实测的稳态码率（~5 / ~5.2 / ~27Mbps）', () => {
    expect(DISPLAY_QUALITY_BIT_RATES).toEqual({ compat: '8M', native: '16M', sharp: '32M' })
  })

  it('老出厂组合 sharp + 24M 升级到新出厂组合 sharp + 32M', () => {
    // 24M 是改版前的默认值，存盘里分不出「出厂」还是「用户选的」；不升级的话
    // 每个老用户打开新设置页看到的都是标灰的「自定义」。
    expect(normalizeScrcpyConfig({ quality: 'sharp', bitRate: '24M' })).toMatchObject({
      quality: 'sharp',
      bitRate: '32M',
    })
  })

  it('其他对不上预设的组合原样保留（不静默改用户的码率）', () => {
    const capped = normalizeScrcpyConfig({ quality: 'sharp', bitRate: '8M' })
    expect(capped.bitRate).toBe('8M')
    expect(DISPLAY_QUALITY_BIT_RATES[capped.quality]).not.toBe(capped.bitRate)
    // 非默认档位上的 24M 也不是出厂值：换档后留下的码率，一个字都不动。
    expect(normalizeScrcpyConfig({ quality: 'compat', bitRate: '24M' }).bitRate).toBe('24M')
  })
})

describe('scrcpy config store', () => {
  beforeEach(async () => {
    await fs.rm(configFile, { force: true })
  })

  it('falls back to defaults when nothing is stored', async () => {
    const state = await loadScrcpyConfig()
    expect(state.config).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
    expect(currentScrcpyConfig()).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })

  it('round-trips saved config across reloads', async () => {
    const saved = await saveScrcpyConfig({ ...DEFAULT_SCRCPY_CONFIG, alwaysOnTop: true })
    expect(saved.alwaysOnTop).toBe(true)
    expect(getScrcpyConfigState().config.alwaysOnTop).toBe(true)

    const reloaded = await loadScrcpyConfig()
    expect(reloaded.config.alwaysOnTop).toBe(true)
    expect(currentScrcpyConfig().alwaysOnTop).toBe(true)
  })

  it('上次设备跟着文件往返（启动能不能连回那台就看这一条链路）', async () => {
    await saveScrcpyConfig({ ...DEFAULT_SCRCPY_CONFIG, lastDeviceStableId: 'af3d7abd' })
    const reloaded = await loadScrcpyConfig()
    expect(reloaded.config).toMatchObject({ lastDeviceStableId: 'af3d7abd' })
  })

  it('normalizes invalid values on save', async () => {
    const saved = await saveScrcpyConfig({ alwaysOnTop: 'yes', maxFps: 9999, videoCodec: 'mpeg2' })
    expect(saved.alwaysOnTop).toBe(false)
    expect(saved.maxFps).toBe(240)
    expect(saved.videoCodec).toBe(DEFAULT_SCRCPY_CONFIG.videoCodec)
  })

  it('falls back to defaults when the stored file is corrupt', async () => {
    await saveScrcpyConfig({ alwaysOnTop: true })
    await fs.writeFile(configFile, '{ not json', 'utf8')
    const state = await loadScrcpyConfig()
    expect(state.config).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })
})

describe('parseEncoderMimes', () => {
  it('认出 avc/hevc/av01/vp8/vp9 五种可用编码', () => {
    const { usable, mimes } = parseEncoderMimes(
      "video/avc\nvideo/hevc\nvideo/av01\nvideo/x-vnd.on2.vp8\nvideo/x-vnd.on2.vp9\n",
    )
    expect(usable).toEqual({ h264: true, h265: true, av1: true, vp8: true, vp9: true })
    expect(mimes).toHaveLength(5)
  })

  it('认不了的编码器也照样列出来（带能读的名字，供设置页标「服务端不支持」）', () => {
    const { usable, mimes } = parseEncoderMimes("video/avc\nvideo/apv\nvideo/3gpp\n")
    expect(usable.h264).toBe(true)
    expect(usable.apv).toBeUndefined()
    expect(mimes.map((entry) => [entry.label, entry.name, entry.protocol])).toEqual([
      ['H.264', 'h264', true],
      ['APV', 'apv', false],
      ['H.263', 'h263', false],
    ])
    // 协议带不动的那些 protocol=false，planCodecList 不会把它们列进下拉。
    expect(mimes.filter((entry) => !entry.protocol).map((entry) => entry.label)).toEqual(['APV', 'H.263'])
  })

  it('读不到内容时 mimes 为空 —— 调用方要把它当「未知」，不能当「全不支持」', () => {
    expect(parseEncoderMimes("").mimes).toEqual([])
    // 全 false 的 usable 曾把显式选的 AV1 判成不可用、回落成 H.264；未知必须是 device=null。
    expect(planCodecList({ device: null }).options.map((entry) => entry.value)).toEqual([
      "auto", "h264", "h265", "av1", "vp8", "vp9",
    ])
  })
})

describe('VIDEO_CODEC_CHOICES', () => {
  it('清单里就是服务端 VideoCodec.java 认的那些（4.1 起含 VP8/VP9）', () => {
    expect(VIDEO_CODEC_CHOICES).toEqual(["auto", "h264", "h265", "av1", "vp8", "vp9"])
  })
})

describe('resolveVideoCodec', () => {
  it('auto 优先 H.265', () => {
    expect(resolveVideoCodec('auto')).toEqual({ codec: 'h265', downgraded: false })
  })

  it('任一头不支持就退到 H.264，且不算「降级」（自动档本来就该这样）', () => {
    expect(resolveVideoCodec('auto', { local: { h264: true, h265: false } }))
      .toEqual({ codec: 'h264', downgraded: false })
  })

  it('显式选择被能力挡住时回落并标记 downgraded', () => {
    expect(resolveVideoCodec('av1', { device: { h264: true, h265: true, av1: false } }))
      .toEqual({ codec: 'h265', downgraded: true })
  })
})

describe('isCodecUsable', () => {
  it('给了能力表就按表算（表里没这项 = 不支持）；整头没探测到（null）才当未知放行', () => {
    expect(isCodecUsable('vp9', { device: { vp9: false }, local: null })).toBe(false)
    expect(isCodecUsable('vp9', { device: { h264: true }, local: null })).toBe(false)
    expect(isCodecUsable('vp9', { device: null, local: null })).toBe(true)
    expect(isCodecUsable('vp9', {})).toBe(true)
  })

  it('设备清单里没有这个 mime 时，usable 里就是 false（下拉不该列出它）', () => {
    const { usable } = parseEncoderMimes("video/avc\nvideo/3gpp\n")
    expect(usable.h264).toBe(true)
    expect(usable.vp9).toBe(false)
    expect(isCodecUsable('vp9', { device: usable })).toBe(false)
  })
})

describe('VIDEO_ENCODER_PROBE_CMD', () => {
  it('mime 的字符类必须含点与横线，否则厂商命名会被截断（VP8/VP9 探不到）', () => {
    expect(VIDEO_ENCODER_PROBE_CMD).toContain("grep -oE 'video/[a-z0-9._-]+'");
    // 截断版命令实测会把 video/x-vnd.on2.vp8 只回一个 `video/x`，解析器自然认不出。
    expect(parseEncoderMimes("video/x\n").usable.vp8).toBe(false);
  })
})

describe('planCodecList', () => {
  const deviceOf = (text) => parseEncoderMimes(text)

  it('下拉只列「协议认得 + 设备能编 + 本机能解」，自动档排在最前并写明会选谁', () => {
    const dev = deviceOf("video/avc\nvideo/hevc\nvideo/apv\n")
    const { options } = planCodecList({
      device: dev.usable,
      local: { h264: true, h265: true },
    })
    expect(options.map((entry) => entry.value)).toEqual(["auto", "h264", "h265"])
    expect(options[0].label).toBe('自动（当前选 H.265）')
  })

  it('存盘里的值在当前设备上不可用时，仍然列出来但标灰并写清原因', () => {
    const dev = deviceOf("video/avc\nvideo/av01\n")
    const { options } = planCodecList({
      device: dev.usable,
      local: { av1: false },
      current: "av1",
    })
    const av1 = options.find((entry) => entry.value === "av1")
    expect(av1).toMatchObject({ label: 'AV1（本机不能解）', disabled: true })
  })

  it('两头都没探测到时不拦：列表就是协议认得的那几个', () => {
    const { options } = planCodecList({})
    expect(options.map((entry) => entry.value)).toEqual(["auto", "h264", "h265", "av1", "vp8", "vp9"])
  })
})
