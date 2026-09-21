import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ calls: [], mode: 'ok' }))

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

// 替掉真实的 adb 子进程：只关心「有没有带超时」「超时后上层怎么办」。
vi.mock('node:child_process', () => ({
  execFile: (file, args, options, callback) => {
    const cb = typeof options === 'function' ? options : callback
    state.calls.push({ args, options: typeof options === 'function' ? {} : options })
    if (args[0] === 'start-server') return cb(null, '', '')
    if (state.mode === 'timeout') {
      // Node 超时杀子进程的特征：killed + SIGTERM，且 stderr 为空。
      return cb(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }), '', '')
    }
    return cb(null, 'List of devices attached\n192.168.100.91:5555\tdevice\n\n', '')
  },
}))

const { getDeviceState } = await import('../../electron/adb.js')

const serial = '192.168.100.91:5555'

beforeEach(() => {
  state.calls.length = 0
  state.mode = 'ok'
})

describe('adb 调用超时', () => {
  it('正常输出照常解析状态', async () => {
    expect(await getDeviceState(serial)).toBe('device')
  })

  it('命令挂死时不再无限等待，状态按离线上报', async () => {
    // 旧行为：adb 不退出也不报错，调用方永远等不到结果，界面停在 spinner。
    state.mode = 'timeout'
    await expect(getDeviceState(serial)).resolves.toBe('offline')
  })

  it('每次 adb 调用都带超时', async () => {
    state.mode = 'timeout'
    await getDeviceState(serial)
    expect(state.calls.length).toBeGreaterThan(0)
    for (const call of state.calls) {
      expect(call.options.timeout).toBeTypeOf('number')
      expect(call.options.timeout).toBeGreaterThan(0)
    }
  })
})
