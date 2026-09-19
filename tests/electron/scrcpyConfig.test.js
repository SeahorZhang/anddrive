import { describe, expect, it, vi, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-scrcpy-config-'))

vi.mock('electron', () => ({
  app: { getPath: (name) => (name === 'userData' ? userDataDir : '') },
  ipcMain: { handle: vi.fn() },
}))

const {
  DEFAULT_SCRCPY_CONFIG,
  normalizeScrcpyConfig,
  computeDisplayMetrics,
  DISPLAY_BASE_DPI,
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
        engine: 'native',
      }),
    ).toEqual({
      bitRate: '8M',
      maxFps: 90,
      videoCodec: 'av1',
      audio: true,
      screenMode: 'turnOff',
      alwaysOnTop: true,
      fullscreen: true,
      engine: 'native',
    })
  })

  it('drops removed legacy fields (newDisplay / renderFit / flex / tablet)', () => {
    expect(
      normalizeScrcpyConfig({
        newDisplay: '1920x1080/320',
        renderFit: 'unscaled',
        flex: true,
        tablet: true,
      }),
    ).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })
})

describe('computeDisplayMetrics', () => {
  it('keeps 1dp = 1 CSS px and samples at physical pixels', () => {
    expect(computeDisplayMetrics(1280, 720)).toEqual({ width: 1280, height: 720, dpi: 160 })
    expect(computeDisplayMetrics(1280, 720, { pixelRatio: 2 })).toEqual({
      width: 2560,
      height: 1440,
      dpi: 320,
    })
    expect(computeDisplayMetrics(1280, 720, { pixelRatio: 0 })).toEqual({
      width: 1280,
      height: 720,
      dpi: 160,
    })
  })

  it('no longer clamps dpi to keep smallestWidth under the 600dp threshold', () => {
    // 旧「小屏模式」会把 dpi 抬到 sw≈599dp 换 app 填满帧；镜像现在只有大屏一种形态，
    // app 由 padMode 配方送进 pad 横屏，dp 就等于窗口 CSS（短边 720 CSS px → 720dp）。
    const { width, height, dpi } = computeDisplayMetrics(1280, 720, { pixelRatio: 2 })
    expect((Math.min(width, height) * DISPLAY_BASE_DPI) / dpi).toBe(720)
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
