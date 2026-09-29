import { describe, expect, it, vi } from 'vitest'

const quitHooks = []

vi.mock('electron', () => ({
  app: { getPath: () => '', on: (_event, hook) => quitHooks.push(hook) },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(async () => '') },
}))

// 只替 adb：解析用的是真机 helper 输出，这条测试锁的是「先升级到随包版本 → 跑 StorageMain → 出卷」。
const HELPER_OUT =
  '{"volumes":[{"id":"internal","kind":"internal","description":null,"path":"/storage/emulated/0","totalBytes":528000000000,"freeBytes":272192565248,"entryCount":105}],"rootEntries":40}'

const calls = []
const runHelperEntry = vi.fn(async () => {
  calls.push('run')
  return { stdout: HELPER_OUT, stderr: '' }
})
const ensureLatestHelper = vi.fn(async () => {
  calls.push('ensure')
})
const teardownHooks = []

vi.mock('../../electron/adb.js', () => ({
  ensureServer: vi.fn(async () => {}),
  ensureLatestHelper: (serial) => ensureLatestHelper(serial),
  runHelperEntry: (serial, entryClass, args) => runHelperEntry(serial, entryClass, args),
  onDeviceTeardown: (hook) => {
    teardownHooks.push(hook)
    return () => {}
  },
}))

const { getStorageReport, clearStorageCache, mountFolderName } = await import(
  '../../electron/storage.js'
)

describe('mountFolderName', () => {
  it('卷名会成为访达里的卷标题：去掉斜杠与控制字符，空白折叠', () => {
    expect(mountFolderName('Xiaomi 17 Pro Max', '内部存储')).toBe('Xiaomi 17 Pro Max 内部存储')
    expect(mountFolderName('a/b', 'SD\u0007卡')).toBe('a b SD卡')
    expect(mountFolderName('   ', '')).toBe('AndDrive')
    expect(mountFolderName('x'.repeat(60), '')).toHaveLength(40)
  })
})

describe('getStorageReport', () => {
  it('先确保 helper 是随包版本，再跑 StorageMain，并把卷容量透出来', async () => {
    clearStorageCache()
    calls.length = 0
    const report = await getStorageReport('10.0.0.5:5555', true)

    expect(calls).toEqual(['ensure', 'run'])
    expect(runHelperEntry).toHaveBeenCalledWith('10.0.0.5:5555', 'com.anddrive.helper.StorageMain', [
      '0',
    ])
    expect(report.serial).toBe('10.0.0.5:5555')
    expect(report.volumes.map((item) => item.id)).toEqual(['camera', 'internal', 'root'])
    // 与竞品/手机设置同一个数：528.0 GB 总量、48% 已用。
    expect(report.summary.totalBytes).toBe(528000000000)
    expect(report.summary.percentUsed).toBe(48)
  })

  it('15 秒内复用缓存，force 才重跑', async () => {
    clearStorageCache()
    runHelperEntry.mockClear()
    await getStorageReport('cached:5555', true)
    expect((await getStorageReport('cached:5555')).volumes.length).toBe(3)
    expect(runHelperEntry).toHaveBeenCalledTimes(1)

    await getStorageReport('cached:5555', true)
    expect(runHelperEntry).toHaveBeenCalledTimes(2)
  })

  it('设备断开时按 serial 清掉读数', async () => {
    clearStorageCache()
    runHelperEntry.mockClear()
    await getStorageReport('gone:5555', true)
    teardownHooks.forEach((hook) => hook('gone:5555'))
    await getStorageReport('gone:5555')
    expect(runHelperEntry).toHaveBeenCalledTimes(2)
  })

  it('helper 没输出时把设备侧的报错带出来，而不是给一张空表', async () => {
    clearStorageCache()
    runHelperEntry.mockResolvedValueOnce({
      stdout: '',
      stderr: 'StorageMain failed: IOException: Failed to find storage device',
    })
    await expect(getStorageReport('odd:5555', true)).rejects.toThrow('Failed to find storage device')
  })

  it('拒绝空序列号', async () => {
    await expect(getStorageReport('')).rejects.toThrow('设备序列号无效')
  })
})
