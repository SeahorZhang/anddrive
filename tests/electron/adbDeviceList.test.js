import { describe, expect, it, vi } from 'vitest'

// 同一台手机插着线又开着无线调试时，adb 里是两条 transport
// （USB serial + `host:port` / `adb-XXXX._adb-tls-connect._tcp`），
// 设备列表必须按稳定标识并成一行，否则界面上就是「一台机器显示两个」。

const ipcHandlers = vi.hoisted(() => new Map())
const adbOut = vi.hoisted(() => ({
  devices: '',
  mdns: '',
  /** serial → `getprop ro.serialno; …` 的输出；undefined 表示这条命令失败。 */
  stableIds: {},
  /** 每次 execFile 的参数，断言用。 */
  calls: [],
}))

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0-test', isPackaged: false },
  ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn), on: () => {} },
  dialog: {},
  BrowserWindow: class {},
}))

vi.mock('node:child_process', () => ({
  execFile: (_bin, args, _opts, cb) => {
    const line = args.join(' ')
    adbOut.calls.push(line)
    queueMicrotask(() => {
      if (line === 'start-server') return cb(null, '', '')
      if (line === 'devices') return cb(null, adbOut.devices, '')
      if (line === 'mdns services') return cb(null, adbOut.mdns, '')
      if (line.includes('getprop ro.serialno')) {
        const serial = args[1]
        if (adbOut.stableIds[serial] === undefined) return cb(new Error('device offline'), '', '')
        return cb(null, adbOut.stableIds[serial], '')
      }
      // deviceDisplayName 的那三条读取：回空，label 保持 null
      return cb(null, '', '')
    })
  },
}))

vi.mock('node:fs', () => ({
  promises: {
    mkdir: () => Promise.resolve(),
    writeFile: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    unlink: () => Promise.resolve(),
    readFile: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    readdir: () => Promise.resolve([]),
    stat: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    rm: () => Promise.resolve(),
  },
  readFileSync: () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
}))

// ensureConnectBrowser 起的是真 mDNS 浏览器，这里给个空实现
vi.mock('../../electron/mdns.js', () => ({ browse: () => () => {} }))

/** 每个用例从零开始（别名表 / 设备名缓存 / ipc 注册都在模块级）。 */
async function loadHandlers({ devices, mdns = '', stableIds = {} }) {
  vi.resetModules()
  adbOut.devices = devices
  adbOut.mdns = mdns
  adbOut.stableIds = stableIds
  adbOut.calls.length = 0
  await import('../../electron/adb.js')
  return {
    list: ipcHandlers.get('adb:listConnectDevices'),
    adopted: ipcHandlers.get('adb:getConnectedDevice'),
  }
}

async function listDevices(input) {
  const { list } = await loadHandlers(input)
  expect(list).toBeTypeOf('function')
  return list()
}

const USB = 'af3d7abd'
const WIFI = '192.168.1.5:37000'
const MDNS = 'adb-af3d7abd-Zvci5V._adb-tls-connect._tcp'

describe('listConnectDevices 的同设备归并', () => {
  it('USB + 无线同一台 serial 时只出一行，代表行取有线', async () => {
    const list = await listDevices({
      devices: `List of devices attached\n${USB}\tdevice\n${WIFI}\tdevice\n`,
      stableIds: { [USB]: 'af3d7abd', [WIFI]: 'af3d7abd' },
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      stableId: 'af3d7abd',
      address: USB,
      transport: 'usb',
      // 两种接法都在，界面据此把 USB 和无线两个标记一起标出来
      transports: ['usb', 'wifi'],
      // 心跳读的是这一份：会话用哪条 transport 就查那条的状态
      connections: [
        { address: USB, transport: 'usb', state: 'device', connected: true },
        { address: WIFI, transport: 'wifi', state: 'device', connected: true },
      ],
      connected: true,
      state: 'device',
    })
  })

  it('无线调试的 mDNS 实例名与 USB serial 归成一行', async () => {
    const list = await listDevices({
      devices: `List of devices attached\n${USB}\tdevice\n${MDNS}\tdevice\n`,
      stableIds: { [USB]: 'af3d7abd', [MDNS]: 'af3d7abd' },
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      stableId: 'af3d7abd',
      address: USB,
      transport: 'usb',
      transports: ['usb', 'wifi'],
    })
  })

  it('问不到设备时靠 mDNS 实例名里嵌的序列号兜底', async () => {
    const list = await listDevices({
      devices: `List of devices attached\n${USB}\tdevice\n${MDNS}\tdevice\n`,
      stableIds: { [USB]: 'af3d7abd' },
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB })
  })

  it('USB 还没授权、无线已在线时也只出一行，代表行取在线的无线', async () => {
    const list = await listDevices({
      devices: `List of devices attached\n${USB}\tauthorizing\n${WIFI}\tdevice\n`,
      stableIds: { [WIFI]: 'af3d7abd' },
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      address: WIFI,
      transport: 'wifi',
      connected: true,
      state: 'device',
    })
  })

  it('两台不同的手机不会被并到一起', async () => {
    const other = '192.168.1.6:5555'
    const list = await listDevices({
      devices: `List of devices attached\n${USB}\tdevice\n${other}\tdevice\n`,
      stableIds: { [USB]: 'af3d7abd', [other]: 'c0ffee00' },
    })
    expect(list).toHaveLength(2)
    expect(list.map((d) => d.stableId).sort()).toEqual(['af3d7abd', 'c0ffee00'])
  })

  it('只连无线时仍是单独一行', async () => {
    const list = await listDevices({
      devices: `List of devices attached\n${WIFI}\tdevice\n`,
      stableIds: { [WIFI]: 'af3d7abd' },
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      address: WIFI,
      transport: 'wifi',
      transports: ['wifi'],
      stableId: 'af3d7abd',
    })
  })
})

// 首页上方的标记取自「当前设备」，而启动接管走的是 getConnectedDevice，
// 它挑的是无线那条，所以接法要按整台手机算，不能只回报代表那一条。
describe('getConnectedDevice 的同设备接法', () => {
  async function adopt(input) {
    const { adopted } = await loadHandlers(input)
    expect(adopted).toBeTypeOf('function')
    return adopted()
  }

  it('接管无线那条时，同一台的有线也一起标上', async () => {
    const device = await adopt({
      devices: `List of devices attached\n${USB}\tdevice\n${MDNS}\tdevice\n`,
      stableIds: { [USB]: 'af3d7abd', [MDNS]: 'af3d7abd' },
    })
    expect(device).toMatchObject({
      address: MDNS,
      transport: 'wifi',
      transports: ['usb', 'wifi'],
      stableId: 'af3d7abd',
    })
    // 会话钉在无线这条上，但心跳要能按 address 查到这一条，也能看到有线那条还在
    expect(device.connections.map((c) => c.address)).toEqual([USB, MDNS])
    expect(device.connections[1]).toMatchObject({ transport: 'wifi', state: 'device' })
  })

  it('只插了线时接法只有有线', async () => {
    const device = await adopt({
      devices: `List of devices attached\n${USB}\tdevice\n`,
      stableIds: { [USB]: 'af3d7abd' },
    })
    expect(device).toMatchObject({ address: USB, transport: 'usb', transports: ['usb'] })
  })

  it('两台不同手机同时在线时不接管任何一台', async () => {
    // 曾经这里会挑一条回来（无线优先，否则第一台），于是 USB 上正在用的那台
    // 会被列表里的另一台顶掉。「接管哪台」是用户的决定，主进程不代挑。
    const other = 'c0ffee00'
    const device = await adopt({
      devices: `List of devices attached\n${USB}\tdevice\n${other}\tdevice\n`,
      stableIds: { [USB]: 'af3d7abd', [other]: 'c0ffee00' },
    })
    expect(device).toBeNull()
  })

  it('另一台手机走无线也不接管', async () => {
    const device = await adopt({
      devices: `List of devices attached\n${USB}\tdevice\n192.168.1.9:5555\tdevice\n`,
      stableIds: { [USB]: 'af3d7abd', '192.168.1.9:5555': 'c0ffee00' },
    })
    expect(device).toBeNull()
  })
})
