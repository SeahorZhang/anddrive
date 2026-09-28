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
        screenMode: 'turnOff',
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
      screenMode: 'turnOff',
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
      screenMode: 'explode',
      audio: 'yes',
    })
    expect(config.bitRate).toBe(DEFAULT_SCRCPY_CONFIG.bitRate)
    expect(config.videoCodec).toBe(DEFAULT_SCRCPY_CONFIG.videoCodec)
    expect(config.screenMode).toBe(DEFAULT_SCRCPY_CONFIG.screenMode)
    expect(config.audio).toBe(false)
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
    expect(state.stored).toBe(false)
    expect(state.config).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
    expect(currentScrcpyConfig()).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })

  it('round-trips saved config across reloads', async () => {
    const saved = await saveScrcpyConfig({ ...DEFAULT_SCRCPY_CONFIG, alwaysOnTop: true })
    expect(saved.alwaysOnTop).toBe(true)
    expect(getScrcpyConfigState().stored).toBe(true)

    const reloaded = await loadScrcpyConfig()
    expect(reloaded.stored).toBe(true)
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
    expect(state.stored).toBe(false)
    expect(state.config).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })
})
