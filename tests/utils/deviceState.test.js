import { describe, expect, it } from 'vitest'
import {
  deviceTransports,
  pickAdoptableDevice,
  markDevicesKnown,
  watchNewConnectedDevices,
  sameDevice,
  transportText,
  transportState,
} from '../../src/utils/deviceState.js'

// 一台手机插着线又开着无线调试时，主进程会把它并成列表里的一行：
// 界面只读这一份，不再自己数接法、也不再单独问一遍 adb 状态。
const USB = 'af3d7abd'
const WIFI = 'adb-af3d7abd-Zvci5V._adb-tls-connect._tcp'

const conn = (address, transport, state = 'device') => ({
  address,
  transport,
  state,
  connected: state === 'device',
})

const bothRow = () => ({
  stableId: USB,
  address: USB,
  transport: 'usb',
  transports: ['usb', 'wifi'],
  connections: [conn(USB, 'usb'), conn(WIFI, 'wifi')],
})

describe('deviceTransports', () => {
  it('同一台手机的两种接法都返回', () => {
    expect(deviceTransports(bothRow())).toEqual(['usb', 'wifi'])
    expect(deviceTransports(bothRow()).map(transportText)).toEqual(['USB', '无线'])
  })
})

describe('transportState', () => {
  it('按会话正在用的那条 transport 回报状态', () => {
    expect(transportState([bothRow()], WIFI)).toBe('device')
    expect(transportState([bothRow()], USB)).toBe('device')
  })

  it('线被拔掉后只剩无线：USB 那条算 absent，整台手机仍然认得', () => {
    const row = {
      ...bothRow(),
      address: WIFI,
      transport: 'wifi',
      transports: ['wifi'],
      connections: [conn(WIFI, 'wifi')],
    }
    expect(transportState([row], USB)).toBe('absent')
    expect(deviceTransports(row)).toEqual(['wifi'])
  })

  it('会话那条 transport 掉线但手机还在时，回报它的真实状态', () => {
    const row = { ...bothRow(), connections: [conn(USB, 'usb'), conn(WIFI, 'wifi', 'offline')] }
    expect(transportState([row], WIFI)).toBe('offline')
  })

  it('列表里没有这台设备时算 absent', () => {
    expect(transportState([], USB)).toBe('absent')
  })
})

// 当前展示的设备不许自己变：别的手机插上来只提醒一次，而且「新」是按轮次差集算的。
describe('watchNewConnectedDevices', () => {
  const live = (row) => ({ ...row, connected: true })
  const currentRow = () => live(bothRow())
  const otherRow = () => ({
    stableId: 'c0ffee00',
    address: '192.168.1.9:5555',
    connected: true,
    connections: [conn('192.168.1.9:5555', 'wifi')],
  })

  it('接管时已经认识的设备不算新出现（从扫码页连上一台，不该立刻提醒另一台）', () => {
    const seen = new Set()
    const list = [currentRow(), otherRow()]
    // adoptDevice 的播种：先记下列表现有的这些
    markDevicesKnown(list, seen)
    expect(watchNewConnectedDevices(list, seen, list[0])).toEqual([])
  })

  it('下一轮才冒出来的可连接设备报一次，再刷不重复报', () => {
    const seen = new Set()
    const current = currentRow()
    watchNewConnectedDevices([current], seen, current)
    const other = otherRow()
    const round2 = watchNewConnectedDevices([current, other], seen, current)
    expect(round2.map((d) => d.stableId)).toEqual(['c0ffee00'])
    expect(watchNewConnectedDevices([current, other], seen, current)).toEqual([])
  })

  it('拔掉再插回来算新出现', () => {
    const seen = new Set()
    const current = currentRow()
    const other = otherRow()
    watchNewConnectedDevices([current, other], seen, current)
    watchNewConnectedDevices([current], seen, current)
    expect(watchNewConnectedDevices([current, other], seen, current).map((d) => d.stableId)).toEqual([
      'c0ffee00',
    ])
  })

  it('当前在用的那台永远不报，哪怕刚出现', () => {
    const seen = new Set()
    const current = currentRow()
    expect(watchNewConnectedDevices([current], seen, current)).toEqual([])
  })

  it('待授权的不算「可以连接」', () => {
    const seen = new Set()
    const current = currentRow()
    const pending = { ...otherRow(), connected: false, state: 'unauthorized' }
    expect(watchNewConnectedDevices([current, pending], seen, current)).toEqual([])
  })
})

describe('sameDevice', () => {
  it('接管记录带着 stableId 时，address 是另一条接法也算同一台', () => {
    expect(sameDevice(bothRow(), { stableId: USB, address: WIFI })).toBe(true)
    expect(sameDevice(bothRow(), { stableId: USB, address: USB })).toBe(true)
  })

  it('没有 stableId 时退回 address 相比', () => {
    expect(sameDevice({ address: USB }, { address: USB })).toBe(true)
  })

  it('不同手机不算', () => {
    expect(sameDevice(bothRow(), { stableId: 'c0ffee00', address: 'c0ffee00' })).toBe(false)
    expect(sameDevice(null, bothRow())).toBe(false)
  })
})

// 没连着设备时的静默接管：只有一台才接管，多台留给用户点。
describe('pickAdoptableDevice', () => {
  const live = (row) => ({ ...row, connected: true })
  const currentRow = () => live(bothRow())
  const otherRow = () => ({ stableId: 'c0ffee00', address: 'c0ffee00', connected: true })

  it('只有一台可连接时接管它', () => {
    expect(pickAdoptableDevice([currentRow()])?.stableId).toBe(USB)
  })

  it('两台不同手机同时在线时谁都不接管', () => {
    expect(pickAdoptableDevice([currentRow(), otherRow()])).toBeNull()
  })

  it('两台同时在线时，接管上次用过的那台（记过谁 = 用户自己已经答过这个问题）', () => {
    expect(pickAdoptableDevice([currentRow(), otherRow()], 'c0ffee00')?.stableId).toBe('c0ffee00')
    expect(pickAdoptableDevice([currentRow(), otherRow()], USB)?.stableId).toBe(USB)
  })

  it('记的那台不在这份列表里时回到「不接管」，不能因为认得就随便挑一台', () => {
    expect(pickAdoptableDevice([currentRow(), otherRow()], 'deadbeef')).toBeNull()
    expect(pickAdoptableDevice([currentRow(), otherRow()])).toBeNull()
  })

  it('记的那台待授权、只有另一台可连接时，接管可连接那台（一条规则不因记忆而落空）', () => {
    const pending = { ...otherRow(), connected: false }
    expect(pickAdoptableDevice([currentRow(), pending], 'c0ffee00')?.stableId).toBe(USB)
  })

  it('可连接的只有一台、另一台待授权时接管那台', () => {
    const pending = { ...otherRow(), connected: false }
    expect(pickAdoptableDevice([currentRow(), pending])?.stableId).toBe(USB)
  })

  it('一台都没有时空', () => {
    expect(pickAdoptableDevice([{ stableId: 'x', connected: false }])).toBeNull()
  })
})
