#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { SCRCPY_SERVER_VERSION } from '../shared/scrcpyConfig.js'

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Files that must ship inside the packaged app. */
const requiredResources = [
  'resources/helper-app.apk',
  'resources/helper-app.version.json',
  'resources/adb/mac/adb',
  // 默认那份是上游官方产物，`patched/` 那份是带 `debug.anddrive.vd.*` 的自编产物，
  // 「大屏模式」开关切的就是这两份 —— 少带一份，开关另一边直接起不了会话。
  'resources/scrcpy/scrcpy-server',
  'resources/scrcpy/patched/scrcpy-server',
]

function isReadableFile(relativePath) {
  try {
    const info = statSync(path.join(projectRoot, relativePath))
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/**
 * 随包 server 里烤进去的版本（`BuildConfig.VERSION_NAME` 被编译期内联进那句报错字符串）。
 * server 在 `Options.parse` 的第一个参数上比对客户端声明的版本，**不等就直接退出**，
 * 表现是镜像白屏 —— 换包时漏改 `SCRCPY_SERVER_VERSION` 就是这个后果，所以拿产物本身来对账。
 */
function bakedServerVersion(resource) {
  const dex = execFileSync('unzip', ['-p', path.join(projectRoot, resource), 'classes.dex'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  const match = /The server version \(([^)]+)\) does not match the client/.exec(
    dex.toString('latin1'),
  )
  return match ? match[1] : null
}

const missing = requiredResources.filter((resource) => !isReadableFile(resource))
if (missing.length > 0) {
  for (const resource of missing) {
    console.error(`Required packaged resource is missing or empty: ${resource}`)
  }
  console.error('Run `pnpm run download-adb` and `pnpm run build-helper`, then retry.')
  process.exit(1)
}

// 两份 server 都要过版本这一关：开关切的是产物，切过去发现版本对不上就是白屏。
for (const resource of ['resources/scrcpy/scrcpy-server', 'resources/scrcpy/patched/scrcpy-server']) {
  const baked = bakedServerVersion(resource)
  if (baked !== SCRCPY_SERVER_VERSION) {
    console.error(
      `${resource} 的版本 (${baked ?? '读不出来'}) 与客户端声明的 ` +
        `SCRCPY_SERVER_VERSION (${SCRCPY_SERVER_VERSION}) 不一致，镜像会白屏。`,
    )
    console.error('改 `shared/scrcpyConfig.js` 的 SCRCPY_SERVER_VERSION，或换回配套的产物。')
    process.exit(1)
  }
  console.log(`${resource} = ${baked}，与客户端声明一致。`)
}

console.log('All packaged resources are present.')
