#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// 投屏快捷方式（.adr）注册清理
//
// 背景：每次构建都会产出一个能打开 `.adr` 的 app 副本，LaunchServices 会把它们
// 全部记下来并各自声称一份**动态 UTI**（`dyn.xxxx`）。双击桌面快捷方式时到底由
// 哪个副本处理，取决于这台机器上谁最后被注册 —— 于是出现「投屏打开了三个月前
// 那个 beta 包」。`npm run build` 出的 beta 全留在 release/ 下，本仓库开发机上
// 攒几十个是常态。
//
// 这里做的事：把声称了 `.adr` 的 AndDrive 副本只留下**一个**（默认最新的那个
// **已安装**副本；本仓库 release/ 下的构建产物只在没有别的选择时才兜底），
// 其余逐条 `lsregister -u`，最后把留下的那个 `lsregister -f` 刷成最新。
// 只碰 bundle identifier 以 `com.anddrive.` 开头的副本，别的应用一概不动。
// /Applications 下同时装着正式版和 Beta 时，mtime 新的那个胜出；想指定就用 --keep。
//
// 用法：
//   node scripts/fix-shortcut-association.mjs [--dry-run] [--keep <app 路径>] [--all]
// `--all` 连开发用的 dev launcher（在 Application Support 里，由 app 自己维护）
// 一起清理；默认跳过，免得把正在跑的开发实例的关联摘掉。
// ---------------------------------------------------------------------------

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const OUR_BUNDLE_PREFIX = 'com.anddrive.'
const SHORTCUT_UTI = 'com.anddrive.mirror-shortcut'
const RECORD_SEPARATOR = /^-{20,}[ \t]*$/m

/** 去掉 lsregister 输出里跟在路径后面的 `(0x……)` 记录号。 */
function stripRecordId(value) {
  return value.replace(/\s*\(0x[0-9a-f]+\)\s*$/i, '').trim()
}

/** 该 UTI 声明是否指向 `.adr`（动态 UTI 写成 `dyn.xxx (.adr)`，正式 UTI 只看标识）。 */
function claimsAdr(claimedUtis) {
  return claimedUtis.includes('(.adr)') || claimedUtis.includes(SHORTCUT_UTI)
}

/**
 * 解析 `lsregister -dump` 的文本，挑出声称能打开 `.adr` 的自家 app 副本。
 * 只认 `bundle id:` 开头的记录（`claim id:` 那类是类型声明，没有自己的路径）。
 * @param {string} dump
 * @returns {{ path: string, identifier: string }[]}
 */
export function parseAdrClaimants(dump) {
  const claimants = []
  for (const record of dump.split(RECORD_SEPARATOR)) {
    if (!/^\s*bundle id:/m.test(record)) continue
    const claimed = /^claimed UTIs:\s*(.+)$/m.exec(record)?.[1] ?? ''
    if (!claimsAdr(claimed)) continue
    const identifier = /^identifier:\s*(.+)$/m.exec(record)?.[1]?.trim() ?? ''
    if (!identifier.startsWith(OUR_BUNDLE_PREFIX)) continue
    const rawPath = /^path:\s*(.+)$/m.exec(record)?.[1]
    if (!rawPath) continue
    claimants.push({ path: stripRecordId(rawPath), identifier })
  }
  return claimants
}

/** app 是否还在磁盘上；不存在或已在废纸篓的都不能当选中者。 */
function isUsable(appPath) {
  if (appPath.includes('/.Trash/')) return false
  try {
    return statSync(appPath).isDirectory()
  } catch {
    return false
  }
}

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 本仓库的构建产物目录：双击桌面快捷方式时不该启动它，只作最后兜底。 */
const buildOutputDir = path.join(projectRoot, 'release')

function isBuildArtifact(appPath) {
  return appPath.startsWith(buildOutputDir + path.sep)
}

function newest(...appPaths) {
  let winner = null
  let newestMtime = -1
  for (const appPath of appPaths) {
    const mtime = statSync(appPath).mtimeMs
    if (mtime > newestMtime) {
      newestMtime = mtime
      winner = appPath
    }
  }
  return winner
}

function lsregister(args, appPath) {
  execFileSync(LSREGISTER, [...args, appPath], { stdio: 'ignore' })
}

/** 剩余 `.adr` 声称者数量，用来确认清理生效。 */
function countRemainingClaimants() {
  try {
    return parseAdrClaimants(
      execFileSync(LSREGISTER, ['-dump'], { encoding: 'utf8', maxBuffer: 1 << 30 }),
    ).length
  } catch {
    return -1
  }
}

function parseArgs(argv) {
  const options = { dryRun: false, includeDevLauncher: false, keep: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--all') options.includeDevLauncher = true
    else if (arg === '--keep') {
      i += 1
      options.keep = argv[i] ? path.resolve(argv[i]) : null
    } else {
      throw new Error(
        `未知参数：${arg}\n用法：node scripts/fix-shortcut-association.mjs [--dry-run] [--keep <app 路径>] [--all]`,
      )
    }
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const devLauncherPrefix = `${process.env.HOME ?? ''}/Library/Application Support/`
  const claimants = parseAdrClaimants(
    execFileSync(LSREGISTER, ['-dump'], { encoding: 'utf8', maxBuffer: 1 << 30 }),
  ).filter(
    (claimant) =>
      options.includeDevLauncher ||
      !existsSync(claimant.path) ||
      !claimant.path.startsWith(devLauncherPrefix),
  )

  if (!claimants.length) {
    console.log('没有发现声称能打开 .adr 的 AndDrive 副本，无需清理。')
    return
  }

  const present = claimants.filter((claimant) => existsSync(claimant.path))
  let winner = null
  if (options.keep) {
    if (!isUsable(options.keep)) throw new Error(`--keep 指向的 app 不可用：${options.keep}`)
    winner = options.keep
  } else {
    const usable = present.filter((claimant) => isUsable(claimant.path))
    if (!usable.length) throw new Error('所有副本都已不在磁盘上，请加 --keep <app 路径> 指定')
    // 优先装在 /Applications 之类的正式位置；只剩本仓库构建产物时才退而求其次。
    const installed = usable.filter((claimant) => !isBuildArtifact(claimant.path))
    winner = newest(...(installed.length ? installed : usable).map((claimant) => claimant.path))
  }

  const losers = claimants.filter((claimant) => claimant.path !== winner)
  console.log(`保留：${winner}`)
  console.log(`待注销：${losers.length} 个副本${options.dryRun ? '（--dry-run，未执行）' : ''}`)
  for (const loser of losers) console.log(`  - ${loser.path}`)
  if (options.dryRun) return

  let unregistered = 0
  for (const loser of losers) {
    try {
      lsregister(['-u'], loser.path)
      unregistered += 1
    } catch {
      // 路径已消失时 -u 会失败；这条记录会在系统扫到死链时自行失效，跳过即可。
    }
  }
  lsregister(['-f'], winner)
  console.log(`已注销 ${unregistered} 个，并重新注册保留的那个。`)
  console.log(`剩余 .adr 声称者：${countRemainingClaimants()} 个。`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
