#!/usr/bin/env node
import { statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Files that must ship inside the packaged app. */
const requiredResources = [
  'resources/helper-app.apk',
  'resources/helper-app.version.json',
  'resources/adb/mac/adb',
  'resources/scrcpy/scrcpy',
  'resources/scrcpy/scrcpy-server',
]

function isReadableFile(relativePath) {
  try {
    const info = statSync(path.join(projectRoot, relativePath))
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

const missing = requiredResources.filter((resource) => !isReadableFile(resource))
if (missing.length > 0) {
  for (const resource of missing) {
    console.error(`Required packaged resource is missing or empty: ${resource}`)
  }
  console.error('Run `pnpm run download-adb` and `pnpm run build-helper`, then retry.')
  process.exit(1)
}

console.log('All packaged resources are present.')
