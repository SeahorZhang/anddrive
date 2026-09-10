import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
  },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('bonjour-service', () => ({ default: class {} }))

const { readAppCache, writeAppCache, CACHE_MAX_AGE_MS, CACHE_VERSION } = await import('../../electron/adb.js')

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
  it('round trips a versionless domain snapshot', async () => {
    expect(await writeAppCache(serial, snapshot())).toBe(true)
    expect(await readAppCache(serial)).toMatchObject({ version: CACHE_VERSION })
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

  it('keeps concurrent writes intact and only prunes stale temp files', async () => {
    const root = path.dirname(cacheFile())
    await fs.mkdir(root, { recursive: true })
    const stale = path.join(root, 'stale.100.abcd.tmp')
    const fresh = path.join(root, 'fresh.200.efgh.tmp')
    await fs.writeFile(stale, 'stale')
    await fs.writeFile(fresh, 'fresh')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(stale, old, old)

    const results = await Promise.all(
      Array.from({ length: 20 }, () => writeAppCache(serial, snapshot())),
    )

    expect(results).toEqual(Array(20).fill(true))
    await expect(fs.access(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(fresh)).resolves.toBeUndefined()
    expect(await readAppCache(serial)).not.toBeNull()
  })
})
