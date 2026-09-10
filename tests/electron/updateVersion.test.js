import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false, getVersion: () => '0.0.0' },
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
}))
vi.mock('bonjour-service', () => ({ default: class {} }))

const { parseVersion, isNewerVersion, pickMacAsset } = await import('../../electron/updater.js')

describe('parseVersion', () => {
  it('parses v-prefixed and partial versions', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('1.2')).toEqual([1, 2, 0])
    expect(parseVersion(' 2 ')).toEqual([2, 0, 0])
  })

  it('returns null for unparsable values', () => {
    expect(parseVersion('release-notes')).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('compares numerically, not lexically', () => {
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true)
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true)
  })

  it('is false for equal or older versions', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false)
  })

  it('is false when either side is unparsable', () => {
    expect(isNewerVersion('oops', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', 'oops')).toBe(false)
  })
})

describe('pickMacAsset', () => {
  const assets = [
    { name: 'AndDrive-Mac-arm64-1.0.0-Installer.zip' },
    { name: 'AndDrive-Mac-x64-1.0.0-Installer.zip' },
    { name: 'latest-mac.yml' },
  ]

  it('prefers the zip matching the running architecture', () => {
    expect(pickMacAsset(assets, 'arm64')?.name).toContain('arm64')
    expect(pickMacAsset(assets, 'x64')?.name).toContain('x64')
  })

  it('falls back to any mac zip, then any zip', () => {
    expect(pickMacAsset([{ name: 'App-mac.zip' }], 'arm64')?.name).toBe('App-mac.zip')
    expect(pickMacAsset([{ name: 'anything.zip' }], 'arm64')?.name).toBe('anything.zip')
  })

  it('returns null when there is no zip asset', () => {
    expect(pickMacAsset([{ name: 'latest-mac.yml' }], 'arm64')).toBeNull()
    expect(pickMacAsset([], 'arm64')).toBeNull()
    expect(pickMacAsset(undefined, 'arm64')).toBeNull()
  })
})
