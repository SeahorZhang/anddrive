import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CACHE_MAX_AGE_MS, CACHE_VERSION } from '../../electron/appCacheSchema.js'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
  },
}))

const { getCachedInstalledApps, readAppCache, writeAppCache } =
  await import('../../electron/appCache.js')

const serial = '192.168.1.20:5555'
const cacheFile = () =>
  path.join(
    state.userData,
    'app-cache',
    'apps-v1',
    `${createHash('sha256').update(serial).digest('hex')}.json`,
  )
const snapshot = () => ({
  authoritativeAt: Date.now() - 1000,
  writtenAt: Date.now(),
  apps: [
    {
      packageName: 'com.example.app',
      label: 'Example',
      iconUrl: null,
      iconUpdatedAt: null,
    },
  ],
})

beforeEach(async () => {
  state.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'anddrive-cache-test-'))
})

afterEach(async () => {
  await fs.rm(state.userData, { recursive: true, force: true })
})

describe('app cache persistence', () => {
  it('round trips a versionless domain snapshot and exposes cached apps', async () => {
    expect(await writeAppCache(serial, snapshot())).toBe(true)
    expect(await readAppCache(serial)).toMatchObject({ version: CACHE_VERSION })
    expect(await getCachedInstalledApps(serial)).toEqual({
      authoritativeAt: expect.any(Number),
      apps: [{ packageName: 'com.example.app', label: 'Example', iconUrl: null }],
    })
  })

  it.each([
    ['corrupt', '{not-json'],
    [
      'expired',
      JSON.stringify({
        version: CACHE_VERSION,
        authoritativeAt: 1,
        writtenAt: Date.now() - CACHE_MAX_AGE_MS - 1,
        apps: [],
      }),
    ],
    [
      'wrong version',
      JSON.stringify({
        version: CACHE_VERSION - 1,
        authoritativeAt: Date.now(),
        writtenAt: Date.now(),
        apps: [],
      }),
    ],
  ])('removes %s cache data safely', async (_name, contents) => {
    await fs.mkdir(path.dirname(cacheFile()), { recursive: true })
    await fs.writeFile(cacheFile(), contents)

    expect(await readAppCache(serial)).toBeNull()
    await expect(fs.access(cacheFile())).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
