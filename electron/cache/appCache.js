import { app } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  CACHE_MAX_AGE_MS,
  MAX_SNAPSHOT_BYTES,
  sanitizeSnapshot,
  serializeSnapshot,
} from './appCacheSchema.js'

const MAX_DEVICE_CACHES = 20

const cacheRoot = () => path.join(app.getPath('userData'), 'app-cache', 'apps-v1')
const cacheKey = (serial) => createHash('sha256').update(serial).digest('hex')
const cachePath = (serial) => path.join(cacheRoot(), `${cacheKey(serial)}.json`)

async function removeFile(filePath) {
  try {
    await fs.unlink(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('Failed to remove app cache:', error)
  }
}

export async function readAppCache(serial) {
  if (typeof serial !== 'string' || !serial || serial.length > 1024) return null
  const filePath = cachePath(serial)
  try {
    const data = await fs.readFile(filePath)
    if (data.length > MAX_SNAPSHOT_BYTES) {
      await removeFile(filePath)
      return null
    }
    const snapshot = sanitizeSnapshot(JSON.parse(data.toString('utf8')))
    if (!snapshot) await removeFile(filePath)
    return snapshot
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('Failed to read app cache:', error)
      await removeFile(filePath)
    }
    return null
  }
}

/** Delete the cached snapshot of one device. Idempotent. */
export async function deleteAppCache(serial) {
  if (typeof serial !== 'string' || !serial || serial.length > 1024) return false
  await removeFile(cachePath(serial))
  return true
}

async function pruneCaches(protectedPath) {
  try {
    const root = cacheRoot()
    const entries = await fs.readdir(root, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      const filePath = path.join(root, entry.name)
      if (!entry.isFile()) continue
      if (entry.name.includes('.tmp')) {
        await removeFile(filePath)
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      const stats = await fs.stat(filePath)
      if (Date.now() - stats.mtimeMs > CACHE_MAX_AGE_MS && filePath !== protectedPath) {
        await removeFile(filePath)
      } else {
        files.push({ filePath, mtimeMs: stats.mtimeMs })
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const file of files.slice(MAX_DEVICE_CACHES)) {
      if (file.filePath !== protectedPath) await removeFile(file.filePath)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('Failed to prune app caches:', error)
  }
}

/**
 * @param {string} serial
 * @param {import('../shared/types.js').AppCacheSnapshotInput} snapshot
 */
export async function writeAppCache(serial, snapshot) {
  if (typeof serial !== 'string' || !serial || serial.length > 1024) return false
  const data = serializeSnapshot(snapshot)
  if (data == null) {
    await removeFile(cachePath(serial))
    return false
  }

  const root = cacheRoot()
  const filePath = cachePath(serial)
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(tempPath, data, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tempPath, filePath)
    await pruneCaches(filePath)
    return true
  } catch (error) {
    console.warn('Failed to write app cache:', error)
    await removeFile(tempPath)
    return false
  }
}
