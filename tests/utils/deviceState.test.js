import { describe, expect, it } from 'vitest'
import { deviceTransports, transportText, transportState } from '../../src/utils/deviceState.js'

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
