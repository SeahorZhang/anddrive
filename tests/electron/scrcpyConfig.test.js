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
  standardDisplayBox,
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
        tablet: true,
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
      tablet: true,
    })
  })

  it('drops removed legacy fields (newDisplay / renderFit / flex)', () => {
    expect(
      normalizeScrcpyConfig({ newDisplay: '1920x1080/320', renderFit: 'unscaled', flex: true }),
    ).toEqual({ ...DEFAULT_SCRCPY_CONFIG })
  })
})

describe('standardDisplayBox', () => {
  it('snaps the window ratio to 16:9 / 9:16 with the inscribed box', () => {
    expect(standardDisplayBox(1920, 1080)).toEqual({ width: 1920, height: 1080 })
    // 1.54:1 的横窗口 → 内接 16:9，短的那一轴留给 contain 当黑边
    expect(standardDisplayBox(1248, 810)).toEqual({ width: 1248, height: 702 })
    expect(standardDisplayBox(810, 1248)).toEqual({ width: 702, height: 1248 })
  })

  it('never exceeds the input on either axis', () => {
    for (const [w, h] of [[460, 900], [1248, 810], [900, 460], [1000, 1000]]) {
      const box = standardDisplayBox(w, h)
      expect(box.width).toBeLessThanOrEqual(w)
      expect(box.height).toBeLessThanOrEqual(h)
    }
  })
})

describe('computeDisplayMetrics', () => {
  it('keeps 1dp = 1px and scales by devicePixelRatio', () => {
    expect(computeDisplayMetrics(460, 900)).toEqual({ width: 460, height: 818, dpi: 160 })
    expect(computeDisplayMetrics(460, 900, { pixelRatio: 2 })).toEqual({
      width: 920,
      height: 1636,
      dpi: 320,
    })
    expect(computeDisplayMetrics(460, 900, { pixelRatio: 0 })).toEqual({
      width: 460,
      height: 818,
      dpi: 160,
    })
  })

  it('applies the 1.5x tablet zoom on top of the pixel ratio', () => {
    expect(computeDisplayMetrics(800, 600, { tablet: true, pixelRatio: 2 })).toEqual({
      width: 2400,
      height: 1350,
      dpi: 320,
    })
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
