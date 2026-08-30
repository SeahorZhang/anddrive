import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('bonjour-service', () => ({ default: class {} }))

const {
  CACHE_MAX_AGE_MS,
  CACHE_VERSION,
  sanitizeApp,
  sanitizeIcon,
  sanitizeSnapshot,
  serializeSnapshot,
} = await import('../../electron/adb.js')

const NOW = 2_000_000_000_000
const iconUrl = `data:image/png;base64,${Buffer.from('png').toString('base64')}`

function snapshot(overrides = {}) {
  return {
    version: CACHE_VERSION,
    authoritativeAt: NOW - 1000,
    writtenAt: NOW,
    apps: [
      {
        packageName: 'com.example.app',
        label: 'Example',
        iconUrl,
        iconUpdatedAt: NOW,
      },
    ],
    ...overrides,
  }
}

describe('app cache schema', () => {
  it('sanitizes a valid snapshot', () => {
    expect(sanitizeSnapshot(snapshot(), { now: NOW })).toEqual(snapshot())
  })

  it('rejects snapshots with the wrong version', () => {
    expect(sanitizeSnapshot(snapshot({ version: CACHE_VERSION - 1 }), { now: NOW })).toBeNull()
  })

  it('rejects expired snapshots unless expiration is allowed', () => {
    const expired = snapshot({ writtenAt: NOW - CACHE_MAX_AGE_MS - 1 })
    expect(sanitizeSnapshot(expired, { now: NOW })).toBeNull()
    expect(sanitizeSnapshot(expired, { now: NOW, allowExpired: true })).not.toBeNull()
  })

  it('sanitizes icons and falls back to the package name for labels', () => {
    expect(sanitizeIcon('data:text/plain;base64,QQ==')).toBeNull()
    expect(sanitizeApp({ packageName: 'com.example.app', label: '', iconUrl: 'invalid' })).toEqual({
      packageName: 'com.example.app',
      label: 'com.example.app',
      iconUrl: null,
      iconUpdatedAt: null,
    })
  })

  it('rejects duplicate packages', () => {
    const app = snapshot().apps[0]
    expect(sanitizeSnapshot(snapshot({ apps: [app, app] }), { now: NOW })).toBeNull()
  })

  it('rejects icons larger than the cache limit', () => {
    const oversized = `data:image/png;base64,${Buffer.alloc(512 * 1024 + 1).toString('base64')}`
    expect(sanitizeIcon(oversized)).toBeNull()
  })

  it('owns the persisted version for versionless and stale-version input snapshots', () => {
    const { version: _version, ...input } = snapshot()
    const serialized = serializeSnapshot({ ...input, version: CACHE_VERSION - 1 })
    expect(serialized).not.toBeNull()
    expect(JSON.parse(serialized).version).toBe(CACHE_VERSION)
    expect(sanitizeSnapshot(JSON.parse(serialized), { now: NOW })).not.toBeNull()
  })
})
