import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

const { parseMdnsServices, parseAdbDevices, pickMdnsService, serviceDeviceToken } =
  await import('../../electron/adb.js')

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

describe('serviceDeviceToken', () => {
  it('strips the per-session random suffix and the service suffix', () => {
    expect(serviceDeviceToken('adb-af3d7abd')).toBe('af3d7abd')
    expect(serviceDeviceToken('adb-af3d7abd-Zvci5V')).toBe('af3d7abd')
    expect(serviceDeviceToken('adb-af3d7abd-Zvci5V._adb-tls-connect._tcp')).toBe('af3d7abd')
  })

  it('returns empty for names that are not adb services', () => {
    expect(serviceDeviceToken('printer._ipp._tcp')).toBe('')
    expect(serviceDeviceToken('adb-')).toBe('')
    expect(serviceDeviceToken(undefined)).toBe('')
    // 前缀按 adb 实际产出严格小写匹配；比对时只把**标识段**统一小写。
    expect(serviceDeviceToken('ADB-AB12._adb-tls-pairing._tcp')).toBe('')
  })
})

describe('pickMdnsService', () => {
  const CONNECT = '_adb-tls-connect._tcp'
  const twoDevices = [
    { name: 'adb-OTHER', type: CONNECT, address: '10.0.0.9:40000' },
    { name: 'adb-TARGET-Aaaabb', type: CONNECT, address: '10.0.0.8:40001' },
  ]

  it('keeps the old "first match" behaviour without a hint', () => {
    expect(pickMdnsService(twoDevices, CONNECT)).toEqual(twoDevices[0])
    expect(pickMdnsService(twoDevices, CONNECT, {})).toEqual(twoDevices[0])
  })

  it('prefers the service whose device token matches the pairing service', () => {
    expect(pickMdnsService(twoDevices, CONNECT, { token: 'target' })).toEqual(twoDevices[1])
  })

  it('falls back to the same host when names carry no comparable token', () => {
    const services = [
      { name: 'weird-one', type: CONNECT, address: '10.0.0.9:40000' },
      { name: 'weird-two', type: CONNECT, address: '10.0.0.8:40001' },
    ]
    expect(pickMdnsService(services, CONNECT, { host: '10.0.0.8' })).toEqual(services[1])
  })

  it('ranks the device token above a coincidental host match', () => {
    const services = [
      { name: 'adb-TARGET', type: CONNECT, address: '10.0.0.9:40000' },
      { name: 'adb-NOTHER', type: CONNECT, address: '10.0.0.8:40001' },
    ]
    expect(pickMdnsService(services, CONNECT, { token: 'target', host: '10.0.0.8' })).toEqual(
      services[0],
    )
  })

  it('returns undefined when no service has the requested type', () => {
    expect(pickMdnsService(twoDevices, '_adb-tls-pairing._tcp', { token: 'target' })).toBeUndefined()
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

  it('keeps USB serials and the authorization handshake states', () => {
    const output = [
      'List of devices attached',
      'fb637d72\tdevice',
      'R58M1234567\tauthorizing',
      '0123456789ABCDEF\tconnecting',
      '1A2B3C4D\tunauthorized',
      '',
    ].join('\n')

    expect(parseAdbDevices(output)).toEqual(
      new Map([
        ['fb637d72', 'device'],
        ['R58M1234567', 'authorizing'],
        ['0123456789ABCDEF', 'connecting'],
        ['1A2B3C4D', 'unauthorized'],
      ]),
    )
  })

  it('returns an empty map when nothing is attached', () => {
    expect(parseAdbDevices('List of devices attached\n')).toEqual(new Map())
    expect(parseAdbDevices(undefined)).toEqual(new Map())
  })
})
