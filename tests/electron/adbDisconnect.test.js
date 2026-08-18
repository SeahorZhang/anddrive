import { describe, expect, it } from 'vitest'
import {
  isAlreadyDisconnectedError,
  isMissingForwardError,
  normalizeDisconnectSerial,
} from '../../electron/adbDisconnect.js'

describe('disconnect validation and result classification', () => {
  it.each(['device:5555', '192.168.1.20:5555', '[::1]:5555'])('accepts serial %s', (serial) => {
    expect(normalizeDisconnectSerial(` ${serial} `)).toBe(serial)
  })

  it.each([null, undefined, '', '   ', 'device with spaces', 'x'.repeat(1025)])(
    'rejects invalid serial %s',
    (serial) => {
      expect(() => normalizeDisconnectSerial(serial)).toThrow('设备序列号无效')
    },
  )

  it.each([
    'error: no such device',
    'error: device 192.168.1.20:5555 not found',
    'error: device not connected',
  ])('recognizes an absent device response: %s', (message) => {
    expect(isAlreadyDisconnectedError(new Error(message))).toBe(true)
  })

  it('does not hide unrelated ADB errors', () => {
    expect(isAlreadyDisconnectedError(new Error('cannot connect to daemon'))).toBe(false)
    expect(isAlreadyDisconnectedError(new Error('permission denied'))).toBe(false)
  })

  it('recognizes missing forwards but not arbitrary failures', () => {
    expect(isMissingForwardError(new Error("listener 'tcp:18923' not found"))).toBe(true)
    expect(isMissingForwardError(new Error('transport error'))).toBe(false)
  })
})
