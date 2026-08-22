import { describe, expect, it } from 'vitest'
import { parseAdbDevices, parseDeviceInfo, parseIconBatch } from '../../electron/adb/parsers.js'

function iconFrame(packageName, icon) {
  const name = Buffer.from(packageName)
  const body = Buffer.from(icon)
  const header = Buffer.alloc(2 + name.length + 4)
  header.writeUInt16BE(name.length, 0)
  name.copy(header, 2)
  header.writeUInt32BE(body.length, 2 + name.length)
  return Buffer.concat([header, body])
}

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

describe('parseIconBatch', () => {
  it('parses multiple big-endian frames and skips empty icons', () => {
    const buffer = Buffer.concat([
      iconFrame('com.one', [1, 2, 3]),
      iconFrame('com.empty', []),
      iconFrame('com.two', [4]),
    ])
    expect(parseIconBatch(buffer)).toEqual([
      { packageName: 'com.one', iconUrl: 'data:image/png;base64,AQID' },
      { packageName: 'com.two', iconUrl: 'data:image/png;base64,BA==' },
    ])
  })

  it('returns complete frames before a truncated frame', () => {
    const valid = iconFrame('com.one', [1])
    const truncated = iconFrame('com.two', [2, 3]).subarray(0, -1)
    expect(parseIconBatch(Buffer.concat([valid, truncated]))).toEqual([
      { packageName: 'com.one', iconUrl: 'data:image/png;base64,AQ==' },
    ])
  })

  it('rejects a zero-length package frame without throwing', () => {
    expect(parseIconBatch(Buffer.from([0, 0]))).toEqual([])
  })
})
