// 显式清理 Electron 构建产物（notBundle 会写入额外 chunk，vite 不清此目录）。
// 由 pnpm build 在 vite build 前调用，替代 vite.config.js 的顶层删除副作用。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
fs.rmSync(path.join(root, 'dist-electron'), { recursive: true, force: true })
