import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

const { deviceTransport, isUsbSerial, normalizeDisconnectSerial } =
  await import('../../electron/adb.js')

describe('USB / wireless transport classification', () => {
  it.each(['fb637d72', 'R58M1234567', '0123456789ABCDEF'])('treats %s as USB', (serial) => {
    expect(isUsbSerial(serial)).toBe(true)
    expect(deviceTransport(serial)).toBe('usb')
  })

  it.each(['192.168.1.20:5555', '[::1]:5555', 'adb-ABC123._adb-tls-connect._tcp', 'emulator-5554'])(
    'treats %s as wireless',
    (serial) => {
      expect(isUsbSerial(serial)).toBe(false)
      expect(deviceTransport(serial)).toBe('wifi')
    },
  )

  it.each([null, undefined, '', '   '])('rejects non-serial value %s', (value) => {
    expect(isUsbSerial(value)).toBe(false)
  })

  it('accepts USB serials in disconnect validation', () => {
    expect(normalizeDisconnectSerial(' fb637d72 ')).toBe('fb637d72')
  })
})
