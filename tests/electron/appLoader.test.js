import { describe, expect, it } from 'vitest'
import {
  normalizeApp,
  reconcileCachedApps,
  rendererApps,
  uniqueApps,
} from '../../electron/helper/appLoader.js'

const HOUR = 60 * 60 * 1000

describe('uniqueApps', () => {
  it('dedupes by package name and falls back to the package name as label', () => {
    expect(
      uniqueApps([
        { packageName: 'com.one', label: 'One', iconUrl: 'data:image/png;base64,AQ==' },
        { packageName: 'com.two' },
        { packageName: 'com.one', label: 'Duplicate' },
        { packageName: '', label: 'Missing' },
      ]),
    ).toEqual([
      { packageName: 'com.one', label: 'One', iconUrl: 'data:image/png;base64,AQ==' },
      { packageName: 'com.two', label: 'com.two', iconUrl: null },
    ])
  })
})

describe('normalizeApp / rendererApps', () => {
  it('keeps only the fields the renderer needs', () => {
    const normalized = normalizeApp({ packageName: 'com.a', label: 'A', extra: 'ignored' })
    expect(normalized).toEqual({ packageName: 'com.a', label: 'A', iconUrl: null })
    expect(rendererApps([{ ...normalized, iconUpdatedAt: 1 }])).toEqual([
      { packageName: 'com.a', label: 'A', iconUrl: null },
    ])
  })
})

describe('reconcileCachedApps', () => {
  const now = 10 * HOUR
  const apps = [
    { packageName: 'com.fresh', label: 'Fresh', iconUrl: null },
    { packageName: 'com.cached', label: 'Cached', iconUrl: null },
    { packageName: 'com.stale', label: 'Stale', iconUrl: null },
    { packageName: 'com.renamed', label: 'New Label', iconUrl: null },
  ]
  const cache = {
    version: 2,
    authoritativeAt: 0,
    writtenAt: 0,
    apps: [
      {
        packageName: 'com.cached',
        label: 'Cached',
        iconUrl: 'data:image/png;base64,AQ==',
        iconUpdatedAt: now - HOUR,
      },
      {
        packageName: 'com.stale',
        label: 'Stale',
        iconUrl: 'data:image/png;base64,AQ==',
        iconUpdatedAt: now - 31 * 24 * HOUR,
      },
      {
        packageName: 'com.renamed',
        label: 'Old Label',
        iconUrl: 'data:image/png;base64,AQ==',
        iconUpdatedAt: now - HOUR,
      },
      {
        packageName: 'com.gone',
        label: 'Gone',
        iconUrl: 'data:image/png;base64,AQ==',
        iconUpdatedAt: now - HOUR,
      },
    ],
  }

  it('reconciles icons from cache and refreshes missing/stale/renamed entries', () => {
    const { snapshotApps, iconsToFetch } = reconcileCachedApps(apps, cache, now)

    expect(snapshotApps.map((app) => [app.packageName, app.iconUrl])).toEqual([
      ['com.fresh', null],
      ['com.cached', 'data:image/png;base64,AQ=='],
      ['com.stale', 'data:image/png;base64,AQ=='],
      ['com.renamed', 'data:image/png;base64,AQ=='],
    ])

    // 缓存命中且 label 未变的 com.cached 不需要重新拉图标；其余（缺失/过期/改名）都需要
    expect(iconsToFetch.map((app) => app.packageName)).toEqual([
      'com.fresh',
      'com.stale',
      'com.renamed',
    ])
  })

  it('fetches everything without a cache', () => {
    const { iconsToFetch } = reconcileCachedApps(apps, null, now)
    expect(iconsToFetch.map((app) => app.packageName)).toEqual([
      'com.fresh',
      'com.cached',
      'com.stale',
      'com.renamed',
    ])
  })
})
