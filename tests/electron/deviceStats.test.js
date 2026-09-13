import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const { parseDeviceStats } = await import('../../electron/adb.js')

const PROPS = [
  '[ro.product.model]: [Pixel 6]',
  '[ro.product.brand]: [google]',
  '[ro.product.manufacturer]: [Google]',
  '[ro.build.version.release]: [14]',
  '[ro.build.version.sdk]: [34]',
  '[ro.soc.model]: [Google Tensor]',
].join('\n')

const STORAGE = [
  'Filesystem      1K-blocks      Used Available Use% Mounted on',
  '/dev/block/dm-6 117182328  45123456  72058872  39% /data',
].join('\n')

const BATTERY = [
  'Current Battery Service state:',
  '  AC powered: false',
  '  USB powered: true',
  '  status: 2',
  '  level: 85',
  '  scale: 100',
  '  temperature: 320',
].join('\n')

const MEMORY = ['MemTotal:        3836524 kB', 'MemAvailable:    1200000 kB'].join('\n')

const CPU = ['0.15 0.10 0.05 1/800 12345', '---', '8', '###', 'Hardware\t: Qualcomm SM8350'].join('\n')

const NETWORK = [
  '1: lo    inet 127.0.0.1/8 scope host lo',
  '2: wlan0    inet 192.168.1.55/24 brd 192.168.1.255 scope global wlan0',
].join('\n')

describe('parseDeviceStats', () => {
  it('parses props, cpu, memory, storage, battery and network', () => {
    const stats = parseDeviceStats(
      { props: PROPS, storage: STORAGE, battery: BATTERY, memory: MEMORY, cpu: CPU, network: NETWORK },
      '192.168.1.55:5555',
    )

    expect(stats.model).toBe('Pixel 6')
    expect(stats.brand).toBe('google')
    expect(stats.manufacturer).toBe('Google')
    expect(stats.androidVersion).toBe('14')
    expect(stats.sdk).toBe(34)

    expect(stats.cpu).toEqual({ model: 'Google Tensor', cores: 8, load1: 0.15 })

    expect(stats.memory).toEqual({
      totalBytes: 3836524 * 1024,
      availableBytes: 1200000 * 1024,
      usedBytes: (3836524 - 1200000) * 1024,
    })

    expect(stats.storage).toEqual({
      totalBytes: 117182328 * 1024,
      usedBytes: 45123456 * 1024,
      availableBytes: 72058872 * 1024,
      percentUsed: 39,
    })

    expect(stats.battery).toEqual({
      level: 85,
      status: 'charging',
      temperatureC: 32,
      charging: true,
    })

    expect(stats.network).toEqual({ ip: '192.168.1.55', interface: 'wlan0' })
  })

  it('falls back to the serial host when ip output is empty', () => {
    const stats = parseDeviceStats({ network: '' }, '10.0.0.2:5555')
    expect(stats.network).toEqual({ ip: '10.0.0.2', interface: null })
  })

  it('falls back to hardware prop for cpu model', () => {
    const stats = parseDeviceStats({ props: PROPS, cpu: ['', '---', '6', '###', 'Hardware\t: Tesla'].join('\n') })
    expect(stats.cpu.cores).toBe(6)
    expect(stats.cpu.model).toBe('Google Tensor')

    const withoutSoc = parseDeviceStats({
      props: '[ro.board.platform]: [lahaina]',
      cpu: ['0.01', '---', '8', '###', 'Hardware\t: Tesla'].join('\n'),
    })
    expect(withoutSoc.cpu.model).toBe('lahaina')
  })

  it('handles missing sections without throwing', () => {
    const stats = parseDeviceStats({}, undefined)
    expect(stats.model).toBeNull()
    expect(stats.sdk).toBeNull()
    expect(stats.memory).toBeNull()
    expect(stats.storage).toBeNull()
    expect(stats.battery).toEqual({ level: null, status: null, temperatureC: null, charging: false })
    expect(stats.network).toEqual({ ip: null, interface: null })
  })

  it('ignores non-ip and loopback-only candidates', () => {
    const stats = parseDeviceStats(
      { network: ['1: lo    inet 127.0.0.1/8 scope host lo'].join('\n') },
      'not-a-host',
    )
    expect(stats.network).toEqual({ ip: null, interface: null })
  })
})
