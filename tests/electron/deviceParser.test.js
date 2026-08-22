import { describe, expect, it } from 'vitest'
import { parseAdbDevices, parseDeviceInfo } from '../../electron/adb/deviceParser.js'

describe('parseAdbDevices', () => {
  it('parses all recognized states and trailing metadata', () => {
    const output = [
      'List of devices attached',
      'phone:5555\tdevice product:test model:Phone',
      'offline:5555\toffline',
      'usb-id\tunauthorized usb:1-1',
      '',
    ].join('\r\n')
    expect(parseAdbDevices(output)).toEqual([
      { serial: 'phone:5555', state: 'device' },
      { serial: 'offline:5555', state: 'offline' },
      { serial: 'usb-id', state: 'unauthorized' },
    ])
  })

  it('ignores daemon noise and malformed lines', () => {
    expect(parseAdbDevices('* daemon started successfully *\ninvalid\n')).toEqual([])
  })
})

describe('parseDeviceInfo', () => {
  it('parses market name, battery, charging, and data storage', () => {
    expect(
      parseDeviceInfo({
        serial: 'device:5555',
        model: 'Model',
        brand: 'Brand',
        marketname: 'Television',
        batteryOutput: '  level: 87\n  status: 2',
        storageOutput: '/dev/block/data 100G 25G 75G 25% /data',
      }),
    ).toEqual({
      serial: 'device:5555',
      model: 'Model',
      deviceName: 'Brand Television',
      battery: 87,
      isCharging: true,
      storage: '25G/100G',
      storagePercent: 25,
    })
  })

  it('falls back to brand and model when outputs are missing', () => {
    expect(
      parseDeviceInfo({
        serial: 'serial',
        model: 'Model',
        brand: 'Brand',
        marketname: '',
        batteryOutput: '',
        storageOutput: '',
      }),
    ).toEqual({
      serial: 'serial',
      model: 'Model',
      deviceName: 'Brand Model',
      battery: -1,
      isCharging: false,
      storage: '',
      storagePercent: 0,
    })
  })
})
