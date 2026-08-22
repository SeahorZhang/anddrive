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
  it('prefers market name when available', () => {
    expect(
      parseDeviceInfo({
        serial: 'device:5555',
        model: 'Model',
        brand: 'Brand',
        marketname: 'Television',
      }),
    ).toEqual({
      serial: 'device:5555',
      model: 'Model',
      deviceName: 'Brand Television',
    })
  })

  it('falls back to brand and model when market name is missing', () => {
    expect(
      parseDeviceInfo({
        serial: 'serial',
        model: 'Model',
        brand: 'Brand',
        marketname: '',
      }),
    ).toEqual({
      serial: 'serial',
      model: 'Model',
      deviceName: 'Brand Model',
    })
  })
})
