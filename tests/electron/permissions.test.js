import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const child = {
    stdout: { on: vi.fn((_event, callback) => (child.onStdout = callback)) },
    stderr: { on: vi.fn((_event, callback) => (child.onStderr = callback)) },
    once: vi.fn((event, callback) => {
      if (event === 'close') child.onClose = callback
    }),
    on: vi.fn(),
    kill: vi.fn(),
  }
  return {
    isTrustedAccessibilityClient: vi.fn(),
    openExternal: vi.fn(),
    open: vi.fn(),
    spawn: vi.fn(() => child),
    child,
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: mocks.openExternal },
  systemPreferences: { isTrustedAccessibilityClient: mocks.isTrustedAccessibilityClient },
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

vi.mock('node:fs', () => ({
  promises: { open: mocks.open },
}))

Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

const permissions = await import('../../electron/permissions.js')

describe('macOS permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.child.onStdout = undefined
    mocks.child.onStderr = undefined
    mocks.child.onClose = undefined
  })

  it('exposes the supported permission ids', () => {
    expect(permissions.PERMISSION_IDS).toEqual(['localNetwork', 'accessibility', 'fullDiskAccess'])
  })

  it('reports accessibility access from systemPreferences', () => {
    mocks.isTrustedAccessibilityClient.mockReturnValue(true)
    expect(permissions.hasAccessibilityAccess()).toBe(true)
    expect(mocks.isTrustedAccessibilityClient).toHaveBeenCalledWith(false)
  })

  it('probes full disk access by opening the TCC database', async () => {
    mocks.open.mockResolvedValue({ close: vi.fn().mockResolvedValue() })
    expect(await permissions.hasFullDiskAccess()).toBe(true)

    mocks.open.mockRejectedValue(new Error('EPERM'))
    expect(await permissions.hasFullDiskAccess()).toBe(false)
  })

  it('probes local network access with a Bonjour browse', async () => {
    const result = permissions.probeLocalNetworkAccess()
    mocks.child.onClose(0)
    await expect(result).resolves.toBe('granted')
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/usr/bin/dns-sd',
      ['-B', '_services._dns-sd._udp'],
      expect.anything(),
    )
  })

  it('reports local network access as denied on kDNSServiceErr_PolicyDenied', async () => {
    const result = permissions.probeLocalNetworkAccess()
    mocks.child.onStdout('Error code -65570\n')
    await expect(result).resolves.toBe('denied')
  })

  it('maps status with the local network probe result', async () => {
    mocks.isTrustedAccessibilityClient.mockReturnValue(true)
    mocks.open.mockResolvedValue({ close: vi.fn().mockResolvedValue() })
    const result = permissions.getPermissionStatus()
    mocks.child.onClose(0)
    await expect(result).resolves.toEqual({
      localNetwork: 'granted',
      accessibility: 'granted',
      fullDiskAccess: 'granted',
    })
  })

  it('opens the matching settings pane', async () => {
    await permissions.openPermissionSettings('fullDiskAccess')
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    )
  })

  it('rejects unknown permission ids', async () => {
    await expect(permissions.openPermissionSettings('bogus')).rejects.toThrow('未知系统权限')
    await expect(permissions.requestPermission('bogus')).rejects.toThrow('未知系统权限')
  })
})
