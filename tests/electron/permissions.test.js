import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTrustedAccessibilityClient: vi.fn(),
  openExternal: vi.fn(),
  open: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: mocks.openExternal },
  systemPreferences: { isTrustedAccessibilityClient: mocks.isTrustedAccessibilityClient },
}))

vi.mock('node:fs', () => ({
  promises: { open: mocks.open },
}))

Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

const permissions = await import('../../electron/permissions.js')

describe('macOS permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('maps status and leaves local network unresolved', async () => {
    mocks.isTrustedAccessibilityClient.mockReturnValue(true)
    mocks.open.mockResolvedValue({ close: vi.fn().mockResolvedValue() })
    await expect(permissions.getPermissionStatus()).resolves.toEqual({
      localNetwork: 'unknown',
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
