import { describe, expect, it, vi, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-scrcpy-config-'))

vi.mock('electron', () => ({
  app: { getPath: (name) => (name === 'userData' ? userDataDir : '') },
  ipcMain: { handle: vi.fn() },
}))

// 纯函数从它住的地方 import（shared/），不借道主进程模块的再导出。
const {
  DEFAULT_SCRCPY_CONFIG,
  normalizeScrcpyConfig,
  computeDisplayMetrics,
  DISPLAY_BASE_DPI,
  DISPLAY_PIXEL_SCALE,
  DISPLAY_QUALITY_TIERS,
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

  // 从 scrcpy.test.js 折过来：这几条是原来那份独有的，别跟着文件一起丢。
  it('拒绝会带进命令行的畸形值', () => {
    const config = normalizeScrcpyConfig({
      bitRate: '24M; rm',
      videoCodec: 'mpeg2',
      audio: 'yes',
      screenMode: 'turnOff',
    })
    expect(config.bitRate).toBe(DEFAULT_SCRCPY_CONFIG.bitRate)
    expect(config.videoCodec).toBe(DEFAULT_SCRCPY_CONFIG.videoCodec)
    expect(config.audio).toBe(false)
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
    // 协议带不动的那些 protocol=false，planCodecList 靠它们算「被挡清单」而不是列进下拉。
    expect(mimes.filter((entry) => !entry.protocol).map((entry) => entry.label)).toEqual(['APV', 'H.263'])
  })

  it('读不到内容时 usable 全 false、mimes 空（调用方据此不缓存，别把探测失败说成设备不支持）', () => {
    const { usable, mimes } = parseEncoderMimes("")
    expect(usable).toEqual({ h264: false, h265: false, av1: false, vp8: false, vp9: false })
    expect(mimes).toEqual([])
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
      mimes: dev.mimes,
      device: dev.usable,
      local: { h264: true, h265: true },
    })
    expect(options.map((entry) => entry.value)).toEqual(["auto", "h264", "h265"])
    expect(options[0].label).toBe('自动（当前选 H.265）')
  })

  it('存盘里的值在当前设备上不可用时，仍然列出来但标灰并写清原因', () => {
    const dev = deviceOf("video/avc\nvideo/av01\n")
    const { options } = planCodecList({
      mimes: dev.mimes,
      device: dev.usable,
      local: { av1: false },
      current: "av1",
    })
    const av1 = options.find((entry) => entry.value === "av1")
    expect(av1).toMatchObject({ label: 'AV1（本机不能解）', disabled: true })
  })

  it('被挡的清单带原因：协议没有位置 vs 本机解不了', () => {
    const dev = deviceOf("video/avc\nvideo/apv\nvideo/x-vnd.on2.vp9\n")
    const { blocked } = planCodecList({
      mimes: dev.mimes,
      device: dev.usable,
      local: { h264: true, vp9: false },
    })
    // 顺序跟着设备报出来的次序走
    expect(blocked).toEqual([
      { label: 'APV', reason: '投屏协议带不动' },
      { label: 'VP9', reason: '本机不能解' },
    ])
  })

  it('两头都没探测到时不拦：列表就是协议认得的那几个', () => {
    const { options } = planCodecList({})
    expect(options.map((entry) => entry.value)).toEqual(["auto", "h264", "h265", "av1", "vp8", "vp9"])
  })
})
