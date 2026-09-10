import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('bonjour-service', () => ({ default: class {} }))

const { parseDeviceHelperVersion, shouldUpgradeHelper } = await import('../../electron/adb.js')

describe('helper version comparison', () => {
  it('parses versionCode and versionName from dumpsys output', () => {
    const output = [
      'Packages:',
      '  Package [com.anddrive.helper]:',
      '    versionCode=7 minSdk=24 targetSdk=34',
      '    versionName=1.4',
    ].join('\n')
    expect(parseDeviceHelperVersion(output)).toEqual({ versionCode: 7, versionName: '1.4' })
  })

  it('tolerates missing versionName', () => {
    expect(parseDeviceHelperVersion('  versionCode=3 minSdk=24')).toEqual({
      versionCode: 3,
      versionName: null,
    })
  })

  it('returns null when no versionCode is present', () => {
    expect(parseDeviceHelperVersion('Package [com.anddrive.helper]')).toBeNull()
    expect(parseDeviceHelperVersion(null)).toBeNull()
  })

  it('upgrades only when the bundled code is strictly newer', () => {
    expect(shouldUpgradeHelper({ versionCode: 2 }, { versionCode: 1 })).toBe(true)
    expect(shouldUpgradeHelper({ versionCode: 1 }, { versionCode: 1 })).toBe(false)
    expect(shouldUpgradeHelper({ versionCode: 1 }, { versionCode: 2 })).toBe(false)
  })

  it('never upgrades when either version is unknown', () => {
    expect(shouldUpgradeHelper(null, { versionCode: 1 })).toBe(false)
    expect(shouldUpgradeHelper({ versionCode: 2 }, null)).toBe(false)
    expect(shouldUpgradeHelper({ versionCode: '2' }, { versionCode: 1 })).toBe(false)
  })
})
