#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const USAGE = `本地伪 Release 服务器，用于测试 AndDrive 自动更新。

用法:
  node scripts/dev-update-server.mjs --zip <更新包> [选项]

选项:
  --zip <path>        作为 /update.zip 提供的文件（打包好的 *.zip，任意文件也可用于测下载）
  --version <x.y.z>   伪版本号，默认 9.9.9（保证比本地版本新）
  --notes <text>      更新内容文本
  --notes-file <path> 从文件读取更新内容
  --name <file>       资源名，默认 AndDrive-Mac-<arch>-<version>-Installer.zip
  --arch <arch>       资源名里的架构，默认当前进程架构
  --port <port>       监听端口，默认 8787

启动后，让客户端指向本服务:
  ANDDRIVE_UPDATE_FORCE=1 ANDDRIVE_UPDATE_API=http://127.0.0.1:8787/latest.json pnpm dev
  ANDDRIVE_UPDATE_API=http://127.0.0.1:8787/latest.json /Applications/AndDrive.app/Contents/MacOS/AndDrive
`

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[name] = next
      i += 1
    } else {
      args[name] = 'true'
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

const port = Number(args.port || 8787)
const version = String(args.version || '9.9.9')
const arch = String(args.arch || process.arch)
const assetName = String(args.name || `AndDrive-Mac-${arch}-${version}-Installer.zip`)
let notes = String(args.notes || '本地测试更新内容\n- 修复问题\n- 新增功能')
if (args['notes-file']) notes = readFileSync(path.resolve(args['notes-file']), 'utf8')

const zipPath = args.zip ? path.resolve(String(args.zip)) : null
if (zipPath && !existsSync(zipPath)) {
  console.error(`更新包不存在: ${zipPath}`)
  process.exit(1)
}
if (!zipPath) {
  console.warn('未提供 --zip，/update.zip 将返回 404；只能验证到“发现新版本”状态。')
}

const base = `http://127.0.0.1:${port}`

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', base)
  console.log(`${req.method} ${url.pathname}`)

  if (url.pathname === '/latest.json') {
    const assets = zipPath
      ? [
          {
            name: assetName,
            size: statSync(zipPath).size,
            browser_download_url: `${base}/update.zip`,
          },
        ]
      : []
    const payload = JSON.stringify(
      { tag_name: `v${version}`, name: `v${version}`, body: notes, assets },
      null,
      2,
    )
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(payload)
    return
  }

  if (url.pathname === '/update.zip') {
    if (!zipPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('no --zip provided')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': statSync(zipPath).size,
    })
    createReadStream(zipPath).pipe(res)
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(`AndDrive dev update server\nversion=${version}\nzip=${zipPath || '(none)'}\n`)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`伪 Release 服务已启动: ${base}`)
  console.log(`  latest.json: ${base}/latest.json`)
  console.log(`  version: ${version}, zip: ${zipPath || '(none)'}`)
})
