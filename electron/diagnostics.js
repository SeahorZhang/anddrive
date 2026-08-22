import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import Bonjour from 'bonjour-service'
import * as adb from './adb/adbClient.js'
import {
  getAdbPath,
  getHelperApkPath,
  getScrcpyPath,
  getScrcpyServerPath,
} from './resourceResolver.js'

const execAsync = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const FIREWALL_CLI = '/usr/libexec/ApplicationFirewall/socketfilterfw'
// macOS 26 起为独立面板；旧版本回退到安全隐私页锚点
const LOCAL_NETWORK_ANCHORS = [
  'x-apple.systempreferences:com.apple.Local-Network-Settings.extension',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
]

/** 打包后的 .app 路径；开发模式返回 null */
function appBundlePath() {
  if (!app.isPackaged) return null
  // process.execPath = <bundle>/Contents/MacOS/<name>，向上三级到 .app
  return dirname(dirname(dirname(process.execPath)))
}
/**
 * @typedef {{ id: string, name: string, status: 'pass' | 'warn' | 'fail', detail: string }} DiagnosticItem
 */

/** @param {'pass' | 'warn' | 'fail'} status */
const item = (id, name, status, detail) => ({ id, name, status, detail })

/** @param {string} path */
function checkFile(id, name, path) {
  return item(
    id,
    name,
    existsSync(path) ? 'pass' : 'fail',
    `${path}${existsSync(path) ? '' : ' —— 缺失，请重新安装或运行 pnpm build-helper / pnpm download-adb'}`,
  )
}

/** 解析 socketfilterfw 全局状态输出；@returns {boolean | null} */
export function parseFirewallEnabled(output) {
  const match = /State = (\d)/.exec(output || '')
  return match ? match[1] === '1' : null
}

/** 解析 `adb mdns check` 输出 */
export function parseMdnsCheckOk(output) {
  return /mdns daemon version/i.test(output || '')
}

async function checkResourceFiles() {
  return [
    checkFile('adb-bin', 'ADB 工具', getAdbPath()),
    checkFile('scrcpy-bin', 'scrcpy 主程序', getScrcpyPath()),
    checkFile('scrcpy-server', 'scrcpy server', getScrcpyServerPath()),
    checkFile('helper-apk', 'Helper APK', getHelperApkPath()),
  ]
}

async function checkAdbServer() {
  try {
    await adb.ensureServer()
    await adb.exec('devices')
    return item('adb-server', 'adb server', 'pass', '运行中（受管配置）')
  } catch (error) {
    return item('adb-server', 'adb server', 'fail', `无法启动或无响应：${error.message}`)
  }
}

async function checkMdnsBackend() {
  try {
    const { stdout } = await execAsync(getAdbPath(), ['mdns', 'check'], { timeout: 5000 })
    const ok = parseMdnsCheckOk(stdout)
    return item(
      'mdns-backend',
      'adb mDNS 后端',
      ok ? 'pass' : 'fail',
      ok ? stdout.trim() : stdout.trim() || '不可用',
    )
  } catch (error) {
    return item('mdns-backend', 'adb mDNS 后端', 'fail', String(error.message))
  }
}

async function checkFirewall() {
  try {
    const { stdout } = await execAsync(FIREWALL_CLI, ['--getglobalstate'], { timeout: 4000 })
    const enabled = parseFirewallEnabled(stdout)
    if (!enabled) {
      return item('firewall', '系统防火墙', 'pass', '已关闭，不会拦截连接')
    }
    const { stdout: apps } = await execAsync(FIREWALL_CLI, ['--listapps'], { timeout: 6000 })
    const hasEntry = /AndDrive/i.test(apps)
    return item(
      'firewall',
      '系统防火墙',
      'warn',
      hasEntry
        ? '已开启且包含本应用条目——请确认在"防火墙选项"中允许传入连接'
        : '已开启但列表中没有本应用——请在"防火墙选项"中允许 AndDrive 接收传入连接',
    )
  } catch (error) {
    return item('firewall', '系统防火墙', 'warn', `无法读取状态：${error.message}`)
  }
}

/** 组播自检：短暂浏览常见服务，验证本机能否收到局域网 mDNS 响应 */
async function checkMulticast() {
  const bonjour = new Bonjour()
  let received = 0
  const browsers = ['googlecast', 'airplay', 'ipp', 'spotify-connect'].map((type) =>
    bonjour.find({ type }, () => received++),
  )
  await sleep(2200)
  browsers.forEach((browser) => browser.stop())
  bonjour.destroy()
  return received > 0
    ? item('multicast', 'mDNS 组播接收', 'pass', `收到 ${received} 条局域网服务响应`)
    : item(
        'multicast',
        'mDNS 组播接收',
        'warn',
        '未收到任何组播响应：可能是"本地网络"权限被拒，或局域网内暂无其他设备广播',
      )
}

/**
 * 运行环境诊断（各项独立执行，单项失败不影响其余）。
 * @returns {Promise<{ items: DiagnosticItem[], packaged: boolean }>}
 */
export async function runDiagnostics() {
  const items = []
  const settled = await Promise.allSettled([
    checkResourceFiles(),
    checkAdbServer(),
    checkMdnsBackend(),
    checkFirewall(),
    checkMulticast(),
  ])
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      items.push(...result.value)
    } else {
      items.push(item('unknown', '未知检查项', 'fail', String(result.reason)))
    }
  }
  return { items, packaged: app.isPackaged }
}

/**
 * 监听手机配对/连接广播一段时间，返回捕获到的服务。
 * 用于验证"手机端是否真的在广播"——与权限无关的射频级证据。
 * @param {number} [windowMs]
 * @returns {Promise<{ type: string, address: string, name?: string }[]>}
 */
export async function listenDeviceBroadcast(windowMs = 10000) {
  const bonjour = new Bonjour()
  /** @type {{ type: string, address: string, name?: string }[]} */
  const found = []
  const record = (type) => (svc) => {
    const ip = svc.addresses?.find((a) => !a.includes(':') && a !== '127.0.0.1')
    if (!ip) return
    found.push({ type, address: `${ip}:${svc.port}`, name: svc.name })
  }
  const browsers = [
    bonjour.find({ type: 'adb-tls-pairing' }, record('pairing')),
    bonjour.find({ type: 'adb-tls-connect' }, record('connect')),
  ]
  await sleep(Math.min(Math.max(windowMs, 3000), 30000))
  browsers.forEach((browser) => browser.stop())
  bonjour.destroy()
  return found
}

/**
 * 以管理员授权把本应用加入防火墙放行列表（系统原生密码弹窗）。
 * 仅打包安装后可用；开发模式返回提示。
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function allowFirewall() {
  const bundlePath = appBundlePath()
  if (!bundlePath) {
    return { ok: false, detail: '开发模式不适用，仅打包安装后可用' }
  }
  const script =
    `do shell script "'${FIREWALL_CLI}' --add '${bundlePath}'; ` +
    `'${FIREWALL_CLI}' --unblock '${bundlePath}'" with administrator privileges`
  try {
    await execAsync('osascript', ['-e', script], { timeout: 120000 })
    return { ok: true, detail: '防火墙已放行本应用' }
  } catch (error) {
    const message = String(error.message || error)
    return {
      ok: false,
      detail: /cancel/i.test(message) ? '已取消管理员授权' : message,
    }
  }
}

/** 深链打开"本地网络"设置面板；多锚点依次尝试。 */
export async function openLocalNetworkSettings() {
  // 先做一次真实组播访问：若从未询问过，系统会借机弹出授权窗
  await checkMulticast()
  for (const anchor of LOCAL_NETWORK_ANCHORS) {
    try {
      await execAsync('open', [anchor], { timeout: 5000 })
      return true
    } catch {
      // 尝试下一个锚点
    }
  }
  return false
}
