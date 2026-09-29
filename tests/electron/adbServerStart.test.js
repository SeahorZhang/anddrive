import { describe, expect, it, vi } from 'vitest'

// `ensureServer()` 的并发竞态：标记要等 `start-server` 返回才置位，这段时间里每个调用者
// 都会各自 fork 一个 adb —— 第二个死在 `Address already in use`，上层就报「发现设备失败」。
// 这里把 execFile 换成计数器，验同一次进程内并发只会起一个。

const calls = vi.hoisted(() => [])
let failNext = false

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
  BrowserWindow: class {},
}))

vi.mock('node:child_process', () => ({
  execFile: (bin, args, opts, cb) => {
    calls.push(args.join(' '))
    queueMicrotask(() => {
      if (failNext) cb(Object.assign(new Error('ADB server didn\'t ACK'), { stderr: 'nope' }), '', '')
      else cb(null, '', '')
    })
  },
}))

const startServerCalls = () => calls.filter((line) => line === 'start-server').length

/** 模块级标记（serverStarted / 在途 promise）每个用例都要从零开始。 */
const freshAdb = async () => {
  vi.resetModules()
  calls.length = 0
  failNext = false
  return import('../../electron/adb.js')
}

describe('ensureServer', () => {
  it('并发调用共用同一次 start-server，不抢 5037', async () => {
    const { ensureServer } = await freshAdb()
    await Promise.all([ensureServer(), ensureServer(), ensureServer(), ensureServer()])
    expect(startServerCalls()).toBe(1)
  })

  it('启动失败不焊死状态：下一次调用会真的重试', async () => {
    const { ensureServer } = await freshAdb()
    failNext = true
    await expect(ensureServer()).rejects.toThrow()
    expect(startServerCalls()).toBe(1)

    failNext = false
    await ensureServer()
    expect(startServerCalls()).toBe(2)
  })
})
