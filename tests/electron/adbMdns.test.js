import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

const { parseMdnsServices, parseAdbDevices } = await import('../../electron/adb.js')

describe('parseMdnsServices', () => {
  it('parses adb mdns services output into name/type/address', () => {
    const output = [
      'List of discovered mdns services',
      'adb-ABC123\t_adb-tls-connect._tcp\t192.168.1.5:37000',
      'adb-ABC123-XyZ\t_adb-tls-pairing._tcp\t192.168.1.5:37001',
    ].join('\n')

    expect(parseMdnsServices(output)).toEqual([
      { name: 'adb-ABC123', type: '_adb-tls-connect._tcp', address: '192.168.1.5:37000' },
      { name: 'adb-ABC123-XyZ', type: '_adb-tls-pairing._tcp', address: '192.168.1.5:37001' },
    ])
  })

  it('ignores the header and blank or malformed lines', () => {
    const output = [
      'List of discovered mdns services',
      '',
      'not-a-service',
      'name\ttype',
      'adb-ABC123 _adb-tls-connect._tcp 192.168.1.5:37000',
    ].join('\n')

    expect(parseMdnsServices(output)).toEqual([
      { name: 'adb-ABC123', type: '_adb-tls-connect._tcp', address: '192.168.1.5:37000' },
    ])
  })

  it('returns an empty list for empty output', () => {
    expect(parseMdnsServices('')).toEqual([])
    expect(parseMdnsServices(undefined)).toEqual([])
  })
})

describe('parseAdbDevices', () => {
  it('maps serials to their state', () => {
    const output = [
      'List of devices attached',
      'adb-ABC123-XyZ._adb-tls-connect._tcp\tdevice',
      '192.168.1.5:37000\tdevice',
      'adb-OFFLINE._adb-tls-connect._tcp\toffline',
      'adb-UNAUTH._adb-tls-connect._tcp\tunauthorized',
      '',
    ].join('\n')

    expect(parseAdbDevices(output)).toEqual(
      new Map([
        ['adb-ABC123-XyZ._adb-tls-connect._tcp', 'device'],
        ['192.168.1.5:37000', 'device'],
        ['adb-OFFLINE._adb-tls-connect._tcp', 'offline'],
        ['adb-UNAUTH._adb-tls-connect._tcp', 'unauthorized'],
      ]),
    )
  })

  it('returns an empty map when nothing is attached', () => {
    expect(parseAdbDevices('List of devices attached\n')).toEqual(new Map())
    expect(parseAdbDevices(undefined)).toEqual(new Map())
  })
})
