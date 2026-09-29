import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { CHANNELS } from '../../electron/ipcContract.js'

// 通道字符串是主进程 handler 与 preload 之间唯一的约定，写错了不会编译报错、
// 只会在运行时静默串到别的 handler 上，所以这里把形状与唯一性钉住。
const MIRROR_SOURCE_DIR = new URL('../../src/mirror/', import.meta.url)

/** 镜像窗口（contextIsolation 关）自己 import CHANNELS 用，不走 preload。 */
function channelsUsedByMirrorWindow() {
  const used = new Set()
  for (const name of readdirSync(MIRROR_SOURCE_DIR)) {
    if (!/\.(js|vue)$/.test(name)) continue
    const source = readFileSync(new URL(name, MIRROR_SOURCE_DIR), 'utf8')
    for (const match of source.matchAll(/CHANNELS\.([A-Za-z]+)/g)) used.add(match[1])
  }
  return used
}
describe('IPC 通道契约', () => {
  const entries = Object.entries(CHANNELS)
  const values = entries.map(([, value]) => value)

  it('条目不为空', () => {
    expect(entries.length).toBeGreaterThan(20)
  })

  it('通道值互不相同（重复会让后注册的 handler 静默覆盖前一个）', () => {
    expect(new Set(values).size).toBe(values.length)
  })

  it.each(entries)('通道 %s 的取值形如 命名空间:名称', (_key, value) => {
    expect(typeof value).toBe('string')
    expect(value).toMatch(/^[a-zA-Z][A-Za-z]*:[A-Za-z][A-Za-z]*$/)
  })

  it('键名是驼峰、不加会踩 shell/plist 的字符', () => {
    for (const [key, value] of entries) {
      expect(key).toMatch(/^[a-z][A-Za-z]*$/)
      expect(value).not.toMatch(/\s/)
    }
  })

  // 漏一条的后果是渲染层拿到 `undefined` 函数、点了没反应，运行时一句错都不报。
  it('每个通道都被桥接：主窗口走 preload，镜像窗口自己 import CHANNELS', () => {
    const preload = readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8')
    const bridged = new Set([...preload.matchAll(/CHANNELS\.([A-Za-z]+)/g)].map((m) => m[1]))
    const direct = channelsUsedByMirrorWindow()
    const missing = Object.keys(CHANNELS).filter((key) => !bridged.has(key) && !direct.has(key))
    expect(missing).toEqual([])
  })
})
