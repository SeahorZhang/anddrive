import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

const {
  CACHE_MAX_AGE_MS,
  CACHE_VERSION,
  sanitizeApp,
  sanitizeSnapshot,
  serializeSnapshot,
} = await import('../../electron/adb.js')

// 图标校验住在 iconImage.js，不再借道 adb.js 的再导出。
const { sanitizeIcon } = await import('../../electron/iconImage.js')

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
  // 图标不再进快照（O6）：本体在 icons-v1/ 单独成文件，年龄以文件 mtime 为准。
  it('strips inline icons out of a legacy snapshot', () => {
    expect(sanitizeSnapshot(snapshot(), { now: NOW })).toEqual(
      snapshot({
        apps: [
          { packageName: 'com.example.app', label: 'Example', iconUrl: null, iconUpdatedAt: null },
        ],
      }),
    )
  })

  it('keeps a snapshot whose apps carry no icon payload', () => {
    const lean = snapshot({
      apps: [{ packageName: 'com.example.app', label: 'Example' }],
    })
    expect(sanitizeSnapshot(lean, { now: NOW })).toEqual(
      { ...lean, apps: [{ ...lean.apps[0], iconUrl: null, iconUpdatedAt: null }] },
    )
  })

  it('rejects snapshots with the wrong version', () => {
    expect(sanitizeSnapshot(snapshot({ version: CACHE_VERSION - 1 }), { now: NOW })).toBeNull()
  })

  it('rejects expired snapshots unless expiration is allowed', () => {
    const expired = snapshot({ writtenAt: NOW - CACHE_MAX_AGE_MS - 1 })
    expect(sanitizeSnapshot(expired, { now: NOW })).toBeNull()
    expect(sanitizeSnapshot(expired, { now: NOW, allowExpired: true })).not.toBeNull()
  })

  it('never lets an icon survive into a cached app entry', () => {
    expect(sanitizeIcon('data:text/plain;base64,QQ==')).toBeNull()
    expect(
      sanitizeApp({ packageName: 'com.example.app', label: '', iconUrl, iconUpdatedAt: NOW }),
    ).toEqual({ packageName: 'com.example.app', label: 'com.example.app', iconUrl: null, iconUpdatedAt: null })
    expect(
      sanitizeApp({ packageName: 'com.example.app', label: 'x', iconUrl: 'invalid' }),
    ).toEqual({ packageName: 'com.example.app', label: 'x', iconUrl: null, iconUpdatedAt: null })
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
