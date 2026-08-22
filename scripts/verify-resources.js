// 打包前置资源检查：缺失或不可执行时打印精确路径并以非零码退出。
// 用法: node scripts/verify-resources.js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const resources = path.join(root, 'resources')

/** @type {{ file: string, executable?: boolean }[]} */
const required = [
  { file: 'helper-app.apk' },
  { file: path.join('adb', 'mac', 'adb'), executable: true },
  { file: path.join('scrcpy', 'scrcpy'), executable: true },
  { file: path.join('scrcpy', 'scrcpy-server') },
]

const problems = []
for (const item of required) {
  const full = path.join(resources, item.file)
  if (!fs.existsSync(full)) {
    problems.push(`缺少资源: ${full}\n  运行 pnpm download-adb / pnpm build-helper 补齐`)
    continue
  }
  if (fs.statSync(full).size === 0) {
    problems.push(`资源为空: ${full}`)
    continue
  }
  if (item.executable && !(fs.statSync(full).mode & 0o111)) {
    problems.push(`资源不可执行: ${full}\n  运行 chmod +x ${full} 修复`)
  }
}

if (problems.length > 0) {
  console.error('打包资源检查失败:')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}

console.log('打包资源检查通过:', required.map((item) => item.file).join(', '))
